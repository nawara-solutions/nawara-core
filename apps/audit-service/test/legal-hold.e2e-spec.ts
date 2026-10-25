import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService, generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { auditMigrationsDir } from '../src/app.module.js';
import { runRetention } from '../src/cli/retention-core.js';
import { ALL_LOGS, createTestApp, type TestApp } from './support/app.js';
import { failure, sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * Core V2 S2-Audit.4 (ADR-0069 decision 6; register AUD-05; OD-13 resolved, Owner decisions H1 to H7): legal holds, through the real module
 * graph as the runtime role, the real retention path as the retention role, on real PostgreSQL 16. Auth is a stub of `GET /auth/grants`
 * and `POST /auth/step-up/verify` with Auth's semantics: a proof is bound to its owner (bearer) and purpose and is consumed once.
 */
const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
type Grants = { userId: string; kind: 'owner' | 'operator' | 'member'; companyId: string | null; platformAssignments: string[]; organizationAdminMemberships: string[] };
const g = (kind: Grants['kind'], over: Partial<Grants> = {}): Grants => ({ userId: randomUUID(), kind, companyId: null, platformAssignments: [], organizationAdminMemberships: [], ...over });
const IDENTITIES: Record<string, Grants> = {
  'owner-a': g('owner', { companyId: COMPANY_A }),
  'owner-b': g('owner', { companyId: COMPANY_B }),
  operator: g('operator', { platformAssignments: [randomUUID()] }),
  member: g('member'),
};
const PLACE = 'audit.legal_hold.place';
const RELEASE = 'audit.legal_hold.release';

function stubAuth() {
  const state = { down: false, verifyDown: false, revoked: new Set<string>(), verifyCalls: 0 };
  const proofs = new Map<string, { bearer: string; purpose: string; used: boolean }>();
  const server: Server = createServer((req, res) => {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const who = state.revoked.has(token) ? undefined : IDENTITIES[token];
    if (state.down) return send(500, { message: 'Internal Server Error' });
    if (!who) return send(401, { message: 'Unauthorized', code: 'unauthenticated' });
    if (req.method === 'GET' && req.url === '/auth/grants') return send(200, who);
    if (req.method === 'POST' && req.url === '/auth/step-up/verify') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        state.verifyCalls++;
        if (state.verifyDown) return send(500, { message: 'Internal Server Error' });
        const b = JSON.parse(raw) as { purpose: string; stepUpToken: string };
        const p = proofs.get(b.stepUpToken);
        if (!p || p.used || p.bearer !== token || p.purpose !== b.purpose) return send(403, { message: 'Forbidden', code: 'step_up_required' });
        p.used = true;
        return send(204);
      });
      return;
    }
    return send(404, { message: 'Not Found', code: 'not_found' });
  });
  /** A fresh proof, as Auth would issue it after TOTP / passkey (a secret-key proof for these purposes is refused by Auth at issuance). */
  const proof = (bearer: string, purpose: string) => {
    const id = randomUUID();
    proofs.set(id, { bearer, purpose, used: false });
    return id;
  };
  return { server, state, proof, proofs };
}

