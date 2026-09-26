import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { InMemoryEventBus } from '@nawara/service-kit';
import { validateAuditPayload } from '@nawara/audit-contract';
import { MemberSecurityCounters, MemberSecurityReporter } from '../src/members/member-security.counters.js';
import { bearer, createTestApp, noReqId, type TestCtx, type Tokens } from './helpers/app.js';

type Owner = Awaited<ReturnType<TestCtx['readyOwner']>>;
type Member = { id: string; email: string; password: string };
const REASONS = ['compromised_account', 'security_incident', 'policy_violation'] as const;
/** What central audit must never carry: contact data, network data, secrets, free text. */
const PROHIBITED = [/@/, /203\.0\.113/, /password/i, /secret/i, /token/i, /eyJ[A-Za-z0-9_-]{10,}/, /totp/i];

/**
 * Stage 19.2 (ADR-0050 decision 5): an owner suspends / restores a MEMBER identity of the owner's Company, on a REAL PostgreSQL through
 * the REAL HTTP routes. Authority, the Company boundary (D5), the closed reason (D6), the operator gate (D7), step-up, idempotency,
 * concurrency, the live session effect, audit atomicity and actor spoofing.
 */
describe('Owner member security administration (Stage 19.2)', () => {
  let t: TestCtx;
  let bus: InMemoryEventBus;
  let w: Awaited<ReturnType<TestCtx['world']>>;
  let ownerA: Owner;
  let ownerB: Owner;
  let n = 0;
  const uniq = () => `${Date.now().toString(36)}${n++}`;

  const su = (purpose: string, o: Owner = ownerA) => t.stepUpToken(o.tokens, purpose, o.totpSecret);
  const suspend = async (id: string, body: Record<string, unknown> = { reason: 'compromised_account' }, o: Owner = ownerA, headers: Record<string, string> = {}) =>
    t.http.post(`/auth/admin/members/${id}/suspend`).set(bearer(o.tokens)).set('X-Step-Up-Token', await su('account.suspend', o)).set(headers).send(body);
  const restore = async (id: string, o: Owner = ownerA) =>
    t.http.post(`/auth/admin/members/${id}/restore`).set(bearer(o.tokens)).set('X-Step-Up-Token', await su('account.restore', o)).send({});
  const memberA = (status: 'active' | 'pending' = 'active', org?: string) => t.member(org ?? w.orgSchool1, `m${uniq()}@a.test`, undefined, 'student', status);
  const login = async (m: Member) => (await t.http.post('/auth/login').send({ email: m.email, password: m.password }).expect(200)).body as Tokens;
  const isActive = async (id: string) => (await t.db.query(`SELECT "isActive" FROM "user" WHERE id=$1`, [id])).rows[0].isActive as boolean;
  const central = async (action: string, id: string) =>
    (await t.db.query(`SELECT id, payload FROM outbox WHERE name=$1 AND payload->'resource'->>'id'=$2 ORDER BY "occurredAt", id`, [`audit.${action}`, id])).rows;
  const local = async (id: string) =>
    (await t.db.query(`SELECT type, outcome, "actorId", metadata FROM auth_audit_event WHERE "targetId"=$1 AND type IN ('account.disabled','account.enabled') ORDER BY id`, [id])).rows;
  const liveSessions = async (id: string) => (await t.db.query(`SELECT count(*)::int n FROM refresh_token WHERE "userId"=$1 AND "revokedAt" IS NULL`, [id])).rows[0].n as number;
  /** Asserts the status of an already-sent request and returns it (the helpers above are async: they obtain a fresh step-up first). */
  const st = <R extends { status: number; body: any }>(r: R, status: number): R => {
    expect(r.status, JSON.stringify(r.body)).toBe(status);
    return r;
  };
  const until = async (cond: () => Promise<boolean>, what: string) => {
    for (let i = 0; i < 100; i++) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out: ${what}`);
  };

  beforeAll(async () => {
    bus = new InMemoryEventBus();
    t = await createTestApp({}, { auditBus: bus });
    w = await t.world();
    ownerA = await t.readyOwner(w.companyA, 'owner-a@a.test');
    ownerB = await t.readyOwner(w.companyB, 'owner-b@b.test');
  });
  afterAll(async () => {
    await t?.close();
  });

  describe('suspension and restoration of an eligible member', () => {
    it('suspends: the identity is disabled, every session revoked, one local record and one central account.disabled with the reason', async () => {
      const m = await memberA();
      await login(m);
      await login(m);
      expect(await liveSessions(m.id)).toBe(2);
      const r = st(await suspend(m.id), 200);
      expect(r.body).toEqual({ id: m.id, suspended: true, changed: true }); // minimal: nothing else about the account
      expect(await isActive(m.id)).toBe(false);
      expect(await liveSessions(m.id)).toBe(0);
      const rows = await central('account.disabled', m.id);
      expect(rows).toHaveLength(1);
      const p = rows[0].payload;
      expect(() => validateAuditPayload(p, 'auth-service')).not.toThrow();
      expect(p).toMatchObject({
        action: 'account.disabled', actor: { type: 'user', id: ownerA.id, userKind: 'owner' }, organizationId: null,
        resource: { type: 'user', id: m.id }, outcome: 'succeeded', changes: { reason: 'compromised_account' },
      });
      for (const re of PROHIBITED) expect(JSON.stringify({ ...p, action: undefined }), String(re)).not.toMatch(re);
      expect(await local(m.id)).toEqual([{ type: 'account.disabled', outcome: 'success', actorId: ownerA.id, metadata: { kind: 'member', reason: 'compromised_account' } }]);
    });

    it('restores: enabled again, no reason, no session recreated; the member can log in again', async () => {
      const m = await memberA();
      st(await suspend(m.id, { reason: 'security_incident' }), 200);
      await t.http.post('/auth/login').send({ email: m.email, password: m.password }).expect(401);
      const r = st(await restore(m.id), 200);
      expect(r.body).toEqual({ id: m.id, suspended: false, changed: true });
      expect(await isActive(m.id)).toBe(true);
      expect(await liveSessions(m.id)).toBe(0);
      const rows = await central('account.enabled', m.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toMatchObject({ actor: { id: ownerA.id, userKind: 'owner' }, organizationId: null, resource: { type: 'user', id: m.id } });
      expect(rows[0].payload).not.toHaveProperty('changes');
      await login(m);
    });

    it('memberships in several organizations of the SAME Company are not cross-Company', async () => {
      const m = await memberA();
      await t.addMembership(m.id, w.orgSchool2);
      await t.addMembership(m.id, w.orgDrive, 'student', 'pending'); // Drive is also Company A
      st(await suspend(m.id), 200);
      expect(await isActive(m.id)).toBe(false);
    });

    it('state-idempotent: a repeated suspension or restoration succeeds, writes nothing and revokes nothing', async () => {
      const m = await memberA();
      st(await suspend(m.id), 200);
      expect((st(await suspend(m.id, { reason: 'policy_violation' }), 200)).body).toEqual({ id: m.id, suspended: true, changed: false });
      expect(await central('account.disabled', m.id)).toHaveLength(1);
      st(await restore(m.id), 200);
      expect((st(await restore(m.id), 200)).body).toEqual({ id: m.id, suspended: false, changed: false });
      expect(await central('account.enabled', m.id)).toHaveLength(1);
      expect((await local(m.id)).map((r) => r.type)).toEqual(['account.disabled', 'account.enabled']);
    });

    it('touches nothing else: memberships, their states and the admin flag are unchanged by suspend and restore', async () => {
      const m = await memberA();
      await t.addMembership(m.id, w.orgSchool2, 'teacher', 'pending');
      await t.db.query(`UPDATE organization_membership SET "isOrganizationAdmin"=true WHERE "userId"=$1 AND "organizationId"=$2`, [m.id, w.orgSchool1]);
      const snapshot = async () => (await t.db.query(`SELECT * FROM organization_membership WHERE "userId"=$1 ORDER BY id`, [m.id])).rows;
      const before = await snapshot();
      st(await suspend(m.id), 200);
      st(await restore(m.id), 200);
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('D5: the Company boundary is derived from persisted memberships only', () => {
    it('a member also ACTIVE under another Company is refused (404); nothing changes; the refusal is recorded locally only', async () => {
      const m = await memberA();
      await t.addMembership(m.id, w.orgClinic); // Clinic belongs to Company B
      const tokens = await login(m);
      const r = st(await suspend(m.id), 404);
      expect(await isActive(m.id)).toBe(true);
      await t.http.get('/auth/me').set(bearer(tokens)).expect(200);
      expect(await central('account.disabled', m.id)).toHaveLength(0);
      expect(await local(m.id)).toEqual([{ type: 'account.disabled', outcome: 'denied', actorId: ownerA.id, metadata: { kind: 'member', why: 'other_company' } }]);
      // indistinguishable from an unknown id
      const unknown = st(await suspend('00000000-0000-4000-8000-000000000000'), 404);
      expect(noReqId(r.body)).toEqual(noReqId(unknown.body));
    });

    it('a member PENDING under another Company is refused too (they are obtaining access there)', async () => {
      const m = await memberA();
      await t.addMembership(m.id, w.orgClinic, 'student', 'pending');
      st(await suspend(m.id), 404);
      expect(await isActive(m.id)).toBe(true);
    });

    it('a rejected or revoked membership under another Company does not block (no current or pending access there)', async () => {
      const m1 = await memberA();
      await t.addMembership(m1.id, w.orgClinic, 'student', 'rejected');
      st(await suspend(m1.id), 200);
      const m2 = await memberA();
      await t.addMembership(m2.id, w.orgClinic, 'student', 'revoked');
      st(await suspend(m2.id), 200);
    });

    it('restoration obeys the same boundary: a suspended member who gained a pending membership under another Company is not restored by this owner', async () => {
      const m = await memberA();
      st(await suspend(m.id), 200);
      await t.addMembership(m.id, w.orgClinic, 'student', 'pending');
      st(await restore(m.id), 404);
      expect(await isActive(m.id)).toBe(false);
    });

    it('another Company\'s member, a member with no membership in this Company, one with only a pending one, zero memberships, an operator, the owner: all 404', async () => {
      const b = await t.member(w.orgClinic, `b${uniq()}@b.test`);
      const pendingOnly = await memberA('pending');
      const none = await t.memberNoOrg(`z${uniq()}@a.test`);
      const op = await t.operator(w.companyA, `op${uniq()}@a.test`);
      for (const id of [b.id, pendingOnly.id, none.id, op.id, ownerA.id, ownerB.id]) {
        st(await suspend(id), 404);
        expect(await isActive(id), id).toBe(true);
      }
      // and Company B's owner cannot reach Company A's member
      const a = await memberA();
      st(await suspend(a.id, undefined, ownerB), 404);
      expect(await isActive(a.id)).toBe(true);
    });

    it('a concurrent membership INSERT under another Company is serialized with the suspension (row lock): it is seen, and the suspension is refused', async () => {
      const m = await memberA();
      const token = await su('account.suspend');
      const c = new pg.Client({ connectionString: t.env.DATABASE_URL });
      await c.connect();
      try {
        await c.query('BEGIN');
        // Uncommitted: the INSERT holds FOR KEY SHARE on the user row (foreign key), which the suspension's FOR UPDATE must wait for.
        await c.query(`INSERT INTO organization_membership("userId","organizationId",status,audience) VALUES ($1,$2,'pending','student')`, [m.id, w.orgClinic]);
        const pending = t.http.post(`/auth/admin/members/${m.id}/suspend`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', token).send({ reason: 'compromised_account' }).then((r) => r);
        await new Promise((r) => setTimeout(r, 300));
        await c.query('COMMIT');
        expect((await pending).status).toBe(404);
      } finally {
        await c.end();
      }
      expect(await isActive(m.id)).toBe(true);
    });
  });

  describe('authority: owner only, factor step-up, never an operator or a member', () => {
    it('an operator (even assigned to the platform) and a member (even an organization admin) are refused with 403', async () => {
      const m = await memberA();
      const op = await t.operator(w.companyA, `op${uniq()}@a.test`);
      await t.assign(op.id, w.platformSchool, ownerA.id, w.companyA);
      const opTokens = await t.operatorLogin(op.email);
      const admin = await memberA();
      await t.db.query(`UPDATE organization_membership SET "isOrganizationAdmin"=true WHERE "userId"=$1`, [admin.id]);
      const adminTokens = await login(admin);
      for (const tokens of [opTokens, adminTokens]) {
        await t.http.post(`/auth/admin/members/${m.id}/suspend`).set(bearer(tokens)).send({ reason: 'compromised_account' }).expect(403);
        await t.http.post(`/auth/admin/members/${m.id}/restore`).set(bearer(tokens)).send({}).expect(403);
      }
      await t.http.post(`/auth/admin/members/${m.id}/suspend`).send({ reason: 'compromised_account' }).expect(401);
      expect(await isActive(m.id)).toBe(true);
    });

    it('step-up: missing, malformed, wrong purpose, already used and the bare secret key are all refused; nothing changes', async () => {
      const m = await memberA();
      const url = `/auth/admin/members/${m.id}/suspend`;
      const body = { reason: 'compromised_account' };
      await t.http.post(url).set(bearer(ownerA.tokens)).send(body).expect(403);
      await t.http.post(url).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', 'not-a-uuid').send(body).expect(403);
      await t.http.post(url).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', await su('account.restore')).send(body).expect(403);
      await t.http.post(url).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', await su('operator.create')).send(body).expect(403);
      await t.http.post(`/auth/admin/members/${m.id}/restore`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', await su('account.suspend')).send({}).expect(403);
      // another owner's step-up is not this owner's
      await t.http.post(url).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', await su('account.suspend', ownerB)).send(body).expect(403);
      // the secret key can never satisfy these purposes (factor only)
      const sk = await t.stepUp(ownerA.tokens, 'account.suspend', ownerA.totpSecret, { method: 'secret_key', secretKey: 'x'.repeat(43), code: undefined });
      expect(sk.status).toBe(400);
      expect(sk.body.code).toBe('step_up_unsupported');
      expect(await isActive(m.id)).toBe(true);
      // single use
      const token = await su('account.suspend');
      await t.http.post(url).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', token).send(body).expect(200);
      await t.http.post(`/auth/admin/members/${m.id}/restore`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', token).send({}).expect(403);
    });

    it('a refused (ineligible) attempt does not burn the step-up: it rolls back with the transaction', async () => {
      const b = await t.member(w.orgClinic, `b${uniq()}@b.test`);
      const m = await memberA();
      const token = await su('account.suspend');
      await t.http.post(`/auth/admin/members/${b.id}/suspend`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', token).send({ reason: 'compromised_account' }).expect(404);
      await t.http.post(`/auth/admin/members/${m.id}/suspend`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', token).send({ reason: 'compromised_account' }).expect(200);
    });
  });

  describe('D6: the reason is a closed code, required on suspension', () => {
    it.each(REASONS)('%s is accepted and recorded', async (reason) => {
      const m = await memberA();
      st(await suspend(m.id, { reason }), 200);
      expect((await central('account.disabled', m.id))[0].payload.changes).toEqual({ reason });
    });

    it('owner_request, free text, an oversized value, a non-string, a missing reason and extra fields are refused with 400; nothing changes', async () => {
      const m = await memberA();
      for (const body of [{ reason: 'owner_request' }, { reason: 'he was rude to staff' }, { reason: 'x'.repeat(5000) }, { reason: 42 }, {}, { reason: 'compromised_account', note: 'free text' }]) {
        const r = await suspend(m.id, body as Record<string, unknown>);
        expect(r.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      }
      expect(await isActive(m.id)).toBe(true);
      expect(await central('account.disabled', m.id)).toHaveLength(0);
    });
  });

  describe('actor spoofing: identity and scope come from the verified bearer and persisted state only', () => {
    it('identity headers and body fields never change the actor, the kind or the Company', async () => {
      const m = await memberA();
      const b = await t.member(w.orgClinic, `b${uniq()}@b.test`);
      const spoof = { 'x-owner-id': ownerB.id, 'x-admin-user-id': ownerB.id, 'x-operator-id': ownerB.id, 'x-user-kind': 'operator', 'x-acting-user': ownerB.id, 'x-correlation-id': 'spoofed-correlation-1' };
      st(await suspend(m.id, undefined, ownerA, spoof), 200);
      const p = (await central('account.disabled', m.id))[0].payload;
      expect(p.actor).toEqual({ type: 'user', id: ownerA.id, userKind: 'owner' });
      // body fields naming an actor or a Company are refused, not trusted
      for (const extra of [{ actorId: ownerB.id }, { userKind: 'operator' }, { companyId: w.companyB }, { organizationId: w.orgClinic }]) {
        st(await suspend(b.id, { reason: 'compromised_account', ...extra }), 400);
      }
      // a member's headers cannot promote them
      const tokens = await login(await memberA());
      await t.http.post(`/auth/admin/members/${m.id}/restore`).set(bearer(tokens)).set('x-user-kind', 'owner').set('x-owner-id', ownerA.id).send({}).expect(403);
      expect(await isActive(b.id)).toBe(true);
    });
  });

  describe('session effect: suspension is live everywhere Auth answers', () => {
    it('an already-issued access token is refused on the next request (/auth/me, /auth/grants); refresh and login are refused; restore does not revive old sessions', async () => {
      const m = await memberA();
      const tokens = await login(m);
      await t.http.get('/auth/me').set(bearer(tokens)).expect(200);
      st(await suspend(m.id), 200);
      await t.http.get('/auth/me').set(bearer(tokens)).expect(401); // what Billing and Payment ask (live /auth/me)
      await t.http.get('/auth/grants').set(bearer(tokens)).expect(401); // what organization-service asks
      await t.http.post('/auth/refresh').send({ refreshToken: tokens.refreshToken }).expect(401);
      await t.http.post('/auth/login').send({ email: m.email, password: m.password }).expect(401);
      st(await restore(m.id), 200);
      await t.http.get('/auth/me').set(bearer(tokens)).expect(401); // the revoked session stays revoked
      await t.http.post('/auth/refresh').send({ refreshToken: tokens.refreshToken }).expect(401);
      await t.http.get('/auth/me').set(bearer(await login(m))).expect(200);
    });
  });

  describe('concurrency', () => {
    it('two simultaneous suspensions: exactly one change and one piece of evidence', async () => {
      const m = await memberA();
      const [t1, t2] = [await su('account.suspend'), await su('account.suspend')];
      const call = (tok: string) => t.http.post(`/auth/admin/members/${m.id}/suspend`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', tok).send({ reason: 'compromised_account' }).then((r) => r);
      const rs = await Promise.all([call(t1), call(t2)]);
      expect(rs.map((r) => r.status)).toEqual([200, 200]);
      expect(rs.map((r) => r.body.changed).sort((a, b) => Number(a) - Number(b))).toEqual([false, true]);
      expect(await central('account.disabled', m.id)).toHaveLength(1);
    });

    it('suspend vs restore race: the final state matches the evidence (one event per real change)', async () => {
      const m = await memberA();
      st(await suspend(m.id), 200);
      const [ts, tr] = [await su('account.suspend'), await su('account.restore')];
      const rs = await Promise.all([
        t.http.post(`/auth/admin/members/${m.id}/suspend`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', ts).send({ reason: 'security_incident' }).then((r) => r),
        t.http.post(`/auth/admin/members/${m.id}/restore`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', tr).send({}).then((r) => r),
      ]);
      expect(rs.map((r) => r.status)).toEqual([200, 200]);
      const disabled = (await central('account.disabled', m.id)).length;
      const enabled = (await central('account.enabled', m.id)).length;
      expect(disabled - 1 + enabled).toBe(rs.filter((r) => r.body.changed).length);
      expect(await isActive(m.id)).toBe(enabled === disabled);
    });
  });

  describe('audit atomicity', () => {
    it('an outbox failure rolls the suspension back: still active, sessions untouched, no local record, step-up not burned', async () => {
      const m = await memberA();
      await login(m);
      const token = await su('account.suspend');
      await t.db.query(`CREATE FUNCTION s192_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 's192 refused'; END $$`);
      await t.db.query(`CREATE TRIGGER s192_refuse BEFORE INSERT ON outbox FOR EACH ROW WHEN (NEW.name = 'audit.account.disabled') EXECUTE FUNCTION s192_refuse()`);
      try {
        await t.http.post(`/auth/admin/members/${m.id}/suspend`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', token).send({ reason: 'compromised_account' }).expect(500);
        expect(await isActive(m.id)).toBe(true);
        expect(await liveSessions(m.id)).toBe(1);
        expect(await local(m.id)).toEqual([]);
      } finally {
        await t.db.query(`DROP TRIGGER s192_refuse ON outbox`);
        await t.db.query(`DROP FUNCTION s192_refuse()`);
      }
      await t.http.post(`/auth/admin/members/${m.id}/suspend`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', token).send({ reason: 'compromised_account' }).expect(200);
      expect(await central('account.disabled', m.id)).toHaveLength(1);
    });

    it('a broker outage after commit never undoes the suspension: the outbox row waits, the relay publishes it once', async () => {
      const m = await memberA();
      bus.failNextPublishes(2);
      st(await suspend(m.id), 200);
      expect(await isActive(m.id)).toBe(false);
      const id = (await central('account.disabled', m.id))[0].id;
      await until(async () => bus.published.some((e) => e.id === id), 'published after the outage');
      expect(bus.published.filter((e) => e.id === id)).toHaveLength(1);
      expect(await isActive(m.id)).toBe(false);
    });
  });

  describe('privacy', () => {
    it('no contact data, secrets or reason text in responses, local metadata or logs of the new paths', async () => {
      const m = await memberA();
      const before = t.jsonLogs.length;
      const r = st(await suspend(m.id), 200);
      expect(Object.keys(r.body).sort()).toEqual(['changed', 'id', 'suspended']);
      expect(JSON.stringify(r.body)).not.toContain(m.email);
      const logs = JSON.stringify(t.jsonLogs.slice(before));
      expect(logs).not.toContain(m.email);
      expect(logs).not.toContain(ownerA.tokens.accessToken);
      expect(JSON.stringify(await local(m.id))).not.toMatch(/@|secret|token/i);
    });
  });
  describe('Stage 19.4 adversarial hardening', () => {
    it('step-up: an expired proof, a proof from another session of the same owner, and one proof used by two concurrent requests', async () => {
      const m1 = await memberA();
      const m2 = await memberA();
      const body = { reason: 'compromised_account' };
      const expired = await su('account.suspend');
      t.clock.advance(16 * 60_000); // past the 15-minute ceiling
      await t.http.post(`/auth/admin/members/${m1.id}/suspend`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', expired).send(body).expect(403);
      const other = await t.ownerLogin(ownerA, ownerA.totpSecret); // a second session of the same owner
      const foreign = await t.stepUpToken(other, 'account.suspend', ownerA.totpSecret);
      await t.http.post(`/auth/admin/members/${m1.id}/suspend`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', foreign).send(body).expect(403);
      const once = await su('account.suspend');
      const rs = await Promise.all([m1, m2].map((m) => t.http.post(`/auth/admin/members/${m.id}/suspend`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', once).send(body).then((r) => r)));
      expect(rs.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 403]);
      expect([await isActive(m1.id), await isActive(m2.id)].filter((a) => !a)).toHaveLength(1);
    });

    it('a disabled owner is refused on the next request, whatever it holds', async () => {
      const m = await memberA();
      const token = await su('account.suspend');
      await t.db.query(`UPDATE "user" SET "isActive"=false WHERE id=$1`, [ownerA.id]);
      try {
        await t.http.post(`/auth/admin/members/${m.id}/suspend`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', token).send({ reason: 'compromised_account' }).expect(401);
      } finally {
        await t.db.query(`UPDATE "user" SET "isActive"=true WHERE id=$1`, [ownerA.id]);
      }
      expect(await isActive(m.id)).toBe(true);
    });

    it.each([
      ['the local security record', `CREATE TRIGGER s194_refuse BEFORE INSERT ON auth_audit_event FOR EACH ROW WHEN (NEW.type = 'account.disabled' AND NEW.outcome = 'success') EXECUTE FUNCTION s194_refuse()`, 'auth_audit_event'],
      ['the session revocation', `CREATE TRIGGER s194_refuse BEFORE UPDATE ON refresh_token FOR EACH ROW WHEN (OLD."revokedAt" IS NULL AND NEW."revokedAt" IS NOT NULL) EXECUTE FUNCTION s194_refuse()`, 'refresh_token'],
    ])('atomicity: if %s fails, nothing commits (still active, sessions live, no evidence, step-up not burned)', async (_what, trigger, table) => {
      const m = await memberA();
      await login(m);
      const token = await su('account.suspend');
      await t.db.query(`CREATE FUNCTION s194_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 's194 refused'; END $$`);
      await t.db.query(trigger);
      try {
        await t.http.post(`/auth/admin/members/${m.id}/suspend`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', token).send({ reason: 'compromised_account' }).expect(500);
        expect(await isActive(m.id)).toBe(true);
        expect(await liveSessions(m.id)).toBe(1);
        expect(await central('account.disabled', m.id)).toHaveLength(0);
        expect(await local(m.id)).toEqual([]);
      } finally {
        await t.db.query(`DROP TRIGGER s194_refuse ON ${table}`);
        await t.db.query(`DROP FUNCTION s194_refuse()`);
      }
      await t.http.post(`/auth/admin/members/${m.id}/suspend`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', token).send({ reason: 'compromised_account' }).expect(200);
    });

    it('responses are not cacheable', async () => {
      const m = await memberA();
      expect(st(await suspend(m.id), 200).headers['cache-control']).toBe('no-store');
      expect(st(await restore(m.id), 200).headers['cache-control']).toBe('no-store');
    });

    it('reason: case, whitespace, control characters, arrays and objects cannot pass the closed set', async () => {
      const m = await memberA();
      for (const reason of ['Compromised_account', 'COMPROMISED_ACCOUNT', ' compromised_account', 'compromised_account ', 'compromised_account\u0000', 'compromised account',
        'compromised_account,policy_violation', ['compromised_account'], { value: 'compromised_account' }, null, true]) {
        st(await suspend(m.id, { reason } as Record<string, unknown>), 400);
      }
      expect(await isActive(m.id)).toBe(true);
      expect(await central('account.disabled', m.id)).toHaveLength(0);
    });

    it('enumeration: unknown, cross-Company, shared and pending-only targets are indistinguishable (status, body, headers)', async () => {
      const shared = await memberA();
      await t.addMembership(shared.id, w.orgClinic, 'student', 'pending');
      const targets = ['00000000-0000-4000-8000-000000000000', (await t.member(w.orgClinic, `b${uniq()}@b.test`)).id, shared.id, (await memberA('pending')).id];
      const rs = [];
      for (const id of targets) rs.push(await suspend(id));
      const shape = (r: { status: number; body: unknown; headers: Record<string, string> }) => ({
        status: r.status, body: noReqId(r.body), headers: Object.keys(r.headers).filter((h) => !['date', 'x-request-id', 'x-correlation-id', 'etag'].includes(h)).sort(),
      });
      for (const r of rs) expect(shape(r)).toEqual(shape(rs[0]!));
      expect(rs[0]!.status).toBe(404);
    });
  });
  describe('Stage 19.5 operational signals (closed labels, no identifiers)', () => {
    it('counts each outcome of suspend / restore; guard refusals are not this capability\'s; the snapshot line carries no id or reason', async () => {
      ownerA = { ...ownerA, tokens: await t.ownerLogin(ownerA, ownerA.totpSecret) }; // a fresh session: the fake clock has moved past earlier tokens
      const counters = t.app.get(MemberSecurityCounters);
      counters.drain();
      const m = await memberA();
      st(await suspend(m.id, { reason: 'policy_violation' }), 200); // changed
      st(await suspend(m.id), 200); // unchanged
      st(await restore(m.id), 200); // changed
      await t.http.post(`/auth/admin/members/${m.id}/suspend`).set(bearer(ownerA.tokens)).send({ reason: 'compromised_account' }).expect(403); // step-up denied
      st(await suspend((await t.member(w.orgClinic, `b${uniq()}@b.test`)).id), 404); // target refused
      const other = await memberA();
      const token = await su('account.suspend');
      await t.db.query(`CREATE FUNCTION s195_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 's195 refused'; END $$`);
      await t.db.query(`CREATE TRIGGER s195_refuse BEFORE INSERT ON outbox FOR EACH ROW WHEN (NEW.name = 'audit.account.disabled') EXECUTE FUNCTION s195_refuse()`);
      try {
        await t.http.post(`/auth/admin/members/${other.id}/suspend`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', token).send({ reason: 'compromised_account' }).expect(500); // failed
      } finally {
        await t.db.query(`DROP TRIGGER s195_refuse ON outbox`);
        await t.db.query(`DROP FUNCTION s195_refuse()`);
      }
      const opTokens = await t.operatorLogin((await t.operator(w.companyA, `op${uniq()}@a.test`)).email);
      await t.http.post(`/auth/admin/members/${m.id}/suspend`).set(bearer(opTokens)).send({ reason: 'compromised_account' }).expect(403); // guard: not counted
      const before = t.logger.lines.length;
      t.app.get(MemberSecurityReporter).snapshot();
      const line = t.logger.lines.slice(before).find((x) => x.startsWith('auth_member_security_snapshot'))!;
      expect(line).toContain('auth_member_security_snapshot suspend_changed=1 suspend_unchanged=1 suspend_step_up_denied=1 suspend_target_refused=1 suspend_failed=1 restore_changed=1 restore_unchanged=0 restore_step_up_denied=0 restore_target_refused=0 restore_failed=0');
      expect(Object.values(counters.drain()).every((v) => v === 0)).toBe(true); // drained by the snapshot
      expect(line).not.toMatch(/[0-9a-f]{8}-|policy_violation|@/);
    });
  });
});
