import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { MetricsHost } from '@nawara/service-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbService } from '../src/db/db.service.js';
import { freeze, retireWrites, unfreeze } from '../src/hierarchy/hierarchy-authority.js';
import { HierarchyAuthorityReadiness } from '../src/hierarchy/authority-readiness.js';
import { createTestApp, type TestCtx } from './helpers/app.js';

/**
 * A5.4-A5 (ADR-0063 §4 and its clarifications; the A5.4-A5 design §3 to §8; rulings R1 to R4): the `hierarchy_authority` readiness check
 * against a REAL PostgreSQL with the real migrations. Every state the schema can reach is reached here through the existing authority
 * commands or plain SQL in a throwaway database; the states it forbids (an unknown value, two rows) are unit-tested with doubles
 * (src/hierarchy/authority-readiness.spec.ts). Test ids T1 to T19 are the design's §8.1.
 */
const ORGANIZATION = {
  AUTH_HIERARCHY_SOURCE: 'organization-service',
  ORGANIZATION_SERVICE_URL: 'http://127.0.0.1:9', // never called by the check
  ORGANIZATION_SERVICE_TOKEN: 'readiness-test-token-0123456789abcdef',
};
const NOT_READY = (failed: string[]) => ({ status: 'unavailable', failed });

describe('A5.4-A5: the hierarchy_authority readiness check (real PostgreSQL)', () => {
  const open: TestCtx[] = [];
  const app = async (overrides: Record<string, string> = {}) => {
    const t = await createTestApp(overrides);
    open.push(t);
    return t;
  };
  afterEach(async () => {
    while (open.length) await open.pop()!.close();
    vi.restoreAllMocks();
  });

  const reasonLines = (t: TestCtx) => t.logger.lines.filter((l) => l.startsWith('hierarchy_authority_not_ready'));
  const registryLines = (t: TestCtx) => t.logger.lines.filter((l) => l.includes('check=hierarchy_authority'));
  const marker = async (t: TestCtx) =>
    (await t.db.query('SELECT mode, frozen_at, frozen_by, activation_evidence, retired_at, retired_by FROM hierarchy_authority')).rows;
  const events = async (t: TestCtx) => Number((await t.db.query('SELECT count(*)::int AS n FROM hierarchy_authority_event')).rows[0].n);
  const auth = (t: TestCtx) => t.app.get(DbService);
  const retireFresh = (t: TestCtx) => retireWrites(auth(t), 'readiness-test', 'organization-service activation event (test)', { fresh: true });

  it('T1: source local, marker local is ready, and the gauge reports the check up', async () => {
    const t = await app({ METRICS_ENABLED: 'true', METRICS_PORT: '0' });
    await t.http.get('/ready').expect(200, { status: 'ready' });
    const addr = await t.app.get(MetricsHost).address();
    const body = await (await fetch(`http://127.0.0.1:${addr!.port}/metrics`)).text();
    expect(body).toMatch(/^nawara_readiness_check_up\{check="hierarchy_authority"\} 1$/m);
    expect(reasonLines(t)).toEqual([]);
  });

  it('T2: source local, marker frozen is not ready with marker_frozen (R1)', async () => {
    const t = await app();
    await freeze(auth(t), 'readiness-test');
    await t.http.get('/ready').expect(503, NOT_READY(['hierarchy_authority']));
    expect(registryLines(t).some((l) => l.includes('readiness_check_failed check=hierarchy_authority error=HierarchyAuthorityNotReady code=marker_frozen'))).toBe(true);
    expect(reasonLines(t)).toEqual(['hierarchy_authority_not_ready reason=marker_frozen source=local marker=frozen HierarchyAuthorityReadiness']);
  });

  it('T3: source local, marker org_authoritative is not ready with marker_ahead_of_source', async () => {
    const t = await app();
    await retireFresh(t);
    await t.http.get('/ready').expect(503, NOT_READY(['hierarchy_authority']));
    expect(reasonLines(t)[0]).toContain('reason=marker_ahead_of_source source=local marker=org_authoritative');
  });

  it('T4: source organization-service, marker local is not ready with source_ahead_of_marker (the disagreement-window state)', async () => {
    const t = await app(ORGANIZATION);
    await t.http.get('/ready').expect(503, NOT_READY(['hierarchy_authority']));
    expect(reasonLines(t)[0]).toContain('reason=source_ahead_of_marker source=organization-service marker=local');
  });

  it('T5 and T11: source organization-service, marker frozen is marker_frozen, not source_ahead_of_marker (frozen before direction)', async () => {
    const t = await app(ORGANIZATION);
    await freeze(auth(t), 'readiness-test');
    await t.http.get('/ready').expect(503, NOT_READY(['hierarchy_authority']));
    expect(reasonLines(t)).toHaveLength(1);
    expect(reasonLines(t)[0]).toContain('reason=marker_frozen source=organization-service marker=frozen');
  });

  it('T6: source organization-service, marker org_authoritative is ready', async () => {
    const t = await app(ORGANIZATION);
    await retireFresh(t);
    await t.http.get('/ready').expect(200, { status: 'ready' });
  });

  it('T7: a missing marker row is marker_missing in both sources, never treated as local', async () => {
    for (const overrides of [{}, ORGANIZATION]) {
      const t = await app(overrides);
      await t.db.query('TRUNCATE hierarchy_authority'); // row triggers do not see TRUNCATE; a throwaway database
      await t.http.get('/ready').expect(503, NOT_READY(['hierarchy_authority']));
      expect(reasonLines(t)[0]).toContain('reason=marker_missing');
      expect(registryLines(t).some((l) => l.includes('code=marker_missing'))).toBe(true);
    }
  });

  it('T8a and T14: the database unreachable names database, hierarchy_authority and migrations; /auth/health is its usual 503', async () => {
    const t = await app({ DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' });
    await t.http.get('/ready').expect(503, NOT_READY(['database', 'hierarchy_authority', 'migrations']));
    await t.http.get('/auth/health').expect(503, { status: 'unavailable' });
    expect(registryLines(t).some((l) => l.includes('error=HierarchyAuthorityNotReady code=marker_unreadable'))).toBe(true);
    expect(reasonLines(t)[0]).toContain('reason=marker_unreadable');
  });

  it('T8b: the marker table absent is marker_unreadable (and only this check fails)', async () => {
    const t = await app();
    await t.db.query('ALTER TABLE hierarchy_authority RENAME TO hierarchy_authority_absent'); // a throwaway database
    await t.http.get('/ready').expect(503, NOT_READY(['hierarchy_authority']));
    expect(reasonLines(t)[0]).toContain('reason=marker_unreadable source=local marker=unreadable');
    expect(registryLines(t).some((l) => l.includes('readiness_check_failed check=hierarchy_authority error=HierarchyAuthorityNotReady code=marker_unreadable'))).toBe(true);
  });

  it('T8c: a role refused SELECT on the marker is marker_unreadable', async () => {
    const owner = await app();
    const url = new URL(owner.env.DATABASE_URL);
    const dbName = url.pathname.slice(1);
    const role = `ready_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const password = randomUUID();
    await owner.db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
    try {
      await owner.db.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${role}`);
      await owner.db.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await owner.db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
      await owner.db.query(`REVOKE SELECT ON hierarchy_authority FROM ${role}`);
      url.username = role;
      url.password = password;
      const t = await app({ DATABASE_URL: url.toString() });
      const r = await t.http.get('/ready');
      expect(r.status).toBe(503);
      expect(r.body.failed).toContain('hierarchy_authority');
      expect(r.body.failed).not.toContain('database');
      expect(reasonLines(t)[0]).toContain('reason=marker_unreadable');
      expect(registryLines(t).some((l) => l.includes('readiness_check_failed check=hierarchy_authority error=HierarchyAuthorityNotReady code=marker_unreadable'))).toBe(true);
      await t.close();
      open.splice(open.indexOf(t), 1);
    } finally {
      await owner.db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
      await owner.db.query(`REVOKE ALL ON SCHEMA public FROM ${role}`);
      await owner.db.query(`REVOKE ALL ON DATABASE ${dbName} FROM ${role}`);
      await owner.db.query(`DROP ROLE ${role}`);
    }
  });

  it('T9: a marker read that does not answer within the timeout fails as ReadinessCheckTimeout, then recovers', async () => {
    const t = await app();
    const locker = new pg.Client({ connectionString: t.env.DATABASE_URL });
    await locker.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE hierarchy_authority IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      await t.http.get('/ready').expect(503, NOT_READY(['hierarchy_authority']));
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(registryLines(t).some((l) => l.includes('readiness_check_failed check=hierarchy_authority error=ReadinessCheckTimeout'))).toBe(true);
      await locker.query('ROLLBACK');
    } finally {
      await locker.end();
    }
    await vi.waitFor(async () => {
      await t.http.get('/ready').expect(200, { status: 'ready' });
    }, { timeout: 10_000, interval: 200 });
    expect(registryLines(t).some((l) => l.includes('readiness_check_recovered check=hierarchy_authority'))).toBe(true);
  });

  it('T12: the reason line is written once per reason, again on a change of reason, and again after a ready result', async () => {
    const t = await app(ORGANIZATION);
    const db = auth(t);
    await t.http.get('/ready').expect(503);
    await t.http.get('/ready').expect(503);
    expect(reasonLines(t)).toHaveLength(1); // source_ahead_of_marker
    await freeze(db, 'readiness-test');
    await t.http.get('/ready').expect(503);
    await t.http.get('/ready').expect(503);
    expect(reasonLines(t)).toHaveLength(2); // marker_frozen
    await unfreeze(db, 'readiness-test');
    await t.http.get('/ready').expect(503);
    expect(reasonLines(t)).toHaveLength(3); // source_ahead_of_marker again: the reason changed
    expect(reasonLines(t).map((l) => l.split(' ')[1])).toEqual(['reason=source_ahead_of_marker', 'reason=marker_frozen', 'reason=source_ahead_of_marker']);
    expect(registryLines(t).filter((l) => l.includes('readiness_check_failed'))).toHaveLength(1); // the kit logs only the flip
  });

  it('T12 (after ready): the same reason after a ready result is logged again', async () => {
    const t = await app();
    await freeze(auth(t), 'readiness-test');
    await t.http.get('/ready').expect(503);
    await unfreeze(auth(t), 'readiness-test');
    await t.http.get('/ready').expect(200);
    expect(registryLines(t).some((l) => l.includes('readiness_check_recovered check=hierarchy_authority'))).toBe(true);
    await freeze(auth(t), 'readiness-test');
    await t.http.get('/ready').expect(503);
    expect(reasonLines(t)).toHaveLength(2);
  });

  it('T13: the source-first sequence: source_ahead_of_marker until hierarchy-retire --fresh, then ready, with no other reason', async () => {
    const t = await app(ORGANIZATION);
    await t.http.get('/ready').expect(503, NOT_READY(['hierarchy_authority']));
    await retireFresh(t);
    await t.http.get('/ready').expect(200, { status: 'ready' });
    expect(reasonLines(t).map((l) => l.split(' ')[1])).toEqual(['reason=source_ahead_of_marker']);
  });

  it('T14 and T15: in not-ready states /auth/health is byte-identical and Auth keeps serving', async () => {
    const states: Array<[Record<string, string>, ((t: TestCtx) => Promise<void>) | undefined]> = [
      [{}, (t) => freeze(auth(t), 'readiness-test')],
      [{}, retireFresh],
      [ORGANIZATION, undefined],
    ];
    for (const [overrides, setup] of states) {
      const t = await app(overrides);
      await setup?.(t);
      await t.http.get('/ready').expect(503);
      const health = await t.http.get('/auth/health');
      expect(health.status).toBe(200);
      expect(health.text).toBe('{"status":"ok"}');
      await t.http.get('/health').expect(200, { status: 'ok' });
      const login = await t.http.post('/auth/login').send({ email: 'nobody@example.org', password: 'not the password at all' });
      expect(login.status).toBe(401); // the ordinary answer of an ordinary route
    }
  });

  it('T16: no start-up dependency: the check is not run before the first /ready, and Auth starts with the database unreachable', async () => {
    const check = vi.spyOn(HierarchyAuthorityReadiness.prototype, 'check');
    const query = vi.spyOn(DbService.prototype, 'query');
    const t = await app();
    await t.http.get('/health').expect(200);
    await t.http.get('/auth/health').expect(200);
    expect(check).not.toHaveBeenCalled();
    // The only marker statement before the first /ready is the existing, un-awaited start-up report (hierarchy-reference.ts).
    await vi.waitFor(() => expect(query.mock.calls.filter((c) => String(c[0]).includes('hierarchy_authority')).length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 200));
    expect(query.mock.calls.filter((c) => String(c[0]).includes('hierarchy_authority'))).toHaveLength(1);
    await t.http.get('/ready').expect(200);
    expect(check).toHaveBeenCalledTimes(1);

    const down = await app({ DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' });
    await down.http.get('/health').expect(200, { status: 'ok' });
    expect((await down.http.get('/ready')).body.failed).toContain('hierarchy_authority');
  });

  it('T17: no mutation: across probes in every state the marker row and the event count are unchanged, and the check sends only its SELECT', async () => {
    const states: Array<[Record<string, string>, ((t: TestCtx) => Promise<void>) | undefined]> = [
      [{}, undefined],
      [{}, (t) => freeze(auth(t), 'readiness-test')],
      [{}, retireFresh],
      [ORGANIZATION, undefined],
      [ORGANIZATION, retireFresh],
    ];
    for (const [overrides, setup] of states) {
      const t = await app(overrides);
      await setup?.(t);
      const before = { marker: await marker(t), events: await events(t) };
      const query = vi.spyOn(auth(t), 'query');
      for (let i = 0; i < 5; i++) await t.http.get('/ready');
      const sent = query.mock.calls.map((c) => String(c[0]));
      query.mockRestore();
      expect(sent.filter((s) => /hierarchy_authority/.test(s))).toEqual(Array(5).fill('SELECT mode FROM hierarchy_authority'));
      expect(sent.filter((s) => /\b(INSERT|UPDATE|DELETE|SET|TRUNCATE|ALTER)\b/i.test(s))).toEqual([]);
      expect({ marker: await marker(t), events: await events(t) }).toEqual(before);
    }
  });

  it('T18: the 503 body is exactly {status, failed}; no reason, value, host or SQL text', async () => {
    const t = await app(ORGANIZATION);
    const r = await t.http.get('/ready').expect(503);
    expect(Object.keys(r.body).sort()).toEqual(['failed', 'status']);
    for (const leak of ['source_ahead_of_marker', 'organization-service', 'local', 'SELECT', '127.0.0.1', ORGANIZATION.ORGANIZATION_SERVICE_TOKEN]) {
      expect(r.text).not.toContain(leak);
    }
  });

  it('T19: the A2 golden trace fixture is byte-identical', () => {
    const fixture = readFileSync(join(import.meta.dirname, 'fixtures/hierarchy-ensure-trace.main.json'));
    expect(createHash('sha256').update(fixture).digest('hex')).toBe('ea7ab0749d8f4f8b462b49b6b7f2b074a459a46d0b0f230fa164dcde2ed5b394');
  });
});
