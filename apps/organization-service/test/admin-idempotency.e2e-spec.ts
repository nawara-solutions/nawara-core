import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import type { AuthGrantFacts, AuthGrantsClient } from '../src/admin/auth-grants-client.js';
import { organizationMigrationsDir } from '../src/app.module.js';
import { bearer, createTestApp, newKey, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { sql } from './support/fixtures.js';

/**
 * Auth's grants and step-up verification as Auth really behaves for these tests: a proof is SINGLE-USE (consumed by the first
 * successful verify), every verify is counted, a session can be revoked and authority changed between requests.
 */
class ConsumingAuth implements AuthGrantsClient {
  private readonly grants = new Map<string, AuthGrantFacts>();
  private readonly proofs = new Set<string>();
  readonly verifies: string[] = [];
  down = false;

  owner(b: string, companyId: string): string {
    const userId = randomUUID();
    this.grants.set(b, { userId, kind: 'owner', companyId, platformAssignments: [], organizationAdminMemberships: [] });
    return userId;
  }
  /** Same user, new facts (authority changed in Auth); the session stays valid. */
  moveOwner(b: string, companyId: string) {
    this.grants.set(b, { ...this.grants.get(b)!, companyId });
  }
  revokeSession(b: string) {
    this.grants.delete(b);
  }
  proof(b: string, purpose: string, token: string) {
    this.proofs.add(`${b}|${purpose}|${token}`);
  }
  async grantsFor(b: string): Promise<AuthGrantFacts> {
    if (this.down) throw new ServiceUnavailableException(); // what HttpAuthGrantsClient throws when Auth cannot answer
    const f = this.grants.get(b);
    if (!f) throw new UnauthorizedException();
    return f;
  }
  async verifyStepUp(b: string, purpose: string, token: string): Promise<boolean> {
    this.verifies.push(`${purpose}|${token}`);
    return this.proofs.delete(`${b}|${purpose}|${token}`); // atomic in Auth; here the event loop makes it atomic
  }
}

describeWithEnv('admin idempotent replay before step-up (CIR S1) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const auth = new ConsumingAuth();

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgidem');
    await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, authGrantsClient: auth });
  });
  afterAll(async () => {
    await t?.app.close();
    await db?.drop();
  });

  const seedCompany = async () => (await sql<{ id: string }>(db.url, `INSERT INTO company(name) VALUES ('Idem Co') RETURNING id`))[0]!.id;
  const seedPlatform = async (c: string) =>
    (await sql<{ id: string }>(db.url, `INSERT INTO platform(id,"companyId",name) VALUES (gen_random_uuid(),$1,'P') RETURNING id`, [c]))[0]!.id;
  const createPlatform = (b: string, key: string, proof: string | null, body: object) => {
    const r = t.http().post('/organization/admin/platforms').set(bearer(b)).set('Idempotency-Key', key);
    return (proof ? r.set('x-step-up-token', proof) : r).send(body);
  };
  const createOrganization = (b: string, key: string, proof: string | null, body: object) => {
    const r = t.http().post('/organization/admin/organizations').set(bearer(b)).set('Idempotency-Key', key);
    return (proof ? r.set('x-step-up-token', proof) : r).send(body);
  };
  const actorEvents = (targetId: string) =>
    sql<{ operation: string; outcome: string }>(db.url, `SELECT operation, outcome FROM admin_actor_event WHERE target_id = $1 ORDER BY id`, [targetId]);
  const createdAudits = (id: string, action: string) =>
    sql<{ n: number }>(db.url, `SELECT count(*)::int AS n FROM outbox WHERE name = $1 AND payload->'resource'->>'id' = $2`, [`audit.${action}`, id]);
  const verifiesOf = (token: string) => auth.verifies.filter((v) => v.endsWith(`|${token}`)).length;

  describe('Platform', () => {
    it('1-2, 12-14: a first create is 201; the same key and body is a 200 replay that verifies no proof and writes no second creation', async () => {
      const co = await seedCompany();
      auth.owner('b-p1', co);
      auth.proof('b-p1', 'platform.create', 'su-p1');
      const key = newKey();
      const first = await createPlatform('b-p1', key, 'su-p1', { companyId: co, name: 'Driving' });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(auth.verifies).toContain('platform.create|su-p1'); // the owner purpose and contract are unchanged

      const replay = await createPlatform('b-p1', key, 'su-p1', { companyId: co, name: 'Driving' }); // the proof is already spent
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(verifiesOf('su-p1')).toBe(1); // no second verify, so no second consume
      expect(await sql(db.url, `SELECT count(*)::int AS n FROM platform WHERE "companyId" = $1`, [co])).toEqual([{ n: 1 }]);
      expect(await createdAudits(first.body.id, 'platform.created')).toEqual([{ n: 1 }]);
      expect(await actorEvents(first.body.id)).toEqual([
        { operation: 'platform.create', outcome: 'succeeded' },
        { operation: 'platform.create.replay', outcome: 'succeeded' },
      ]);
    });

    it('5: the same key with a different body is 422 idempotency_key_reused, before any proof is verified', async () => {
      const co = await seedCompany();
      auth.owner('b-p5', co);
      auth.proof('b-p5', 'platform.create', 'su-p5');
      const key = newKey();
      expect((await createPlatform('b-p5', key, 'su-p5', { companyId: co, name: 'One' })).status).toBe(201);
      auth.proof('b-p5', 'platform.create', 'su-p5b');
      const r = await createPlatform('b-p5', key, 'su-p5b', { companyId: co, name: 'Two' });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('idempotency_key_reused');
      expect(verifiesOf('su-p5b')).toBe(0);
    });

    it('6: a revoked session gets 401 and no stored result', async () => {
      const co = await seedCompany();
      auth.owner('b-p6', co);
      auth.proof('b-p6', 'platform.create', 'su-p6');
      const key = newKey();
      expect((await createPlatform('b-p6', key, 'su-p6', { companyId: co, name: 'X' })).status).toBe(201);
      auth.revokeSession('b-p6');
      const r = await createPlatform('b-p6', key, 'su-p6', { companyId: co, name: 'X' });
      expect(r.status).toBe(401);
      expect(r.body.id).toBeUndefined();
    });

    it('7: a caller who no longer holds authority over the Company gets 403 and no stored result (denial recorded)', async () => {
      const co = await seedCompany();
      const other = await seedCompany();
      const userId = auth.owner('b-p7', co);
      auth.proof('b-p7', 'platform.create', 'su-p7');
      const key = newKey();
      expect((await createPlatform('b-p7', key, 'su-p7', { companyId: co, name: 'X' })).status).toBe(201);
      auth.moveOwner('b-p7', other);
      const r = await createPlatform('b-p7', key, null, { companyId: co, name: 'X' });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('admin_forbidden');
      expect(r.body.id).toBeUndefined();
      expect(await sql(db.url, `SELECT outcome, reason FROM admin_actor_event WHERE actor_user_id = $1 AND outcome = 'denied'`, [userId]))
        .toEqual([{ outcome: 'denied', reason: 'no_authority' }]);
    });

    it('8: Auth unavailable fails closed (503) and returns no stored result', async () => {
      const co = await seedCompany();
      auth.owner('b-p8', co);
      auth.proof('b-p8', 'platform.create', 'su-p8');
      const key = newKey();
      expect((await createPlatform('b-p8', key, 'su-p8', { companyId: co, name: 'X' })).status).toBe(201);
      auth.down = true;
      try {
        const r = await createPlatform('b-p8', key, null, { companyId: co, name: 'X' });
        expect(r.status).toBe(503);
        expect(r.body.id).toBeUndefined();
      } finally {
        auth.down = false;
      }
    });

    it('9: concurrent same-key requests with separate valid proofs create exactly one Platform (one 201, one 200)', async () => {
      const co = await seedCompany();
      auth.owner('b-p9', co);
      auth.proof('b-p9', 'platform.create', 'su-p9a');
      auth.proof('b-p9', 'platform.create', 'su-p9b');
      const key = newKey();
      const rs = await Promise.all([
        createPlatform('b-p9', key, 'su-p9a', { companyId: co, name: 'Race' }),
        createPlatform('b-p9', key, 'su-p9b', { companyId: co, name: 'Race' }),
      ]);
      expect(rs.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 201]);
      expect(rs[0]!.body.id).toBe(rs[1]!.body.id);
      expect(await sql(db.url, `SELECT count(*)::int AS n FROM platform WHERE "companyId" = $1`, [co])).toEqual([{ n: 1 }]);
      expect(await createdAudits(rs[0]!.body.id, 'platform.created')).toEqual([{ n: 1 }]);
      const ops = (await actorEvents(rs[0]!.body.id)).map((e) => e.operation).sort((a, b) => a.localeCompare(b));
      expect(ops).toEqual(['platform.create', 'platform.create.replay']);
    });

    it('10: one proof used by two concurrent different-key requests succeeds at most once', async () => {
      const co = await seedCompany();
      auth.owner('b-p10', co);
      auth.proof('b-p10', 'platform.create', 'su-p10');
      const rs = await Promise.all([
        createPlatform('b-p10', newKey(), 'su-p10', { companyId: co, name: 'A' }),
        createPlatform('b-p10', newKey(), 'su-p10', { companyId: co, name: 'B' }),
      ]);
      expect(rs.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 403]);
      expect(await sql(db.url, `SELECT count(*)::int AS n FROM platform WHERE "companyId" = $1`, [co])).toEqual([{ n: 1 }]);
    });
  });

  describe('Organization', () => {
    it('3-4, 12-13: a first create is 201; the same key and body is a 200 replay with no second verify or creation', async () => {
      const co = await seedCompany();
      const pl = await seedPlatform(co);
      auth.owner('b-o1', co);
      auth.proof('b-o1', 'organization.create', 'su-o1');
      const key = newKey();
      const first = await createOrganization('b-o1', key, 'su-o1', { platformId: pl, name: 'School A' });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const replay = await createOrganization('b-o1', key, 'su-o1', { platformId: pl, name: 'School A' });
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(verifiesOf('su-o1')).toBe(1);
      expect(await sql(db.url, `SELECT count(*)::int AS n FROM organization WHERE "platformId" = $1`, [pl])).toEqual([{ n: 1 }]);
      expect(await createdAudits(first.body.id, 'organization.created')).toEqual([{ n: 1 }]);
      expect(await actorEvents(first.body.id)).toEqual([
        { operation: 'organization.create', outcome: 'succeeded' },
        { operation: 'organization.create.replay', outcome: 'succeeded' },
      ]);
    });

    it('5: the same key with a different body is 422', async () => {
      const co = await seedCompany();
      const pl = await seedPlatform(co);
      auth.owner('b-o5', co);
      auth.proof('b-o5', 'organization.create', 'su-o5');
      const key = newKey();
      expect((await createOrganization('b-o5', key, 'su-o5', { platformId: pl, name: 'One' })).status).toBe(201);
      const r = await createOrganization('b-o5', key, null, { platformId: pl, name: 'Two' });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('idempotency_key_reused');
    });

    it('7: a caller without current authority over the Platform gets 403 and no stored result', async () => {
      const co = await seedCompany();
      const pl = await seedPlatform(co);
      auth.owner('b-o7', co);
      auth.proof('b-o7', 'organization.create', 'su-o7');
      const key = newKey();
      expect((await createOrganization('b-o7', key, 'su-o7', { platformId: pl, name: 'S' })).status).toBe(201);
      auth.moveOwner('b-o7', await seedCompany());
      const r = await createOrganization('b-o7', key, null, { platformId: pl, name: 'S' });
      expect(r.status).toBe(403);
      expect(r.body.id).toBeUndefined();
    });

    it('9: concurrent same-key requests with separate proofs create exactly one Organization', async () => {
      const co = await seedCompany();
      const pl = await seedPlatform(co);
      auth.owner('b-o9', co);
      auth.proof('b-o9', 'organization.create', 'su-o9a');
      auth.proof('b-o9', 'organization.create', 'su-o9b');
      const key = newKey();
      const rs = await Promise.all([
        createOrganization('b-o9', key, 'su-o9a', { platformId: pl, name: 'Race' }),
        createOrganization('b-o9', key, 'su-o9b', { platformId: pl, name: 'Race' }),
      ]);
      expect(rs.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 201]);
      expect(await sql(db.url, `SELECT count(*)::int AS n FROM organization WHERE "platformId" = $1`, [pl])).toEqual([{ n: 1 }]);
    });

    it('11: a create that fails before commit leaves no idempotency record; a retry with the spent proof is refused, a fresh one creates', async () => {
      const co = await seedCompany();
      const pl = await seedPlatform(co);
      const userId = auth.owner('b-o11', co);
      auth.proof('b-o11', 'organization.create', 'su-o11');
      // Make the success actor record fail inside the create's transaction, so the whole create rolls back.
      await sql(db.url, `CREATE FUNCTION s1_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 's1 refuse'; END $$`);
      await sql(db.url, `CREATE TRIGGER s1_refuse BEFORE INSERT ON admin_actor_event FOR EACH ROW WHEN (NEW.actor_user_id = '${userId}') EXECUTE FUNCTION s1_refuse()`);
      const key = newKey();
      try {
        const failed = await createOrganization('b-o11', key, 'su-o11', { platformId: pl, name: 'Fails' });
        expect(failed.status).toBeGreaterThanOrEqual(500);
      } finally {
        await sql(db.url, 'DROP TRIGGER IF EXISTS s1_refuse ON admin_actor_event');
        await sql(db.url, 'DROP FUNCTION IF EXISTS s1_refuse()');
      }
      expect(await sql(db.url, `SELECT count(*)::int AS n FROM idempotency_key WHERE key = $1`, [key])).toEqual([{ n: 0 }]);
      expect(await sql(db.url, `SELECT count(*)::int AS n FROM organization WHERE "platformId" = $1`, [pl])).toEqual([{ n: 0 }]);
      expect((await createOrganization('b-o11', key, 'su-o11', { platformId: pl, name: 'Fails' })).status).toBe(403); // spent proof
      auth.proof('b-o11', 'organization.create', 'su-o11b');
      expect((await createOrganization('b-o11', key, 'su-o11b', { platformId: pl, name: 'Fails' })).status).toBe(201);
    });
  });
});
