import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { organizationMigrationsDir } from '../src/app.module.js';
import { activateOwnership, bearer, createTestApp, newKey, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { sql } from './support/fixtures.js';

/** Platforms P1, P2 and P7; organizations O17 (in P2) and O99 (in P7); O1 in P1. */
const CO = 'c0000000-0000-4000-8000-000000000001';
const P1 = 'a0000000-0000-4000-8000-000000000001';
const P2 = 'a0000000-0000-4000-8000-000000000002';
const P7 = 'a0000000-0000-4000-8000-000000000007';
const O1 = 'b0000000-0000-4000-8000-000000000001';
const O17 = 'b0000000-0000-4000-8000-000000000017';
const O99 = 'b0000000-0000-4000-8000-000000000099';

const CALLERS = ['payment-service', 'billing-service', 'auth-service', 'provisioning', 'read-only-other'];
const POLICY = JSON.stringify({
  callers: {
    'payment-service': { capabilities: ['hierarchy.reference.read'], allowedPlatforms: [P1, P2] },
    'billing-service': { capabilities: ['hierarchy.reference.read'], allowedPlatforms: [] }, // admitted, but no Platform yet
    'auth-service': { capabilities: ['hierarchy.read'], allowedPlatforms: [P1, P2] },
    provisioning: { capabilities: ['hierarchy.provision'] },
    'read-only-other': { capabilities: ['hierarchy.read'], allowedPlatforms: [P7] },
  },
});

describeWithEnv('service authorization: admission, operation, Platform scope, provisioning (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const as = (caller: string) => bearer(t.callers[caller]!);
  const get = (caller: string, path: string) => t.http().get(path).set(as(caller));

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgsvcauth');
    await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
    await activateOwnership(db.url);
    await sql(db.url, `INSERT INTO company (id, name) VALUES ('${CO}', 'Acme')`);
    await sql(db.url, `INSERT INTO platform (id, "companyId", name) VALUES ('${P1}', '${CO}', 'One'), ('${P2}', '${CO}', 'Two'), ('${P7}', '${CO}', 'Seven')`);
    await sql(db.url, `INSERT INTO organization (id, "platformId", name, "taxCode") VALUES ('${O1}', '${P1}', 'Org 1', 'SECRET-TAX'), ('${O17}', '${P2}', 'Org 17', 'SECRET-TAX'), ('${O99}', '${P7}', 'Org 99', 'SECRET-TAX')`);
    t = await createTestApp({ databaseUrl: db.url, callers: CALLERS, policy: POLICY });
  });
  afterAll(async () => {
    await t?.app.close();
    await db.drop();
  });

  describe('the reference read: organization -> platform -> scope', () => {
    it('allows an organization whose resolved Platform is inside the credential\'s explicit scope, and returns ids only', async () => {
      const r = await get('payment-service', `/organization/reference/organizations/${O17}`); // O17 -> P2, P2 is allowed
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ organizationId: O17, platformId: P2, companyId: CO });
      expect(JSON.stringify(r.body)).not.toMatch(/SECRET-TAX|Org 17|name|address|key/);
    });
    it('denies an organization whose resolved Platform is outside the scope (O99 -> P7), collapsed to 404: no existence oracle', async () => {
      const out = await get('payment-service', `/organization/reference/organizations/${O99}`);
      const missing = await get('payment-service', `/organization/reference/organizations/b0000000-0000-4000-8000-0000000000ee`);
      expect(out.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(out.body).toEqual({ ...missing.body, requestId: out.body.requestId });
    });
    it('an admitted caller with an EMPTY explicit scope sees no platform at all (no implicit all-Platform access)', async () => {
      expect((await get('billing-service', `/organization/reference/organizations/${O1}`)).status).toBe(404);
      expect((await get('billing-service', `/organization/reference/organizations/${O17}`)).status).toBe(404);
    });
    it('the scope is the credential\'s, never the request\'s: a client-supplied scope, platform, organization or caller changes nothing', async () => {
      const attempts = [
        t.http().get(`/organization/reference/organizations/${O99}?allowedPlatforms=${P7}&platformId=${P7}&scope=*`).set(as('payment-service')),
        t.http().get(`/organization/reference/organizations/${O99}`).set(as('payment-service')).set('x-allowed-platforms', P7).set('x-platform-id', P7).set('x-caller', 'read-only-other').set('x-service', 'read-only-other'),
        t.http().get(`/organization/reference/organizations/${O99}`).set(as('payment-service')).set('x-producer', 'auth-service'),
      ];
      for (const a of attempts) expect((await a).status).toBe(404);
    });
    it('a caller that lacks the reference capability is refused with 403 whatever the target (admission, not scope)', async () => {
      for (const caller of ['auth-service', 'provisioning', 'read-only-other']) {
        const r = await get(caller, `/organization/reference/organizations/${O17}`);
        expect(r.status, caller).toBe(403);
        expect(r.body.code).toBe('forbidden');
      }
    });
  });

  describe('operation authorization is separate from admission', () => {
    it('the reference-read producer cannot list, read fully, create, or update anything', async () => {
      for (const path of ['/organization/companies', `/organization/companies/${CO}`, '/organization/platforms', `/organization/platforms/${P2}`, '/organization/organizations', `/organization/organizations/${O17}`]) {
        expect((await get('payment-service', path)).status, path).toBe(403);
      }
      const write = await t.http().post('/organization/organizations').set(as('payment-service')).set('Idempotency-Key', newKey()).send({ platformId: P2, name: 'x' });
      expect(write.status).toBe(403);
    });
    it('the service write capability has NO holder: nobody can create or update a Platform or Organization through a service credential', async () => {
      for (const caller of CALLERS) {
        expect((await t.http().post('/organization/platforms').set(as(caller)).set('Idempotency-Key', newKey()).send({ companyId: CO, name: 'x' })).status, caller).toBe(403);
        expect((await t.http().post('/organization/organizations').set(as(caller)).set('Idempotency-Key', newKey()).send({ platformId: P1, name: 'x' })).status, caller).toBe(403);
        expect((await t.http().patch(`/organization/platforms/${P1}`).set(as(caller)).send({ name: 'x' })).status, caller).toBe(403);
        expect((await t.http().patch(`/organization/organizations/${O1}`).set(as(caller)).send({ name: 'x' })).status, caller).toBe(403);
      }
    });
    it('changing a Company name has no holder either (OPEN-4): denied to every caller', async () => {
      for (const caller of CALLERS) expect((await t.http().patch(`/organization/companies/${CO}`).set(as(caller)).send({ name: 'x' })).status, caller).toBe(403);
      expect((await sql(db.url, `SELECT name FROM company WHERE id = '${CO}'`))[0].name).toBe('Acme');
    });
  });

  describe('the full read is Platform-scoped too (Auth\'s first touch), except Company reads, which have no Platform', () => {
    it('lists and reads only inside the scope; outside it is a collapsed 404 and absent from lists', async () => {
      const list = await get('auth-service', '/organization/organizations');
      expect(list.status).toBe(200);
      expect(list.body.items.map((o: { id: string }) => o.id).sort()).toEqual([O1, O17].sort());
      expect((await get('auth-service', `/organization/organizations/${O17}`)).status).toBe(200);
      expect((await get('auth-service', `/organization/organizations/${O99}`)).status).toBe(404);
      expect((await get('auth-service', `/organization/platforms/${P7}`)).status).toBe(404);
      const platforms = await get('auth-service', '/organization/platforms');
      expect(platforms.body.items.map((p: { id: string }) => p.id).sort()).toEqual([P1, P2].sort());
    });
    it('a different credential sees a different, explicit slice: nothing leaks between scopes', async () => {
      const list = await get('read-only-other', '/organization/organizations');
      expect(list.body.items.map((o: { id: string }) => o.id)).toEqual([O99]);
      expect((await get('read-only-other', `/organization/organizations/${O1}`)).status).toBe(404);
    });
    it('a Company read is not Platform-scoped: it needs the full-read capability only', async () => {
      expect((await get('auth-service', `/organization/companies/${CO}`)).status).toBe(200);
      expect((await get('payment-service', `/organization/companies/${CO}`)).status).toBe(403);
    });
  });

  describe('provisioning: a dedicated identity, outside Platform scope, and nothing else', () => {
    it('creates a Company (idempotently) and can do nothing else; nobody else can create one', async () => {
      const key = newKey();
      const a = await t.http().post('/organization/companies').set(as('provisioning')).set('Idempotency-Key', key).send({ name: 'Second Co' });
      expect(a.status).toBe(201);
      const b = await t.http().post('/organization/companies').set(as('provisioning')).set('Idempotency-Key', key).send({ name: 'Second Co' });
      expect(b.status).toBe(200);
      expect(b.body.id).toBe(a.body.id);
      for (const caller of CALLERS.filter((c) => c !== 'provisioning')) {
        expect((await t.http().post('/organization/companies').set(as(caller)).set('Idempotency-Key', newKey()).send({ name: 'Rogue' })).status, caller).toBe(403);
      }
      for (const path of ['/organization/companies', `/organization/companies/${CO}`, '/organization/platforms', `/organization/organizations/${O1}`, `/organization/reference/organizations/${O1}`]) {
        expect((await get('provisioning', path)).status, path).toBe(403);
      }
    });
    it('is audited: the caller is recorded in the log line of the creation', async () => {
      expect(JSON.stringify(t.logs)).toMatch(/company_created id=[0-9a-f-]+ caller=provisioning/);
    });
  });

  describe('authentication is separate and unchanged: an invalid, unregistered or revoked credential is the same generic 401', () => {
    it('no credential, a wrong token and a user JWT are 401 before any policy runs', async () => {
      for (const h of [{}, bearer('not-a-registered-token-000000000000000000'), bearer('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig')]) {
        expect((await t.http().get(`/organization/reference/organizations/${O17}`).set(h)).status).toBe(401);
      }
    });
    it('a revoked credential (its digest removed from the configuration, then a restart) stops working', async () => {
      const revoked = t.callers['payment-service']!;
      const t2 = await createTestApp({ databaseUrl: db.url, callers: ['billing-service', 'provisioning'], policy: JSON.stringify({ callers: { 'billing-service': { capabilities: ['hierarchy.reference.read'], allowedPlatforms: [] }, provisioning: { capabilities: ['hierarchy.provision'] } } }) });
      try {
        expect((await t2.http().get(`/organization/reference/organizations/${O17}`).set(bearer(revoked))).status).toBe(401);
      } finally {
        await t2.app.close();
      }
    });
    it('a policy that leaves a registered caller without an entry refuses to build the application (fail closed at startup)', async () => {
      await expect(createTestApp({ databaseUrl: db.url, callers: ['payment-service', 'auth-service'], policy: JSON.stringify({ callers: { 'payment-service': { capabilities: ['hierarchy.reference.read'], allowedPlatforms: [] } } }) })).rejects.toThrow(/auth-service/);
    });
  });

  describe('a FRESH environment that is still inactive: the first-Company bootstrap through the API, and nothing else', () => {
    it('lets ONLY the provisioning identity create the first Company, lets Auth read it for `ensure`, and refuses everything else', async () => {
      const fresh = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgsvcfresh');
      try {
        await runMigrations(fresh.url, [kitMigrationsDir, organizationMigrationsDir]);
        await sql(fresh.url, `UPDATE ownership_state SET environment_class = 'fresh'`);
        const t4 = await createTestApp({
          databaseUrl: fresh.url, ownership: 'inactive', callers: ['provisioning', 'auth-service', 'payment-service'],
          policy: JSON.stringify({ callers: { provisioning: { capabilities: ['hierarchy.provision'] }, 'auth-service': { capabilities: ['hierarchy.read'], allowedPlatforms: [] }, 'payment-service': { capabilities: ['hierarchy.reference.read'], allowedPlatforms: [P1] } } }),
        });
        const as4 = (c: string) => bearer(t4.callers[c]!);
        try {
          expect((await t4.http().post('/organization/companies').set(as4('auth-service')).set('Idempotency-Key', newKey()).send({ name: 'x' })).status).toBe(403);
          const first = await t4.http().post('/organization/companies').set(as4('provisioning')).set('Idempotency-Key', newKey()).send({ name: 'First Company' });
          expect(first.status).toBe(201);
          expect((await sql(fresh.url, 'SELECT phase, authoritative FROM ownership_state'))[0]).toEqual({ phase: 'PREPARED', authoritative: false }); // the bootstrap does not activate
          expect((await t4.http().get(`/organization/companies/${first.body.id}`).set(as4('auth-service'))).status).toBe(200); // Auth's `ensure`
          expect((await t4.http().get(`/organization/reference/organizations/${O1}`).set(as4('payment-service'))).status).toBe(409); // Payment waits
          // Nothing else may be written while inactive: no platform, no organization, no rename.
          expect((await t4.http().patch(`/organization/companies/${first.body.id}`).set(as4('provisioning')).send({ name: 'y' })).status).toBe(403);
        } finally {
          await t4.app.close();
        }
      } finally {
        await fresh.drop();
      }
    });
  });

  describe('while not authoritative, reference reads wait for the cutover verification', () => {
    it('refuses Billing\'s and Payment\'s reference reads with 409 in an inactive environment', async () => {
      const inactive = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgsvcinactive');
      try {
        await runMigrations(inactive.url, [kitMigrationsDir, organizationMigrationsDir]);
        const t3 = await createTestApp({ databaseUrl: inactive.url, ownership: 'inactive', callers: ['payment-service'], policy: JSON.stringify({ callers: { 'payment-service': { capabilities: ['hierarchy.reference.read'], allowedPlatforms: [P1] } } }) });
        try {
          const r = await t3.http().get(`/organization/reference/organizations/${O1}`).set(bearer(t3.callers['payment-service']!));
          expect(r.status).toBe(409);
          expect(r.body.code).toBe('not_authoritative');
        } finally {
          await t3.app.close();
        }
      } finally {
        await inactive.drop();
      }
    });
  });
});
