import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

describe('platform authorization: owner, operator, member, tenancy', () => {
  let t: TestCtx;
  let w: Awaited<ReturnType<TestCtx['world']>>;
  let ownerA: Awaited<ReturnType<TestCtx['readyOwner']>>;
  let ownerB: Awaited<ReturnType<TestCtx['readyOwner']>>;
  beforeAll(async () => {
    t = await createTestApp();
    w = await t.world();
    ownerA = await t.readyOwner(w.companyA, 'owner@a.test');
    ownerB = await t.readyOwner(w.companyB, 'owner@b.test');
  });
  afterAll(() => t.close());

  const access = (tokens: any, platformId: string) => t.http.get(`/auth/platform-access/${platformId}`).set(bearer(tokens));
  const grant = async (owner: typeof ownerA, operatorId: string, platformId: string) => {
    const su = await t.stepUpToken(owner.tokens, 'platform_assignment.grant', owner.totpSecret);
    return t.http.post(`/auth/admin/operators/${operatorId}/platform-assignments`).set(bearer(owner.tokens)).set('X-Step-Up-Token', su).send({ platformId });
  };
  const revoke = async (owner: typeof ownerA, operatorId: string, platformId: string) => {
    const su = await t.stepUpToken(owner.tokens, 'platform_assignment.revoke', owner.totpSecret);
    return t.http.delete(`/auth/admin/operators/${operatorId}/platform-assignments/${platformId}`).set(bearer(owner.tokens)).set('X-Step-Up-Token', su);
  };

  describe('owner', () => {
    it('reaches every platform of its OWN company with no PlatformAssignment', async () => {
      await access(ownerA.tokens, w.platformSchool).expect(200);
      await access(ownerA.tokens, w.platformDrive).expect(200);
      const n = await t.db.query(`SELECT count(*)::int n FROM platform_assignment WHERE "operatorId"=$1`, [ownerA.id]);
      expect(n.rows[0].n).toBe(0);
    });
    it('cannot reach another company’s platform (and gets the same 404 as for a nonexistent one)', async () => {
      const foreign = await access(ownerA.tokens, w.platformClinic);
      const missing = await access(ownerA.tokens, randomUUID());
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);
      await access(ownerB.tokens, w.platformSchool).expect(404);
      await access(ownerB.tokens, w.platformClinic).expect(200);
    });
    it('reaches organizations under its platforms only', async () => {
      await t.http.get(`/auth/admin/organizations/${w.orgSchool1}`).set(bearer(ownerA.tokens)).expect(200);
      await t.http.get(`/auth/admin/organizations/${w.orgDrive}`).set(bearer(ownerA.tokens)).expect(200);
      await t.http.get(`/auth/admin/organizations/${w.orgClinic}`).set(bearer(ownerA.tokens)).expect(404);
    });
  });

  describe('operator', () => {
    it('is denied everywhere without an active assignment', async () => {
      const op = await t.operator(w.companyA, 'noassign@a.test');
      const tk = await t.operatorLogin(op.email);
      await access(tk, w.platformSchool).expect(404);
      await t.http.get(`/auth/admin/organizations/${w.orgSchool1}`).set(bearer(tk)).expect(404);
    });

    it('is allowed exactly on assigned platforms, and only inside its own company', async () => {
      const op = await t.operator(w.companyA, 'assigned@a.test');
      const tk = await t.operatorLogin(op.email);
      expect((await grant(ownerA, op.id, w.platformSchool)).status).toBe(201);
      await access(tk, w.platformSchool).expect(200); // same token, now assigned
      await access(tk, w.platformDrive).expect(404); // Platform A vs Platform B
      await access(tk, w.platformClinic).expect(404); // other company
      // resource -> organization -> platform -> assignment, for every organization inside the platform
      await t.http.get(`/auth/admin/organizations/${w.orgSchool1}`).set(bearer(tk)).expect(200);
      await t.http.get(`/auth/admin/organizations/${w.orgSchool2}`).set(bearer(tk)).expect(200);
      await t.http.get(`/auth/admin/organizations/${w.orgDrive}`).set(bearer(tk)).expect(404);
      await t.http.get(`/auth/admin/organizations/${w.orgClinic}`).set(bearer(tk)).expect(404);
    });

    it('LOSES ACCESS IMMEDIATELY when the assignment is revoked, with the very same unexpired token', async () => {
      const op = await t.operator(w.companyA, 'revoked@a.test');
      const tk = await t.operatorLogin(op.email);
      await grant(ownerA, op.id, w.platformSchool).then((r) => expect(r.status).toBe(201));
      await access(tk, w.platformSchool).expect(200);
      expect((await revoke(ownerA, op.id, w.platformSchool)).status).toBe(204);
      await access(tk, w.platformSchool).expect(404); // same token, revoked assignment
      await t.http.get(`/auth/admin/organizations/${w.orgSchool1}`).set(bearer(tk)).expect(404);
      // the operator's session itself is NOT ended (revocation is scoped to the platform)...
      await t.http.get('/auth/me').set(bearer(tk)).expect(200);
      // ...and another platform's assignment is untouched
      await grant(ownerA, op.id, w.platformDrive).then((r) => expect(r.status).toBe(201));
      await revoke(ownerA, op.id, w.platformSchool).then((r) => expect(r.status).toBe(404));
      await access(tk, w.platformDrive).expect(200);
    });

    it('a stale claim can never grant access: the token carries no platform/company claim at all', async () => {
      const op = await t.operator(w.companyA, 'claims@a.test');
      const tk = await t.operatorLogin(op.email);
      const payload = JSON.parse(Buffer.from(tk.accessToken.split('.')[1], 'base64url').toString());
      expect(Object.keys(payload).sort()).toEqual(['adminTier', 'aud', 'exp', 'iat', 'iss', 'role', 'sid', 'sub']);
      expect(payload.adminTier).toBe('operator');
    });

    it('a client-supplied platform/company hint cannot override server-side authorization', async () => {
      const op = await t.operator(w.companyA, 'hint@a.test');
      const tk = await t.operatorLogin(op.email);
      await grant(ownerA, op.id, w.platformDrive);
      // organization belongs to School; the caller only holds Drive. A forged hint changes nothing.
      const r = await t.http.get(`/auth/admin/organizations/${w.orgSchool1}`).query({ platformId: w.platformDrive, companyId: w.companyA }).set(bearer(tk)).set('X-Platform-Id', w.platformDrive);
      expect(r.status).toBe(404);
    });

    it('a blocked operator loses everything at once: sessions, codes and platform access', async () => {
      const op = await t.operator(w.companyA, 'blocked@a.test');
      const tk = await t.operatorLogin(op.email);
      await grant(ownerA, op.id, w.platformSchool);
      await t.http.post(`/auth/admin/operators/${op.id}/block`).set(bearer(ownerA.tokens)).expect(204);
      await access(tk, w.platformSchool).expect(401);
      await t.http.post('/auth/refresh').send({ refreshToken: tk.refreshToken }).expect(401);
      expect(await t.operatorCode(op.email)).toBeUndefined();
      await t.http.post(`/auth/admin/operators/${op.id}/unblock`).set(bearer(ownerA.tokens)).expect(204);
      expect(await t.operatorCode(op.email)).toMatch(/^\d{6}$/);
    });
  });

  describe('assignment mutation attacks', () => {
    it('non-owners cannot grant or revoke: operator, member, anonymous', async () => {
      const op = await t.operator(w.companyA, 'atk-op@a.test');
      const other = await t.operator(w.companyA, 'atk-victim@a.test');
      const opTk = await t.operatorLogin(op.email);
      const m = await t.member(w.orgSchool1, 'atk-m@a.test');
      const mTk = (await t.http.post('/auth/login').send({ email: m.email, password: m.password })).body;
      const url = `/auth/admin/operators/${other.id}/platform-assignments`;
      for (const tk of [opTk, mTk]) {
        await t.http.post(url).set(bearer(tk)).send({ platformId: w.platformSchool }).expect(403);
        await t.http.delete(`${url}/${w.platformSchool}`).set(bearer(tk)).expect(403);
        await t.http.get(url).set(bearer(tk)).expect(403);
      }
      await t.http.post(url).send({ platformId: w.platformSchool }).expect(401);
      // an operator cannot assign THEMSELVES either
      await t.http.post(`/auth/admin/operators/${op.id}/platform-assignments`).set(bearer(opTk)).send({ platformId: w.platformSchool }).expect(403);
    });

    it('cross-company attacks all fail: owner A -> operator B, owner A -> platform B, owner B -> platform A', async () => {
      const opA = await t.operator(w.companyA, 'x-opa@a.test');
      const opB = await t.operator(w.companyB, 'x-opb@b.test');
      expect((await grant(ownerA, opB.id, w.platformSchool)).status).toBe(404); // Assignment A -> Operator B
      expect((await grant(ownerA, opA.id, w.platformClinic)).status).toBe(404); // Assignment A -> Platform B
      expect((await grant(ownerB, opA.id, w.platformClinic)).status).toBe(404); // Owner B -> Operator A
      expect((await grant(ownerB, opB.id, w.platformSchool)).status).toBe(404); // Owner B -> Platform A
      const n = await t.db.query(`SELECT count(*)::int n FROM platform_assignment WHERE "operatorId" = ANY($1)`, [[opA.id, opB.id]]);
      expect(n.rows[0].n).toBe(0);
    });

    it('a duplicate active grant is refused (409); history is append-only and re-grant creates a new row', async () => {
      const op = await t.operator(w.companyA, 'hist@a.test');
      expect((await grant(ownerA, op.id, w.platformSchool)).status).toBe(201);
      expect((await grant(ownerA, op.id, w.platformSchool)).status).toBe(409);
      expect((await revoke(ownerA, op.id, w.platformSchool)).status).toBe(204);
      expect((await grant(ownerA, op.id, w.platformSchool)).status).toBe(201);
      const h = await t.http.get(`/auth/admin/operators/${op.id}/platform-assignments`).set(bearer(ownerA.tokens)).expect(200);
      expect(h.body).toHaveLength(2);
      expect(h.body.filter((r: any) => r.active)).toHaveLength(1);
      const revoked = h.body.find((r: any) => !r.active);
      expect(revoked.revokedBy).toBe(ownerA.id); // revokedBy derived from the authenticated owner
      await t.db.query(`DELETE FROM platform_assignment WHERE id=$1`, [revoked.id]).then(() => { throw new Error('should not delete'); }, (e) => expect(e.code).toBe('23514'));
    });

    it('concurrent grants for the same operator+platform create exactly one active assignment', async () => {
      const op = await t.operator(w.companyA, 'race@a.test');
      const tokens: string[] = [];
      for (let i = 0; i < 6; i++) tokens.push(await t.stepUpToken(ownerA.tokens, 'platform_assignment.grant', ownerA.totpSecret));
      const res = await Promise.all(tokens.map((su) =>
        t.http.post(`/auth/admin/operators/${op.id}/platform-assignments`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', su).send({ platformId: w.platformSchool })));
      expect(res.filter((r) => r.status === 201)).toHaveLength(1);
      expect(res.filter((r) => r.status === 409)).toHaveLength(5);
      const n = await t.db.query(`SELECT count(*)::int n FROM platform_assignment WHERE "operatorId"=$1 AND active`, [op.id]);
      expect(n.rows[0].n).toBe(1);
    });
  });

  describe('member', () => {
    it('reaches only its own organization; other organizations and platforms are indistinguishable 404s', async () => {
      const m = await t.member(w.orgSchool1, 'mem@a.test');
      const tk = (await t.http.post('/auth/login').send({ email: m.email, password: m.password })).body;
      await t.http.get(`/auth/organizations/${w.orgSchool1}/membership`).set(bearer(tk)).expect(204);
      await t.http.get(`/auth/organizations/${w.orgSchool2}/membership`).set(bearer(tk)).expect(404); // same platform, other org
      await t.http.get(`/auth/organizations/${w.orgDrive}/membership`).set(bearer(tk)).expect(404); // other platform
      await t.http.get(`/auth/organizations/${w.orgClinic}/membership`).set(bearer(tk)).expect(404); // other company
      // members have no management access at all
      await access(tk, w.platformSchool).expect(403);
      await t.http.get(`/auth/admin/organizations/${w.orgSchool1}`).set(bearer(tk)).expect(403);
    });
    it('resolves its platform only through Membership -> Organization -> Platform (no platformId anywhere)', async () => {
      const m = await t.member(w.orgSchool1, 'path@a.test');
      const r = await t.db.query(`SELECT "organizationId","platformId","companyId" FROM member_platform WHERE "userId"=$1`, [m.id]);
      expect(r.rows[0]).toEqual({ organizationId: w.orgSchool1, platformId: w.platformSchool, companyId: w.companyA });
      const cols = await t.db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='user' AND column_name ILIKE '%platform%'`);
      expect(cols.rowCount).toBe(0);
    });
  });

  describe('tenancy anchors cannot be changed through the service’s database role', () => {
    it.each([
      ['Owner.companyId', `UPDATE owner SET "companyId"='%B%' WHERE "userId"='%OWNER%'`],
      ['Platform.companyId', `UPDATE platform SET "companyId"='%B%' WHERE id='%PLATFORM%'`],
      ['Organization.platformId', `UPDATE organization SET "platformId"='%PLATFORM2%' WHERE id='%ORG%'`],
    ])('%s is immutable', async (_n, sql) => {
      const q = sql.replace('%B%', w.companyB).replace('%OWNER%', ownerA.id).replace('%PLATFORM%', w.platformSchool).replace('%PLATFORM2%', w.platformDrive).replace('%ORG%', w.orgSchool1);
      await t.db.query(q).then(() => { throw new Error('update succeeded'); }, (e) => expect(e.code).toBe('23514'));
    });
    it('Operator.companyId is immutable', async () => {
      const op = await t.operator(w.companyA, 'anchor@a.test');
      await t.db.query(`UPDATE operator SET "companyId"=$2 WHERE "userId"=$1`, [op.id, w.companyB]).then(() => { throw new Error('update succeeded'); }, (e) => expect(e.code).toBe('23514'));
    });
  });
});
