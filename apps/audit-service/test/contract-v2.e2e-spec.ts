import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sampleAuditPayload } from '@nawara/audit-contract/testing';
import { kitMigrationsDir, runMigrations, type EventEnvelope } from '@nawara/service-kit';
import { auditMigrationsDir } from '../src/app.module.js';
import { IngestionService } from '../src/ingestion/ingestion.service.js';
import { AuditRecordRepository } from '../src/persistence/audit-record.repository.js';
import type { NewAuditRecord } from '../src/persistence/audit-record.types.js';
import { ALL_LOGS, createTestApp, type TestApp } from './support/app.js';
import { failure, sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * Core V2 S2-Audit.1 (ADR-0069 decisions 1, 2, 4 and 7; register AUD-01, AUD-02) on a real PostgreSQL 16, as the runtime role, through the
 * real module graph: migration 0006 (expand only), the version-2 facts, the stored delivery assessment, the trusted scope rows and their
 * database guards, idempotent duplicates, and version-1 compatibility.
 */
const COMPANY = '11111111-1111-4111-8111-111111111111';
const PLATFORM = '22222222-2222-4222-8222-222222222222';
const ORG = '7c1e2d3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5';
const origin = (eventId: string, name: string) =>
  ({ from: 'verified_delivery', source: 'auth-service', eventId, name, routingKey: name, producerUserId: 'auth-service' }) as never;

/** A record as ingestion would hand it over, for the repository-level tests (scope assertions no catalog entry allows yet). */
const record = (over: Partial<NewAuditRecord> = {}): NewAuditRecord => ({
  eventId: randomUUID(), sourceService: 'payment-service', action: 'payment.created', category: 'commercial', schemaVersion: 2,
  actor: { type: 'service', id: 'billing-service' }, organizationId: null, resource: { type: 'payment', id: randomUUID() }, outcome: 'succeeded',
  occurredAt: new Date('2026-10-25T10:00:00.000Z'), liveMode: true, ...over,
});

const envelopeV = (version: number, payload: Record<string, unknown> = {}): EventEnvelope => {
  const id = randomUUID();
  return {
    id, name: 'audit.membership.revoked',
    payload: { ...JSON.parse(JSON.stringify(sampleAuditPayload('membership.revoked', 'complete'))), ...payload },
    headers: { eventId: id, occurredAt: '2026-10-25T10:00:00.000Z', correlationId: 'corr-v2-0001', source: 'auth-service', version } as EventEnvelope['headers'],
  };
};

describeWithEnv('S2-Audit.1 audit contract version 2 and trusted scope (real PostgreSQL 16)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  let repo: AuditRecordRepository;
  let ingestion: IngestionService;
  const scopeRows = async (recordId: string) => sql(d.adminUrl, `SELECT basis, "companyId", "platformId" FROM audit_record_scope WHERE "recordId" = $1`, [recordId]);

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'av2');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    t = await createTestApp({ databaseUrl: d.appUrl });
    repo = t.app.get(AuditRecordRepository);
    ingestion = t.app.get(IngestionService);
  });
  afterAll(async () => {
    await t?.app.close();
    await d?.drop();
  });

  describe('migration 0006', () => {
    it('upgrades a populated 0005 database without changing any stored row; the new columns are NULL for history; a re-run is a no-op', async () => {
      // a populated 0005 database: the audit migrations up to 0005 (a copy of the directory), rows written, then the real directory
      const tmp = mkdtempSync(join(tmpdir(), 'av2-'));
      const db = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'av2p');
      try {
        for (const f of readdirSync(auditMigrationsDir)) if (f.endsWith('.sql') && f < '0006') copyFileSync(join(auditMigrationsDir, f), join(tmp, f));
        expect((await runMigrations(db.migratorUrl, [kitMigrationsDir, tmp])).applied.at(-1)).toBe('0005_event_provenance.sql');
        await sql(db.migratorUrl, `INSERT INTO audit_record ("eventId","sourceService",action,category,"schemaVersion","actorType","actorId","organizationId","resourceType","resourceId",outcome,"occurredAt")
          SELECT gen_random_uuid(),'organization-service','membership.revoked','business',1,'service','x-service',$1,'membership',gen_random_uuid()::text,'succeeded',now() FROM generate_series(1,20)`, [ORG]);
        const digest = async () => (await sql<{ h: string }>(db.adminUrl, `SELECT md5(string_agg(row_to_json(r)::text, ',' ORDER BY id)) AS h FROM (SELECT id, "eventId", "sourceService", action, category, "schemaVersion", "actorType", "actorId", "userKind", "organizationId", "resourceType", "resourceId", "subjectType", "subjectId", outcome, changes, "correlationId", "causationId", "occurredAt", "recordedAt" FROM audit_record) r`))[0]!.h;
        const h0 = await digest();
        expect((await runMigrations(db.migratorUrl, [kitMigrationsDir, auditMigrationsDir])).applied).toEqual(['0006_audit_contract_v2.sql', '0007_audit_approved_by.sql']);
        expect(await digest()).toBe(h0);
        const nulls = await sql<{ n: string }>(db.adminUrl, `SELECT count(*) AS n FROM audit_record WHERE "companyId" IS NOT NULL OR "platformId" IS NOT NULL OR "liveMode" IS NOT NULL OR "producerIdentityVerified" IS NOT NULL OR replayed IS NOT NULL`);
        expect(nulls[0]!.n).toBe('0');
        expect((await runMigrations(db.migratorUrl, [kitMigrationsDir, auditMigrationsDir])).applied).toEqual([]);
      } finally {
        await db.drop();
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('the runtime role holds only INSERT and SELECT on audit_record_scope; nothing else may change it', async () => {
      const grants = await sql<{ p: string }>(d.adminUrl, `SELECT privilege_type AS p FROM information_schema.role_table_grants WHERE table_name = 'audit_record_scope' AND grantee = $1 ORDER BY 1`, [d.app]);
      expect(grants.map((g) => g.p)).toEqual(['INSERT', 'SELECT']);
      const r = await repo.insertOnce(record({ companyId: COMPANY, delivery: { producerIdentityVerified: true, replayed: false } }));
      const id = (r as { record: { id: string } }).record.id;
      for (const stmt of [`UPDATE audit_record_scope SET "companyId" = NULL WHERE "recordId" = ${id}`, `DELETE FROM audit_record_scope WHERE "recordId" = ${id}`, 'TRUNCATE audit_record_scope']) {
        expect((await failure(d.appUrl, stmt)).code, stmt).toBe('42501'); // the runtime: no privilege
        expect((await failure(d.migratorUrl, stmt)).message, stmt).toMatch(/append-only/); // the owner: the trigger
      }
      expect(await scopeRows(id)).toHaveLength(1);
    });
  });

  describe('trusted scope rows (ADR-0069 decision 4)', () => {
    it('a verified record asserting a Company / Platform gets exactly one scope row, written with it; an unverified one gets none', async () => {
      const v = await repo.insertOnce(record({ companyId: COMPANY, platformId: PLATFORM, delivery: { producerIdentityVerified: true, replayed: false } }));
      expect(v.kind).toBe('inserted');
      const vid = (v as { record: { id: string } }).record.id;
      expect(await scopeRows(vid)).toEqual([{ basis: 'verified_producer', companyId: COMPANY, platformId: PLATFORM }]);
      for (const delivery of [{ producerIdentityVerified: false, replayed: false }, null]) {
        const u = await repo.insertOnce(record({ companyId: COMPANY, delivery }));
        const uid = (u as { record: { id: string; companyId: string } }).record;
        expect(uid.companyId).toBe(COMPANY); // stored as asserted ...
        expect(await scopeRows(uid.id)).toEqual([]); // ... but never trusted scope
      }
      const noScope = await repo.insertOnce(record({ delivery: { producerIdentityVerified: true, replayed: false } }));
      expect(await scopeRows((noScope as { record: { id: string } }).record.id)).toEqual([]);
    });

    it('the database refuses any other scope row, for the runtime and for the owner: no retroactive, unverified or different scope', async () => {
      const verified = (await repo.insertOnce(record({ companyId: COMPANY, delivery: { producerIdentityVerified: true, replayed: false } })) as { record: { id: string } }).record.id;
      const unverified = (await repo.insertOnce(record({ companyId: COMPANY, delivery: { producerIdentityVerified: false, replayed: false } })) as { record: { id: string } }).record.id;
      const ins = (id: string, c: string | null, p: string | null) => `INSERT INTO audit_record_scope ("recordId", basis, "companyId", "platformId") VALUES (${id}, 'verified_producer', ${c ? `'${c}'` : 'NULL'}, ${p ? `'${p}'` : 'NULL'})`;
      for (const url of [d.appUrl, d.migratorUrl]) {
        expect((await failure(url, ins(unverified, COMPANY, null))).code).toBe('23514'); // an unverified record
        expect((await failure(url, ins(verified, PLATFORM, null))).code).toBe('23514'); // another Company than asserted
        expect((await failure(url, ins(verified, COMPANY, PLATFORM))).code).toBe('23514'); // a Platform never asserted
        expect((await failure(url, ins('999999999', COMPANY, null))).code).toBe('23514'); // no such record
      }
      // a later transaction cannot add trust to an existing verified record either (the row exists already, and it is not its transaction)
      const fresh = (await repo.insertOnce(record({ companyId: COMPANY, platformId: PLATFORM, delivery: { producerIdentityVerified: false, replayed: false } })) as { record: { id: string } }).record.id;
      await sql(d.adminUrl, `ALTER TABLE audit_record DISABLE TRIGGER audit_record_no_update_delete`); // simulate a later "verification" ...
      try {
        await sql(d.adminUrl, `UPDATE audit_record SET "producerIdentityVerified" = true WHERE id = $1`, [fresh]);
      } finally {
        await sql(d.adminUrl, `ALTER TABLE audit_record ENABLE TRIGGER audit_record_no_update_delete`);
      }
      expect((await failure(d.appUrl, ins(fresh, COMPANY, PLATFORM))).code).toBe('23514'); // ... still refused: not the storing transaction
      expect((await failure(d.appUrl, `INSERT INTO audit_record_scope ("recordId", basis, "companyId") VALUES (${verified}, 'organization_reference', '${COMPANY}')`)).code).toBe('23514');
    });

    it('duplicates are deterministic: concurrent deliveries of one event store one record and at most one scope row; a conflicting duplicate changes nothing', async () => {
      const r = record({ companyId: COMPANY, delivery: { producerIdentityVerified: true, replayed: false } });
      const out = await Promise.all(Array.from({ length: 8 }, () => repo.insertOnce(r)));
      expect(out.filter((o) => o.kind === 'inserted')).toHaveLength(1);
      const id = (out.find((o) => o.kind === 'inserted') as { record: { id: string } }).record.id;
      expect(await scopeRows(id)).toHaveLength(1);
      const other = await repo.insertOnce({ ...r, companyId: PLATFORM, delivery: { producerIdentityVerified: true, replayed: true } });
      expect(other.kind).toBe('duplicate');
      expect(await scopeRows(id)).toEqual([{ basis: 'verified_producer', companyId: COMPANY, platformId: null }]);
    });
  });

  describe('database invariants of the version-2 columns', () => {
    it('a version-1 record cannot carry a version-2 fact; one id cannot name two scope levels; replayed needs an assessment', async () => {
      const bad: Array<[Partial<NewAuditRecord>, string]> = [
        [{ schemaVersion: 1, companyId: COMPANY, liveMode: null }, 'audit_record_v2_fields_need_v2'],
        [{ schemaVersion: 1, liveMode: false }, 'audit_record_v2_fields_need_v2'],
        [{ companyId: COMPANY, platformId: COMPANY }, 'audit_record_scope_levels_distinct'],
        [{ organizationId: COMPANY, companyId: COMPANY }, 'audit_record_scope_levels_distinct'],
      ];
      for (const [over, constraint] of bad) {
        await expect(repo.insertOnce(record(over)), constraint).rejects.toThrow(/invalid_record/);
      }
      const e = await failure(d.appUrl, `INSERT INTO audit_record ("eventId","sourceService",action,category,"schemaVersion","actorType","actorId","resourceType","resourceId",outcome,"occurredAt",replayed)
        VALUES (gen_random_uuid(),'payment-service','payment.created','commercial',2,'service','billing-service','payment','p1','succeeded',now(),true)`);
      expect(e.constraint).toBe('audit_record_replayed_needs_assessment');
      // only Company with no Platform and no Organization is fine (NULLs are not "the same id")
      expect((await repo.insertOnce(record({ companyId: COMPANY }))).kind).toBe('inserted');
    });

    it('stored delivery facts never change: the record stays append-only', async () => {
      const id = (await repo.insertOnce(record({ delivery: { producerIdentityVerified: false, replayed: false } })) as { record: { id: string } }).record.id;
      expect((await failure(d.appUrl, `UPDATE audit_record SET "producerIdentityVerified" = true WHERE id = ${id}`)).code).toBe('42501');
      expect((await failure(d.migratorUrl, `UPDATE audit_record SET "producerIdentityVerified" = true WHERE id = ${id}`)).message).toMatch(/append-only/);
    });
  });

  describe('ingestion end to end (the real IngestionService, as the runtime role)', () => {
    it('a version-2 event: liveMode and the delivery facts from the trust decision are stored; no scope row (no action allows scope yet)', async () => {
      const e = envelopeV(2, { liveMode: true });
      expect(await ingestion.ingest(e, { decision: 'accept', basis: 'verified_original', origin: origin(e.id, e.name) } as never)).toBe('persisted');
      const row = await repo.findBySourceAndEventId('auth-service', e.id);
      expect(row).toMatchObject({ schemaVersion: 2, liveMode: true, producerIdentityVerified: true, replayed: false, companyId: null, platformId: null });
      expect(await scopeRows(row!.id)).toEqual([]);
    });

    it('forged scope, a version-1 event with version-2 fields and an unsupported version are refused before anything is stored', async () => {
      const before = Number((await sql<{ n: string }>(d.adminUrl, 'SELECT count(*) AS n FROM audit_record'))[0]!.n);
      const reason = async (p: Promise<unknown>) => p.then(() => 'stored', (x: { reason?: string }) => x.reason);
      const trusted = (e: EventEnvelope) => ({ decision: 'accept', basis: 'verified_original', origin: origin(e.id, e.name) }) as never;
      const forged = envelopeV(2, { companyId: COMPANY });
      expect(await reason(ingestion.ingest(forged, trusted(forged)))).toBe('invalid_scope');
      const v1 = envelopeV(1, { liveMode: true });
      expect(await reason(ingestion.ingest(v1, trusted(v1)))).toBe('unknown_field');
      const v3 = envelopeV(3);
      expect(await reason(ingestion.ingest(v3, trusted(v3)))).toBe('unsupported_version');
      expect(Number((await sql<{ n: string }>(d.adminUrl, 'SELECT count(*) AS n FROM audit_record'))[0]!.n)).toBe(before);
    });

    it('version-1 compatibility: a version-1 event is stored exactly as before, with NULL version-2 facts; an unverified compatibility delivery says so', async () => {
      const e = envelopeV(1);
      expect(await ingestion.ingest(e, { decision: 'compatibility', basis: 'unverified_original', verified: false } as never)).toBe('persisted');
      expect(await repo.findBySourceAndEventId('auth-service', e.id)).toMatchObject({
        schemaVersion: 1, companyId: null, platformId: null, liveMode: null, producerIdentityVerified: false, replayed: false,
      });
      const old = envelopeV(1);
      expect(await ingestion.ingest(old)).toBe('persisted'); // no decision (the pre-S1e path): not assessed
      expect(await repo.findBySourceAndEventId('auth-service', old.id)).toMatchObject({ producerIdentityVerified: null, replayed: null });
      expect(await ingestion.ingest(old)).toBe('duplicate');
    });

    it('no identifier or payload value of these events reaches a log line', async () => {
      const e = envelopeV(2, { liveMode: false });
      await ingestion.ingest(e, { decision: 'accept', basis: 'verified_original', origin: origin(e.id, e.name) } as never);
      const p = e.payload as { actor: { id: string }; resource: { id: string }; organizationId: string };
      const text = JSON.stringify(ALL_LOGS);
      for (const v of [p.actor.id, p.resource.id, p.organizationId, COMPANY]) expect(text).not.toContain(v);
      expect(createHash('sha256').update(text).digest('hex')).toMatch(/^[0-9a-f]{64}$/); // logs exist and were scanned
    });
  });

  describe('S2-Audit.2: the authorization receipt actions (ingestion as the runtime role)', () => {
    const OWNER_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
    const receiptEnvelope = (action: 'issued' | 'consumed' | 'voided', over: Record<string, unknown> = {}, headers: Record<string, unknown> = {}): EventEnvelope => {
      const id = randomUUID();
      const actor = action === 'issued' ? { type: 'user', id: OWNER_ID, userKind: 'owner' } : action === 'consumed' ? { type: 'service', id: 'payment-service' }
        : { type: 'system', id: 'authorization_receipt_replay' };
      return {
        id, name: `audit.authorization_receipt.${action}`,
        payload: {
          action: `authorization_receipt.${action}`, actor, organizationId: null, resource: { type: 'authorization_receipt', id: randomUUID() }, outcome: 'succeeded',
          companyId: COMPANY, ...(action === 'consumed' ? { approvedBy: { type: 'user', id: OWNER_ID, userKind: 'owner' } } : {}), ...over,
        },
        headers: { eventId: id, occurredAt: '2026-10-25T10:00:00.000Z', correlationId: 'corr-rcpt-0001', source: 'auth-service', version: 2, ...headers } as EventEnvelope['headers'],
      };
    };
    const verified = (e: EventEnvelope) => ({ decision: 'accept', basis: 'verified_original', origin: origin(e.id, e.name) }) as never;
    const unverified = { decision: 'compatibility', basis: 'unverified_original', verified: false } as never;
    const reason = async (p: Promise<unknown>) => p.then(() => 'stored', (x: { reason?: string }) => x.reason);

    it('a verified event of each action is stored with its Company and gets exactly one trusted scope row (Company only)', async () => {
      for (const a of ['issued', 'consumed', 'voided'] as const) {
        const e = receiptEnvelope(a);
        expect(await ingestion.ingest(e, verified(e))).toBe('persisted');
        const row = (await repo.findBySourceAndEventId('auth-service', e.id))!;
        expect(row).toMatchObject({ schemaVersion: 2, category: 'security', companyId: COMPANY, platformId: null, producerIdentityVerified: true });
        expect(await scopeRows(row.id), a).toEqual([{ basis: 'verified_producer', companyId: COMPANY, platformId: null }]);
      }
    });

    it('.consumed stores the verified approver; the other two store none', async () => {
      const c = receiptEnvelope('consumed');
      await ingestion.ingest(c, verified(c));
      expect(await repo.findBySourceAndEventId('auth-service', c.id)).toMatchObject({ approvedByUserId: OWNER_ID, approvedByUserKind: 'owner', actorType: 'service', actorId: 'payment-service' });
      const i = receiptEnvelope('issued');
      await ingestion.ingest(i, verified(i));
      expect(await repo.findBySourceAndEventId('auth-service', i.id)).toMatchObject({ approvedByUserId: null, approvedByUserKind: null });
    });

    it('an unverified delivery (compatibility phase) is stored but NEVER becomes trusted scope', async () => {
      const e = receiptEnvelope('issued');
      expect(await ingestion.ingest(e, unverified)).toBe('persisted');
      const row = (await repo.findBySourceAndEventId('auth-service', e.id))!;
      expect([row.companyId, row.producerIdentityVerified]).toEqual([COMPANY, false]);
      expect(await scopeRows(row.id)).toEqual([]);
    });

    it('refused before anything is stored: another producer, a version-1 event, a Platform, a forged approver, an Owner-attributed void', async () => {
      const before = Number((await sql<{ n: string }>(d.adminUrl, 'SELECT count(*) AS n FROM audit_record'))[0]!.n);
      const cases: Array<[EventEnvelope, string]> = [
        [receiptEnvelope('issued', {}, { source: 'payment-service' }), 'producer_not_admitted'],
        [receiptEnvelope('issued', {}, { version: 1 }), 'unsupported_version'],
        [receiptEnvelope('consumed', { platformId: PLATFORM }), 'invalid_scope'],
        [receiptEnvelope('issued', { companyId: undefined }), 'invalid_scope'],
        [receiptEnvelope('issued', { approvedBy: { type: 'user', id: OWNER_ID, userKind: 'owner' } }), 'invalid_approval'],
        [receiptEnvelope('consumed', { approvedBy: { type: 'user', id: OWNER_ID, userKind: 'operator' } }), 'invalid_approval'],
        [receiptEnvelope('voided', { actor: { type: 'user', id: OWNER_ID, userKind: 'owner' } }), 'invalid_actor'],
        [receiptEnvelope('consumed', { secretDigest: 'a'.repeat(64) }), 'sensitive_field'],
      ];
      for (const [e, expected] of cases) {
        const payload = JSON.parse(JSON.stringify(e.payload)); // drops an `undefined` field, as the wire would
        expect(await reason(ingestion.ingest({ ...e, payload }, verified(e))), expected).toBe(expected);
      }
      expect(Number((await sql<{ n: string }>(d.adminUrl, 'SELECT count(*) AS n FROM audit_record'))[0]!.n)).toBe(before);
    });

    it('duplicate delivery is deterministic: the same event again is a duplicate with no second scope row; another approver is a conflict', async () => {
      const e = receiptEnvelope('consumed');
      expect(await ingestion.ingest(e, verified(e))).toBe('persisted');
      expect(await ingestion.ingest(e, { decision: 'accept', basis: 'verified_duplicate', origin: origin(e.id, e.name) } as never)).toBe('duplicate');
      const row = (await repo.findBySourceAndEventId('auth-service', e.id))!;
      expect(await scopeRows(row.id)).toHaveLength(1);
      const other = { ...e, payload: { ...(e.payload as object), approvedBy: { type: 'user', id: randomUUID(), userKind: 'owner' } } };
      expect(await reason(ingestion.ingest(other, verified(e)))).toBe('event_id_conflict');
      expect((await repo.findBySourceAndEventId('auth-service', e.id))!.approvedByUserId).toBe(OWNER_ID);
    });

    it('the approver columns are version-2 only and paired (database CHECK)', async () => {
      const e = await failure(d.appUrl, `INSERT INTO audit_record ("eventId","sourceService",action,category,"schemaVersion","actorType","actorId","resourceType","resourceId",outcome,"occurredAt","approvedByUserId","approvedByUserKind")
        VALUES (gen_random_uuid(),'auth-service','membership.revoked','business',1,'service','x-service','membership','m1','succeeded',now(),$1,'owner')`, [OWNER_ID]);
      expect(e.constraint).toBe('audit_record_approved_by_valid');
      const half = await failure(d.appUrl, `INSERT INTO audit_record ("eventId","sourceService",action,category,"schemaVersion","actorType","actorId","resourceType","resourceId",outcome,"occurredAt","approvedByUserId")
        VALUES (gen_random_uuid(),'auth-service','authorization_receipt.consumed','security',2,'service','payment-service','authorization_receipt','r1','succeeded',now(),$1)`, [OWNER_ID]);
      expect(half.constraint).toBe('audit_record_approved_by_valid');
    });
  });
});
