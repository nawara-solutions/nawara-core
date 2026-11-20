import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type ServiceTokenEntry } from '@nawara/service-kit';
import { auditMigrationsDir } from '../src/app.module.js';
import { DeadLetterObservationRepository } from '../src/diagnostics/dead-letter-observation.repository.js';
import type { NewCoverageFact, NewDeadLetterTransition } from '../src/diagnostics/dead-letter-observation.types.js';
import { createTestApp, type TestApp } from './support/app.js';
import { failure, sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * Core V2 DO-43a (the Owner's D43-2 to D43-5, D43-7; DEVELOPMENT AND SIMULATION DIAGNOSTICS ONLY) over a REAL PostgreSQL 16, as the runtime
 * role: migration 0009's append-only transition and coverage facts, and the service-token, header-only diagnostics read.
 */
type Caller = { name: string; token: string; entry: ServiceTokenEntry };
const caller = (name: string): Caller => {
  const { token, digest } = generateServiceToken();
  return { name, token, entry: { caller: name, digest } };
};
const DIAG = caller('dev-diagnostics');
const READER = caller('org-reader');
const POLICY = JSON.stringify({
  callers: {
    [DIAG.name]: { operations: ['read_dead_letter_diagnostics'], categories: ['business'] },
    [READER.name]: { operations: ['read_organization', 'read_platform'], categories: ['security', 'business', 'commercial', 'administrative'] },
  },
});
const QUEUE = 'audit-service.audit';

const transition = (over: Partial<NewDeadLetterTransition> = {}): NewDeadLetterTransition => ({
  attemptId: randomUUID(), transition: 'attempted', instanceId: randomUUID(), consumer: QUEUE, eventId: randomUUID(), eventName: 'audit.file.deleted',
  source: 'file-service', failure: 'permanent', reason: 'invalid_record', errorClass: 'PermanentEventFailure', retryCount: 0, replayCount: 0,
  redelivered: false, observedAt: new Date(), ...over,
});
const coverage = (instanceId: string, over: Partial<NewCoverageFact> = {}): NewCoverageFact => ({
  instanceId, kind: 'heartbeat', seq: 1, consumers: [QUEUE], observedTotal: 0, persistedTotal: 0, droppedOverflow: 0, droppedSink: 0, rejectedTotal: 0,
  buffered: 0, observedAt: new Date(), ...over,
});

describeWithEnv('DO-43a dead-letter observation storage and diagnostics read (real PostgreSQL 16)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  let off: TestApp;
  let repo: DeadLetterObservationRepository;
  const window = () => ({ from: new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), to: new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  const get = (path: string, who: Caller | undefined, query: Record<string, string>, app = t) => {
    const r = request(app.app.getHttpServer()).get(`/audit/diagnostics/dead-letter/${path}`).query(query);
    return who ? r.set('authorization', `Bearer ${who.token}`) : r;
  };

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'adlobs');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    t = await createTestApp({ databaseUrl: d.appUrl, tokens: [DIAG.entry, READER.entry], policy: POLICY, env: { AUDIT_DEAD_LETTER_OBSERVATION: 'enabled' } });
    off = await createTestApp({ databaseUrl: d.appUrl, tokens: [DIAG.entry, READER.entry], policy: POLICY });
    repo = t.app.get(DeadLetterObservationRepository);
  });
  afterAll(async () => {
    await t?.app.close();
    await off?.app.close();
    await d?.drop();
  });

  describe('schema: header-only, no tenant data, append-only for every role', () => {
    it('stores identifiers, codes, counters and times only: no payload, body, digest, actor or tenant column exists', async () => {
      const cols = async (table: string) => (await sql<{ column_name: string }>(d.adminUrl,
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [table])).map((c) => c.column_name);
      expect(await cols('audit_dead_letter_transition')).toEqual(['id', 'attemptId', 'transition', 'instanceId', 'consumer', 'eventId', 'eventName', 'source',
        'failure', 'reason', 'errorClass', 'retryCount', 'replayCount', 'redelivered', 'observedAt', 'recordedAt']);
      expect(await cols('audit_dead_letter_coverage')).toEqual(['id', 'instanceId', 'kind', 'seq', 'consumers', 'observedTotal', 'persistedTotal',
        'droppedOverflow', 'droppedSink', 'rejectedTotal', 'buffered', 'observedAt', 'recordedAt']);
    });

    it('UPDATE, DELETE and TRUNCATE are refused for the runtime role, the schema owner and the superuser', async () => {
      const a = transition();
      await repo.insertTransitions([a]);
      const instance = randomUUID();
      await repo.insertCoverage(coverage(instance, { kind: 'started', seq: 0 }));
      for (const url of [d.appUrl, d.migratorUrl, d.adminUrl]) {
        for (const [table, where] of [['audit_dead_letter_transition', `"attemptId" = '${a.attemptId}'`], ['audit_dead_letter_coverage', `"instanceId" = '${instance}'`]] as const) {
          expect((await failure(url, `UPDATE ${table} SET "recordedAt" = now() WHERE ${where}`)).code).toBe('42501');
          expect((await failure(url, `DELETE FROM ${table} WHERE ${where}`)).code).toBe('42501');
          expect((await failure(url, `TRUNCATE ${table}`)).code).toBe('42501');
        }
      }
      expect((await sql(d.adminUrl, `SELECT 1 FROM audit_dead_letter_transition WHERE "attemptId" = $1`, [a.attemptId])).length).toBe(1);
    });

    it('the runtime role has INSERT and SELECT only (no UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER privilege)', async () => {
      const rows = await sql<{ table_name: string; privilege_type: string }>(d.adminUrl,
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = $1 AND table_name LIKE 'audit_dead_letter_%' ORDER BY 1, 2`, [d.app]);
      expect(rows.map((r) => `${r.table_name}:${r.privilege_type}`)).toEqual([
        'audit_dead_letter_coverage:INSERT', 'audit_dead_letter_coverage:SELECT', 'audit_dead_letter_transition:INSERT', 'audit_dead_letter_transition:SELECT']);
    });
  });

  describe('transitions: one row per (physical transfer attempt, transition)', () => {
    it('a repeated identical row is idempotent; a second outcome or a re-labelled attempt is refused and counted, the rest of the batch kept', async () => {
      const a = transition();
      const confirmed = { ...a, transition: 'transfer_confirmed' as const };
      expect(await repo.insertTransitions([a, confirmed])).toEqual({ stored: 2, duplicate: 0, rejected: 0 });
      const other = transition();
      expect(await repo.insertTransitions([a, { ...a, transition: 'transfer_unconfirmed' }, { ...confirmed, eventId: randomUUID() }, other]))
        .toEqual({ stored: 1, duplicate: 1, rejected: 2 });
      const stored = await sql<{ transition: string }>(d.adminUrl, `SELECT transition FROM audit_dead_letter_transition WHERE "attemptId" = $1 ORDER BY transition`, [a.attemptId]);
      expect(stored.map((r) => r.transition)).toEqual(['attempted', 'transfer_confirmed']);
    });

    it('two physical transfers of the SAME event (replay, duplicate publication, crash redelivery) are two attempts, never collapsed', async () => {
      const eventId = randomUUID();
      const first = transition({ eventId });
      const second = transition({ eventId, replayCount: 1 });
      const third = transition({ eventId, redelivered: true });
      const rows = [first, second, third].flatMap((x) => [x, { ...x, transition: 'transfer_confirmed' as const }]);
      expect(await repo.insertTransitions(rows)).toEqual({ stored: 6, duplicate: 0, rejected: 0 });
      const n = await sql<{ n: number }>(d.adminUrl, `SELECT count(DISTINCT "attemptId")::int AS n FROM audit_dead_letter_transition WHERE "eventId" = $1 AND transition = 'transfer_confirmed'`, [eventId]);
      expect(n[0]!.n).toBe(3);
    });

    it('an outcome whose `attempted` row was lost is admitted (observations are best effort; readers never assume pairs)', async () => {
      expect(await repo.insertTransitions([transition({ transition: 'transfer_unconfirmed' })])).toEqual({ stored: 1, duplicate: 0, rejected: 0 });
    });

    it('malformed values are refused: an unknown transition or failure class, an unsafe token, a negative count', async () => {
      for (const bad of [{ transition: 'delivered' }, { failure: 'transient' }, { eventId: 'has space' }, { source: 'Billing' }, { errorClass: 'a b' }, { retryCount: -1 }, { reason: 'Bad Reason' }]) {
        expect(await repo.insertTransitions([transition(bad as Partial<NewDeadLetterTransition>)])).toEqual({ stored: 0, duplicate: 0, rejected: 1 });
      }
    });

    it('the database stamps recordedAt; a caller cannot choose it', async () => {
      const a = transition();
      await repo.insertTransitions([a]);
      const [row] = await sql<{ skew: number }>(d.adminUrl, `SELECT abs(extract(epoch FROM (now() - "recordedAt")))::float8 AS skew FROM audit_dead_letter_transition WHERE "attemptId" = $1`, [a.attemptId]);
      expect(row!.skew).toBeLessThan(60);
    });
  });

  describe('coverage: one forward sequence per process instance', () => {
    it('started once at seq 0, then strictly increasing seq with the same consumers and never-decreasing counters, nothing after stopped', async () => {
      const i = randomUUID();
      await repo.insertCoverage(coverage(i, { kind: 'started', seq: 0 }));
      await repo.insertCoverage(coverage(i, { seq: 1, observedTotal: 3, persistedTotal: 2, droppedSink: 1 }));
      const refused = async (f: NewCoverageFact) => {
        await expect(repo.insertCoverage(f)).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
      };
      await refused(coverage(i, { kind: 'started', seq: 0 })); // a second start
      await refused(coverage(i, { seq: 1, observedTotal: 3, persistedTotal: 2, droppedSink: 1 })); // seq not increasing
      await refused(coverage(i, { seq: 2, observedTotal: 0, persistedTotal: 2, droppedSink: 1 })); // a counter reset inside one instance
      await refused(coverage(i, { seq: 2, observedTotal: 3, persistedTotal: 2, droppedSink: 0 }));
      await refused(coverage(i, { seq: 2, consumers: [QUEUE, 'other.queue'], observedTotal: 3, persistedTotal: 2, droppedSink: 1 }));
      await refused(coverage(i, { kind: 'started', seq: 2 })); // a start that is not seq 0
      await repo.insertCoverage(coverage(i, { kind: 'stopped', seq: 2, observedTotal: 3, persistedTotal: 2, droppedSink: 1 }));
      await refused(coverage(i, { seq: 3, observedTotal: 3, persistedTotal: 2, droppedSink: 1 })); // after stopped
      await refused(coverage(randomUUID(), { seq: 1 })); // a heartbeat with no start
    });

    it('a restart is a NEW instance: its counters start again from zero without contradicting the previous instance', async () => {
      const before = randomUUID();
      const after = randomUUID();
      await repo.insertCoverage(coverage(before, { kind: 'started', seq: 0 }));
      await repo.insertCoverage(coverage(before, { seq: 1, observedTotal: 9, droppedOverflow: 4 }));
      await repo.insertCoverage(coverage(after, { kind: 'started', seq: 0 }));
      await repo.insertCoverage(coverage(after, { seq: 1, observedTotal: 1 }));
      const rows = await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM audit_dead_letter_coverage WHERE "instanceId" IN ($1, $2)`, [before, after]);
      expect(rows[0]!.n).toBe(4);
    });
  });

  describe('the diagnostics read (D43-4): service token only, header only, bounded', () => {
    it('is mounted only with AUDIT_DEAD_LETTER_OBSERVATION=enabled; without it the routes do not exist (404)', async () => {
      expect((await get('transitions', DIAG, window(), off)).status).toBe(404);
      expect((await get('coverage', DIAG, window(), off)).status).toBe(404);
    });

    it('needs a service token (401) and the read_dead_letter_diagnostics operation (403: read_platform never implies it)', async () => {
      for (const path of ['transitions', 'coverage']) {
        expect((await get(path, undefined, window())).status).toBe(401);
        expect((await get(path, undefined, window()).set('authorization', 'Bearer not-a-token')).status).toBe(401);
        const denied = await get(path, READER, window());
        expect(denied.status).toBe(403);
        expect(denied.body.code).toBe('operation_not_allowed');
        expect((await get(path, DIAG, window())).status).toBe(200);
      }
    });

    it('returns header columns only, oldest first, with the best-effort notice; never cached', async () => {
      const a = transition({ eventId: randomUUID() });
      await repo.insertTransitions([a, { ...a, transition: 'transfer_confirmed' }]);
      const r = await get('transitions', DIAG, { ...window(), eventId: a.eventId });
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.body.notice).toBe('best_effort_development_diagnostics');
      expect(r.body.items.map((x: { transition: string }) => x.transition).sort()).toEqual(['attempted', 'transfer_confirmed']);
      expect(Object.keys(r.body.items[0]).sort()).toEqual(['attemptId', 'consumer', 'errorClass', 'eventId', 'eventName', 'failure', 'instanceId', 'observedAt',
        'reason', 'recordedAt', 'redelivered', 'replayCount', 'retryCount', 'source', 'transition'].sort());
      const empty = await get('transitions', DIAG, { ...window(), eventId: randomUUID() });
      expect(empty.body).toEqual({ items: [], nextCursor: null, notice: 'best_effort_development_diagnostics' });
    });

    it('pages with a cursor bound to the exact query; a foreign, altered or reused-for-another-query cursor is refused', async () => {
      const i = randomUUID();
      await repo.insertCoverage(coverage(i, { kind: 'started', seq: 0 }));
      for (let s = 1; s <= 4; s++) await repo.insertCoverage(coverage(i, { seq: s }));
      const w = window();
      const seen: number[] = [];
      let cursor: string | null = null;
      do {
        const r = await get('coverage', DIAG, { ...w, instanceId: i, limit: '2', ...(cursor ? { cursor } : {}) });
        expect(r.status).toBe(200);
        seen.push(...r.body.items.map((x: { seq: number }) => x.seq));
        cursor = r.body.nextCursor;
      } while (cursor);
      expect(seen).toEqual([0, 1, 2, 3, 4]);
      const first = await get('coverage', DIAG, { ...w, instanceId: i, limit: '2' });
      expect((await get('coverage', DIAG, { ...w, instanceId: i, limit: '3', cursor: first.body.nextCursor })).body.code).toBe('invalid_cursor');
      expect((await get('coverage', DIAG, { ...w, instanceId: i, limit: '2', cursor: `${first.body.nextCursor}x` })).status).toBe(400);
      expect((await get('coverage', DIAG, { ...w, instanceId: i, limit: '2', cursor: 'not-a-cursor' })).body.code).toBe('invalid_cursor');
    });

    it('refuses a window over 24 hours, a limit over 100, an unknown or repeated parameter, a malformed filter and a body', async () => {
      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const wide = await get('transitions', DIAG, { from: iso(now - 25 * 3_600_000), to: iso(now) });
      expect([wide.status, wide.body.code]).toEqual([400, 'window_too_large']);
      expect((await get('transitions', DIAG, { from: iso(now - 24 * 3_600_000), to: iso(now) })).status).toBe(200);
      expect((await get('transitions', DIAG, { ...window(), limit: '101' })).status).toBe(400);
      expect((await get('transitions', DIAG, { ...window(), limit: '100' })).status).toBe(200);
      expect((await get('transitions', DIAG, { ...window(), organizationId: randomUUID() })).status).toBe(400);
      expect((await get('coverage', DIAG, { ...window(), eventId: randomUUID() })).status).toBe(400);
      expect((await get('transitions', DIAG, { ...window(), attemptId: 'nope' })).status).toBe(400);
      expect((await get('coverage', DIAG, { ...window(), instanceId: 'nope' })).status).toBe(400);
      expect((await request(t.app.getHttpServer()).get('/audit/diagnostics/dead-letter/transitions?from=a&from=b').set('authorization', `Bearer ${DIAG.token}`)).status).toBe(400);
      expect((await get('transitions', DIAG, {})).status).toBe(400);
      const body = await request(t.app.getHttpServer()).get('/audit/diagnostics/dead-letter/transitions').query(window())
        .set('authorization', `Bearer ${DIAG.token}`).set('content-type', 'application/json').send('{"a":1}');
      expect([body.status, body.body.code]).toEqual([400, 'unexpected_body']);
    });

    it('reads no audit record: the diagnostics caller still cannot read any organization or platform record', async () => {
      expect((await request(t.app.getHttpServer()).get(`/audit/organizations/${randomUUID()}/records`).query({ from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' })
        .set('authorization', `Bearer ${DIAG.token}`)).status).toBe(403);
      expect((await request(t.app.getHttpServer()).get('/audit/platform/records').query({ from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' })
        .set('authorization', `Bearer ${DIAG.token}`)).status).toBe(403);
    });
  });
});
