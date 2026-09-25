import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { APPS, PROHIBITED, deadDepth, resetAuditQueues, sql, startAudit, type LiveAudit } from './support/audit.js';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';

/**
 * Stage 18.7.4: REAL File (HTTP, its dist build, the filesystem store) → its outbox → its kit relay → a REAL RabbitMQ → a live
 * audit-service → audit_record: `file.deleted` from the delete route, and `file.integrity_incident` from a download that finds its
 * object gone (the object is removed behind the service's back, as tampering or loss would).
 */
const FILE_DIR = `${APPS}file-service`;
const FILE_PORT = 3877;
const AUDIT_PORT = 3878;
const FILE_URL = `http://127.0.0.1:${FILE_PORT}`;
/** The smallest PDF the type detector accepts. */
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(500, 0x20), Buffer.from('\n%%EOF\n')]);

describeWithEnv('File → outbox → RabbitMQ → audit-service (all real)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let fileDb: TestDatabase;
  let file: LiveService;
  let audit: LiveAudit;
  const root = mkdtempSync(join(tmpdir(), 's187-file-'));
  const owner = generateServiceToken();

  const upload = async (org: string) => {
    const r = await fetch(`${FILE_URL}/file/files`, {
      method: 'POST', body: PDF,
      headers: { authorization: `Bearer ${owner.token}`, 'x-organization-id': org, 'idempotency-key': crypto.randomUUID(), 'x-attach': 'true', 'content-type': 'application/pdf', 'x-file-name': 'Secret%20Name.pdf' },
    });
    const body = (await r.json()) as Record<string, any>;
    expect(r.status, JSON.stringify(body)).toBe(201);
    return body.id as string;
  };
  const send = (method: string, path: string, org: string) =>
    fetch(`${FILE_URL}${path}`, { method, headers: { authorization: `Bearer ${owner.token}`, 'x-organization-id': org, 'x-correlation-id': 'file-e2e-corr-01' } });

  /** The service's environment; the reconcile CLI runs with the same configuration (as an operator would). */
  const fileEnv = (): NodeJS.ProcessEnv => ({
    NODE_ENV: 'test', PORT: String(FILE_PORT), DATABASE_URL: fileDb.url, RABBITMQ_URL: env.TEST_RABBITMQ_URL,
    SERVICE_TOKENS: `test-owner:${owner.digest}`,
    FILE_SERVICE_POLICY: JSON.stringify({ callers: { 'test-owner': { operations: ['upload', 'read', 'delete'], organizations: 'request', mediaTypes: ['application/pdf'], maxBytes: 1_048_576 } } }),
    FILE_STORAGE_PROVIDER: 'filesystem', FILE_STORAGE_ROOT: root, FILE_PUBLIC_BASE_URL: 'http://files.e2e.invalid',
    FILE_REQUEST_HASH_KEY: Buffer.alloc(32, 7).toString('base64'), FILE_RATE_LIMIT_KEY: Buffer.alloc(32, 8).toString('base64'),
  });

  beforeAll(async () => {
    await resetAuditQueues(env.TEST_RABBITMQ_URL);
    audit = await startAudit(env.TEST_DATABASE_ADMIN_URL, env.TEST_RABBITMQ_URL, AUDIT_PORT);
    fileDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2efileaudit');
    await runMigrations(fileDb.url, [kitMigrationsDir, `${FILE_DIR}/db/migrations/`]);
    file = spawnService('file', FILE_DIR, fileEnv());
    try {
      await waitForHealth(`${FILE_URL}/health`, 30_000);
    } catch (e) {
      throw new Error(`${String(e)}\n${file.tail()}`);
    }
  });
  afterAll(async () => {
    await file?.stop();
    await audit?.stop();
    await fileDb?.drop();
    await audit?.db.drop();
    rmSync(root, { recursive: true, force: true });
  });

  it('file.deleted and file.integrity_incident reach audit_record with the owner service / detector and the file\'s organization; once each', async () => {
    const org = crypto.randomUUID();
    const doomed = await upload(org);
    const damaged = await upload(org);
    expect((await send('DELETE', `/file/files/${doomed}`, org)).status).toBe(202);
    expect((await send('DELETE', `/file/files/${doomed}`, org)).status).toBe(202); // idempotent: no second record
    const [{ storageKey }] = await sql<{ storageKey: string }>(fileDb.url, `SELECT "storageKey" FROM file WHERE id = $1`, [damaged]);
    unlinkSync(join(root, storageKey!));
    for (let i = 0; i < 3; i++) expect((await send('GET', `/file/files/${damaged}/content`, org)).status).toBe(500);

    await waitFor(async () => (await audit.records(`"sourceService" = 'file-service' AND "organizationId" = $1`, [org])).length === 2, 30_000, 'two file records');
    await new Promise((r) => setTimeout(r, 1000));
    const rows = await audit.records(`"sourceService" = 'file-service' AND "organizationId" = $1`, [org]);
    expect(rows).toHaveLength(2);
    const by = Object.fromEntries(rows.map((r) => [r.action, r]));
    expect(by['file.deleted']).toMatchObject({ category: 'business', actorType: 'service', actorId: 'test-owner', resourceType: 'file', resourceId: doomed, changes: null, correlationId: 'file-e2e-corr-01' });
    expect(by['file.integrity_incident']).toMatchObject({
      category: 'security', actorType: 'system', actorId: 'file_download_integrity_check', resourceId: damaged, changes: { reason: 'object_missing' }, correlationId: 'file-e2e-corr-01',
    });
    const payloads = await sql(fileDb.url, `SELECT payload FROM outbox`);
    expect(payloads).toHaveLength(2); // only audit intent: no File domain events
    for (const p of payloads) {
      for (const re of PROHIBITED) expect(JSON.stringify(p.payload)).not.toMatch(re);
      expect(JSON.stringify(p.payload)).not.toMatch(/Secret|files\/|\.pdf/);
    }
    expect(await deadDepth(env.TEST_RABBITMQ_URL)).toBe(0);
  });

  it('the reconcile CLI (a separate process) writes file.integrity_incident as file_reconciliation into the outbox; the running service publishes it', async () => {
    const org = crypto.randomUUID();
    const lost = await upload(org);
    const [{ storageKey }] = await sql<{ storageKey: string }>(fileDb.url, `SELECT "storageKey" FROM file WHERE id = $1`, [lost]);
    unlinkSync(join(root, storageKey!));
    const out = execFileSync('node', ['dist/cli/reconcile.js'], { cwd: FILE_DIR, env: { ...process.env, ...fileEnv() }, encoding: 'utf8' });
    expect(out).toContain(`"fileId":"${lost}","status":"AVAILABLE","finding":"object_missing"`);
    execFileSync('node', ['dist/cli/reconcile.js'], { cwd: FILE_DIR, env: { ...process.env, ...fileEnv() }, encoding: 'utf8' }); // a second run: same event id
    await waitFor(async () => (await audit.records(`"resourceId" = $1`, [lost])).length === 1, 30_000, 'the reconciliation record');
    await new Promise((r) => setTimeout(r, 1000));
    const rows = await audit.records(`"resourceId" = $1`, [lost]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'file.integrity_incident', actorType: 'system', actorId: 'file_reconciliation', organizationId: org, changes: { reason: 'object_missing' }, correlationId: null });
  });
});