describeWithEnv('S2-Audit.4 legal holds (real PostgreSQL 16, real roles)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  let auth: ReturnType<typeof stubAuth>;
  const service = generateServiceToken();
  const pools: DbService[] = [];
  const db = (url: string) => {
    const p = new DbService({ url, applicationName: 'legal-hold-test', max: 2, statementTimeoutMs: 60_000 });
    pools.push(p);
    return p;
  };
  const place = (bearer: string | undefined, body: Record<string, unknown>) => {
    const r = request(t.app.getHttpServer()).post('/audit/owner/company/legal-holds').send(body);
    return bearer === undefined ? r : r.set('authorization', `Bearer ${bearer}`);
  };
  const release = (bearer: string, holdId: string, body: Record<string, unknown>) =>
    request(t.app.getHttpServer()).post(`/audit/owner/company/legal-holds/${holdId}/release`).set('authorization', `Bearer ${bearer}`).send(body);
  const placeOk = async (bearer: string, extra: Record<string, unknown> = {}) => {
    const r = await place(bearer, { stepUpToken: auth.proof(bearer, PLACE), reasonCode: 'litigation_pending', ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { holdId: string; companyId: string };
  };
  const holdEvents = (holdId: string) => sql<Record<string, any>>(d.adminUrl, `SELECT kind, "companyId", "reasonCode", "actorUserId" FROM audit_legal_hold_event WHERE "holdId" = $1 ORDER BY id`, [holdId]);
  const holdRecords = (holdId: string) => sql<Record<string, any>>(d.adminUrl, `SELECT action, "actorId", "userKind", changes FROM audit_record WHERE "resourceType" = 'audit_legal_hold' AND "resourceId" = $1 ORDER BY id`, [holdId]);

  /** Backdated security records (past a 1-day horizon), each with its trusted scope row when `company` is set; returns event ids. */
  const seed = async (n: number, o: { company?: string; verified?: boolean; ageDays?: number; occurredAgeDays?: number } = {}): Promise<string[]> => {
    const ids = Array.from({ length: n }, () => randomUUID());
    const verified = o.verified ?? true;
    await sql(d.adminUrl, `ALTER TABLE audit_record DISABLE TRIGGER audit_record_stamp`);
    try {
      for (const e of ids) {
        // one statement: the record and its scope row in the same transaction (the 0006 guard requires it)
        await sql(d.adminUrl,
          `WITH ins AS (
             INSERT INTO audit_record ("eventId","sourceService",action,category,"schemaVersion","actorType","actorId","userKind","resourceType","resourceId",outcome,
                                       "occurredAt","recordedAt","companyId","producerIdentityVerified",replayed)
             VALUES ($1,'auth-service','authorization_receipt.issued','security',2,'user',$2,'owner','authorization_receipt',gen_random_uuid()::text,'succeeded',
                     now() - make_interval(days => $3), now() - make_interval(days => $4), $5, $6, false)
             RETURNING id, "companyId")
           INSERT INTO audit_record_scope ("recordId", basis, "companyId") SELECT id, 'verified_producer', "companyId" FROM ins WHERE "companyId" IS NOT NULL AND $6`,
          [e, randomUUID(), o.occurredAgeDays ?? o.ageDays ?? 10, o.ageDays ?? 10, o.company ?? null, verified]);
      }
    } finally {
      await sql(d.adminUrl, `ALTER TABLE audit_record ENABLE TRIGGER audit_record_stamp`);
    }
    return ids;
  };
  const present = async (ids: string[]) => (await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM audit_record WHERE "eventId" = ANY($1::uuid[])`, [ids]))[0]!.n;
  const idOf = async (eventId: string) => (await sql<{ id: string }>(d.adminUrl, `SELECT id::text AS id FROM audit_record WHERE "eventId" = $1`, [eventId]))[0]!.id;
  const purge = () => runRetention(db(d.retentionUrl), { dryRun: false, batchSize: 1000, maxBatches: 100, category: 'security' });

  beforeAll(async () => {
    auth = stubAuth();
    await new Promise<void>((r) => auth.server.listen(0, '127.0.0.1', r));
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'ahold');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    await sql(d.migratorUrl, `SELECT audit_grant_retention($1::regrole)`, [d.retention]);
    t = await createTestApp({
      databaseUrl: d.appUrl, tokens: [{ caller: 'svc', digest: service.digest }],
      policy: JSON.stringify({ callers: { svc: { operations: ['read_platform'], categories: ['security'] } } }),
      env: { AUTH_SERVICE_URL: `http://127.0.0.1:${(auth.server.address() as AddressInfo).port}`, AUDIT_OWNER_QUERY_RATE_PER_OWNER: '100000' },
    });
  });
  afterAll(async () => {
    for (const p of pools) await p.onApplicationShutdown?.();
    await t?.app.close();
    await d?.drop();
    auth?.server.closeAllConnections();
    await new Promise((r) => auth?.server.close(r));
  });

  describe('placement and release (H1, H3, H4, H6)', () => {
    it('an Owner places a hold on their own Company (from Auth, not the body) and releases it; both are recorded, without the proof', async () => {
      const proof = auth.proof('owner-a', PLACE);
      const r = await place('owner-a', { stepUpToken: proof, reasonCode: 'litigation_pending', from: '2026-01-01T00:00:00Z', to: '2026-07-01T00:00:00Z' });
      expect(r.status).toBe(201);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.body).toMatchObject({ companyId: COMPANY_A, reasonCode: 'litigation_pending', from: '2026-01-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' });
      const holdId = r.body.holdId as string;
      const owner = IDENTITIES['owner-a']!.userId;
      expect(await holdEvents(holdId)).toEqual([{ kind: 'placed', companyId: COMPANY_A, reasonCode: 'litigation_pending', actorUserId: owner }]);
      const rel = await release('owner-a', holdId, { stepUpToken: auth.proof('owner-a', RELEASE), reasonCode: 'case_closed' });
      expect([rel.status, rel.body.holdId]).toEqual([200, holdId]);
      expect((await holdEvents(holdId)).map((e) => e.kind)).toEqual(['placed', 'released']);
      const recs = await holdRecords(holdId);
      expect(recs).toEqual([
        { action: 'audit_legal_hold.placed', actorId: owner, userKind: 'owner', changes: { company_id: COMPANY_A, reason_code: 'litigation_pending', window_from: '2026-01-01T00:00:00.000Z', window_to: '2026-07-01T00:00:00.000Z' } },
        { action: 'audit_legal_hold.released', actorId: owner, userKind: 'owner', changes: { company_id: COMPANY_A, reason_code: 'case_closed' } },
      ]);
      expect(JSON.stringify([recs, ALL_LOGS])).not.toContain(proof);
    });

    it('a Company cannot be chosen: a companyId or any other field in the body is refused; the window needs both bounds in order', async () => {
      for (const body of [{ companyId: COMPANY_B }, { platformId: randomUUID() }, { from: '2026-01-01T00:00:00Z' }, { from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
        { from: 'yesterday', to: '2026-01-01T00:00:00Z' }]) {
        const r = await place('owner-a', { stepUpToken: auth.proof('owner-a', PLACE), reasonCode: 'litigation_pending', ...body });
        expect([r.status, r.body.code], JSON.stringify(body)).toEqual([400, 'invalid_request']);
      }
      for (const reasonCode of [undefined, '', 'Free text reason', 'x'.repeat(65), 7]) {
        const r = await place('owner-a', { stepUpToken: auth.proof('owner-a', PLACE), reasonCode });
        expect(r.status, String(reasonCode)).toBe(400);
      }
    });

    it('operators, members, service tokens, unknown and revoked bearers are refused; nothing is stored', async () => {
      const before = (await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM audit_legal_hold_event`))[0]!.n;
      for (const who of ['operator', 'member']) {
        const r = await place(who, { stepUpToken: auth.proof(who, PLACE), reasonCode: 'litigation_pending' });
        expect([r.status, r.body.code], who).toEqual([403, 'operation_not_allowed']);
      }
      expect((await place(service.token, { stepUpToken: randomUUID(), reasonCode: 'x' })).status).toBe(401);
      expect((await place(undefined, { stepUpToken: randomUUID(), reasonCode: 'x' })).status).toBe(401);
      expect((await place('nobody', { stepUpToken: randomUUID(), reasonCode: 'x' })).status).toBe(401);
      auth.state.revoked.add('owner-b');
      try {
        expect((await place('owner-b', { stepUpToken: auth.proof('owner-b', PLACE), reasonCode: 'litigation_pending' })).status).toBe(401);
      } finally { auth.state.revoked.delete('owner-b'); }
      expect((await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM audit_legal_hold_event`))[0]!.n).toBe(before);
    });

    it('the step-up: missing, another purpose, another owner\'s, or reused is 403 step_up_required; each proof works once', async () => {
      expect((await place('owner-a', { reasonCode: 'litigation_pending' })).body.code).toBe('step_up_required');
      expect((await place('owner-a', { stepUpToken: 'not-a-proof', reasonCode: 'litigation_pending' })).body.code).toBe('step_up_required');
      expect((await place('owner-a', { stepUpToken: auth.proof('owner-a', RELEASE), reasonCode: 'litigation_pending' })).body.code).toBe('step_up_required');
      expect((await place('owner-a', { stepUpToken: auth.proof('owner-b', PLACE), reasonCode: 'litigation_pending' })).body.code).toBe('step_up_required');
      const once = auth.proof('owner-a', PLACE);
      expect((await place('owner-a', { stepUpToken: once, reasonCode: 'litigation_pending' })).status).toBe(201);
      expect((await place('owner-a', { stepUpToken: once, reasonCode: 'litigation_pending' })).body.code).toBe('step_up_required');
      const { holdId } = await placeOk('owner-a');
      const placeProof = auth.proof('owner-a', PLACE); // a place proof cannot release
      expect((await release('owner-a', holdId, { stepUpToken: placeProof, reasonCode: 'case_closed' })).body.code).toBe('step_up_required');
      expect(auth.proofs.get(placeProof)!.used).toBe(false); // Auth refused it for the other purpose: it was not spent
    });

    it('release: another Company\'s, unknown and already-released holds are the same 404, refused BEFORE the proof is spent', async () => {
      const { holdId } = await placeOk('owner-a');
      const calls = auth.state.verifyCalls;
      for (const [who, id] of [['owner-b', holdId], ['owner-a', randomUUID()], ['owner-a', 'not-a-uuid']] as const) {
        const proof = auth.proof(who, RELEASE);
        const r = await release(who, id, { stepUpToken: proof, reasonCode: 'case_closed' });
        expect([r.status, r.body.code], `${who} ${id}`).toEqual([404, 'not_found']);
        expect(JSON.stringify(r.body)).not.toContain(COMPANY_A);
        expect(auth.proofs.get(proof)!.used).toBe(false);
      }
      expect(auth.state.verifyCalls).toBe(calls);
      expect((await release('owner-a', holdId, { stepUpToken: auth.proof('owner-a', RELEASE), reasonCode: 'case_closed' })).status).toBe(200);
      expect((await release('owner-a', holdId, { stepUpToken: auth.proof('owner-a', RELEASE), reasonCode: 'case_closed' })).status).toBe(404);
      expect((await holdEvents(holdId)).map((e) => e.kind)).toEqual(['placed', 'released']);
    });

    it('two concurrent releases of one hold: exactly one succeeds', async () => {
      const { holdId } = await placeOk('owner-a');
      const out = await Promise.all([0, 1, 2].map(() => release('owner-a', holdId, { stepUpToken: auth.proof('owner-a', RELEASE), reasonCode: 'case_closed' })));
      expect(out.map((r) => r.status).sort((x, y) => x - y)).toEqual([200, 404, 404]);
      expect((await holdEvents(holdId)).filter((e) => e.kind === 'released')).toHaveLength(1);
      expect((await holdRecords(holdId)).filter((r) => r.action === 'audit_legal_hold.released')).toHaveLength(1);
    });

    it('Auth unavailable (grants or the proof\'s verification) fails closed with nothing stored', async () => {
      const count = async () => (await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM audit_legal_hold_event`))[0]!.n;
      const before = await count();
      auth.state.down = true;
      try {
        expect((await place('owner-a', { stepUpToken: auth.proof('owner-a', PLACE), reasonCode: 'litigation_pending' })).status).toBe(503);
      } finally { auth.state.down = false; }
      auth.state.verifyDown = true;
      try {
        expect((await place('owner-a', { stepUpToken: auth.proof('owner-a', PLACE), reasonCode: 'litigation_pending' })).status).toBe(503);
      } finally { auth.state.verifyDown = false; }
      expect(await count()).toBe(before);
    });

    it('the hold cannot be recorded after Auth consumed the proof: 503, nothing stored (no hold without its record), a fresh proof works', async () => {
      await sql(d.adminUrl, `CREATE FUNCTION test_fail_hold_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action LIKE 'audit_legal_hold.%' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$`);
      await sql(d.adminUrl, `CREATE TRIGGER test_fail_hold_record BEFORE INSERT ON audit_record FOR EACH ROW EXECUTE FUNCTION test_fail_hold_record()`);
      const proof = auth.proof('owner-a', PLACE);
      const before = (await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM audit_legal_hold_event`))[0]!.n;
      try {
        const r = await place('owner-a', { stepUpToken: proof, reasonCode: 'litigation_pending' });
        expect([r.status, r.body.code]).toEqual([503, 'accountability_unavailable']);
      } finally {
        await sql(d.adminUrl, `DROP TRIGGER test_fail_hold_record ON audit_record`);
        await sql(d.adminUrl, `DROP FUNCTION test_fail_hold_record()`);
      }
      expect(auth.proofs.get(proof)!.used).toBe(true); // spent at Auth
      expect((await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM audit_legal_hold_event`))[0]!.n).toBe(before);
      expect((await place('owner-a', { stepUpToken: proof, reasonCode: 'litigation_pending' })).body.code).toBe('step_up_required');
      await placeOk('owner-a');
    });
  });

  describe('retention and evidence preservation (decision 6, H7)', () => {
    it('held records are skipped by retention and refused by the trigger; unheld, other-Company and untrusted records are purged; release resumes it', async () => {
      await sql(d.migratorUrl, `INSERT INTO audit_retention_policy(category, "retainDays") VALUES ('security', 1) ON CONFLICT (category) DO UPDATE SET "retainDays" = 1`);
      const companyHeld = randomUUID();
      IDENTITIES['owner-h'] = g('owner', { companyId: companyHeld });
      const held = await seed(3, { company: companyHeld });
      const otherCompany = await seed(2, { company: randomUUID() });
      const untrusted = await seed(2, { company: companyHeld, verified: false }); // asserted, never trusted: not covered (H7)
      const unscoped = await seed(2);
      const { holdId } = await placeOk('owner-h');
      await purge();
      expect(await present(held)).toBe(3);
      expect(await present([...otherCompany, ...untrusted, ...unscoped])).toBe(0);
      // the retention role's direct DELETE of a held record: refused by the trigger, for the hold
      const f = await failure(d.retentionUrl, `DELETE FROM audit_record WHERE id = $1`, [await idOf(held[0]!)]);
      expect([f.code, f.message]).toEqual(['42501', expect.stringMatching(/under a legal hold/)]);
      // even the schema owner cannot delete it: the trigger applies to every role
      expect((await failure(d.migratorUrl, `DELETE FROM audit_record WHERE id = $1`, [await idOf(held[0]!)])).message).toMatch(/under a legal hold/);
      await release('owner-h', holdId, { stepUpToken: auth.proof('owner-h', RELEASE), reasonCode: 'case_closed' });
      await purge();
      expect(await present(held)).toBe(0);
    });

    it('a windowed hold covers only records whose occurrence is inside [from, to)', async () => {
      const company = randomUUID();
      IDENTITIES['owner-w'] = g('owner', { companyId: company });
      const inside = await seed(2, { company, ageDays: 10, occurredAgeDays: 20 });
      const outside = await seed(2, { company, ageDays: 10, occurredAgeDays: 400 });
      const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const to = new Date(Date.now() - 5 * 86_400_000).toISOString();
      await placeOk('owner-w', { from, to });
      await purge();
      expect([await present(inside), await present(outside)]).toEqual([2, 0]);
    });

    it('concurrency: a hold committed while a deletion waits is seen; a rolled-back release unlocks nothing', async () => {
      const company = randomUUID();
      const [rec] = await seed(1, { company });
      const recId = await idOf(rec!);
      const holder = new pg.Client({ connectionString: d.appUrl });
      const deleter = new pg.Client({ connectionString: d.retentionUrl });
      await holder.connect();
      await deleter.connect();
      try {
        // the placement holds the Company's lock exclusively and inserts the hold, not yet committed
        const holdId = randomUUID();
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(audit_legal_hold_lock_key($1::uuid))', [company]);
        await holder.query(`INSERT INTO audit_legal_hold_event ("holdId", kind, "companyId", "reasonCode", "actorUserId") VALUES ($1, 'placed', $2, 'litigation_pending', $3)`, [holdId, company, randomUUID()]);
        const del = deleter.query(`DELETE FROM audit_record WHERE id = $1`, [recId]).then(() => 'deleted', (e: { message: string }) => e.message);
        await new Promise((r) => setTimeout(r, 300));
        await holder.query('COMMIT'); // the waiting deletion now sees the committed hold
        expect(await del).toMatch(/under a legal hold/);
        expect(await present([rec!])).toBe(1);
        // a release that rolls back: the record stays held
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(audit_legal_hold_lock_key($1::uuid))', [company]);
        await holder.query(`INSERT INTO audit_legal_hold_event ("holdId", kind, "companyId", "reasonCode", "actorUserId") VALUES ($1, 'released', $2, 'case_closed', $3)`, [holdId, company, randomUUID()]);
        const del2 = deleter.query(`DELETE FROM audit_record WHERE id = $1`, [recId]).then(() => 'deleted', (e: { message: string }) => e.message);
        await new Promise((r) => setTimeout(r, 300));
        await holder.query('ROLLBACK');
        expect(await del2).toMatch(/under a legal hold/);
        expect(await present([rec!])).toBe(1);
      } finally {
        await holder.end();
        await deleter.end();
      }
    });
  });

  describe('database guarantees', () => {
    it('hold events are append-only for every role; a release needs its placement for the same Company; one of each per hold', async () => {
      const { holdId } = await placeOk('owner-a');
      for (const url of [d.appUrl, d.migratorUrl]) {
        for (const stmt of [`UPDATE audit_legal_hold_event SET "reasonCode" = 'x' WHERE "holdId" = '${holdId}'`, `DELETE FROM audit_legal_hold_event WHERE "holdId" = '${holdId}'`, 'TRUNCATE audit_legal_hold_event']) {
          const f = await failure(url, stmt);
          expect(f.code === '42501' && (url === d.appUrl || /append-only/.test(f.message)), `${url === d.appUrl ? 'app' : 'owner'} ${stmt}`).toBe(true);
        }
      }
      const ins = (kind: string, company: string, id = holdId) =>
        failure(d.appUrl, `INSERT INTO audit_legal_hold_event ("holdId", kind, "companyId", "reasonCode", "actorUserId") VALUES ($1, $2, $3, 'x', $4)`, [id, kind, company, randomUUID()]);
      expect((await ins('released', COMPANY_B)).code).toBe('23514'); // another Company
      expect((await ins('released', COMPANY_A, randomUUID())).code).toBe('23514'); // no placement
      expect((await ins('placed', COMPANY_A)).code).toBe('23505'); // a second placement of the same hold
      expect((await failure(d.appUrl, `INSERT INTO audit_legal_hold_event ("holdId", kind, "companyId", "reasonCode", "actorUserId", "windowFrom") VALUES ($1, 'placed', $2, 'x', $3, now())`, [randomUUID(), COMPANY_A, randomUUID()])).code).toBe('23514');
    });

    it('the runtime role cannot run the retention functions; the retention role cannot read holds or scope rows', async () => {
      expect((await failure(d.appUrl, `SELECT audit_record_is_held(1)`)).code).toBe('42501');
      expect((await failure(d.retentionUrl, `SELECT count(*) FROM audit_legal_hold_event`)).code).toBe('42501');
      expect((await failure(d.retentionUrl, `SELECT count(*) FROM audit_record_scope`)).code).toBe('42501');
    });
  });
});
