import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateAuditPayload } from '@nawara/audit-contract';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../src/app.module.js';
import { CleanupWorker } from '../src/cleanup/cleanup.worker.js';
import { TicketRepository } from '../src/persistence/ticket.repository.js';
import { TicketLeases } from '../src/tickets/ticket-leases.js';
import { ALL_LOGS, createTestApp, TEST_STORAGE_ROOT, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { newToken, Sql } from './support/fixtures.js';
import { SAMPLES } from './support/media.js';

const PDF = ['application/pdf'];
const POLICY = {
  callers: {
    'core-drive': {
      operations: ['upload', 'read', 'attach', 'delete', 'issue_ticket', 'grant', 'hold'], organizations: 'request', mediaTypes: PDF, maxBytes: 1024 * 1024,
      grantPurposes: ['dispute_evidence'],
    },
    'payment-service': { operations: ['read_granted'], organizations: 'none', readPurposes: ['dispute_evidence'] },
  },
};

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const binary = (res: request.Response, cb: (e: Error | null, b: Buffer) => void) => {
  const parts: Buffer[] = [];
  res.on('data', (c: Buffer) => parts.push(c));
  res.on('end', () => cb(null, Buffer.concat(parts)));
};
type Row = { redemption: string | null; useCount: number; usedAt: Date | null; leaseId: string | null; leaseUntil: Date | null; expiresAt: Date; revokedAt: Date | null };

/**
 * Core V2 S2-File.4 (register FIL-07; OD-FILE F5): the reservation lease of single-use download tickets, on the REAL application (real
 * PostgreSQL, the filesystem store, injected storage and database faults): one reservation at a time; committed on a completely written
 * response; released ONLY when nothing was sent; otherwise (bytes may have left, a crash, a lost settlement) consumed as `uncertain` and
 * never reusable; the settling sweep; grants, revocation, deletion and holds; reusable tickets unchanged.
 */
describeWithEnv('single-use ticket reservation leases (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let s: Sql;
  const drive = generateServiceToken();
  const payment = generateServiceToken();
  const tokens = [{ caller: 'core-drive', digest: drive.digest }, { caller: 'payment-service', digest: payment.digest }];
  const server = () => t.app.getHttpServer();
  const auth = (tok: { token: string }) => ({ authorization: `Bearer ${tok.token}` });

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'fileleases');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, tokens, policy: JSON.stringify(POLICY), env: { FILE_TICKET_FAILURE_LIMIT: '1000' } });
    await t.app.listen(0, '127.0.0.1');
    s = await Sql.connect(db.url);
  });
  afterAll(async () => {
    await s?.end();
    await t?.app.close();
    await db?.drop();
  });

  async function uploaded(bytes = SAMPLES.pdf(3000)): Promise<{ id: string; bytes: Buffer }> {
    const r = await request(server()).post('/file/files').set({ ...auth(drive), 'idempotency-key': randomUUID(), 'x-attach': 'true' }).send(bytes);
    expect(r.status).toBe(201);
    return { id: r.body.id as string, bytes };
  }
  const issue = async (id: string, singleUse = true) => {
    const r = await request(server()).post(`/file/files/${id}/tickets`).set(auth(drive)).send({ operation: 'download', singleUse });
    expect(r.status).toBe(201);
    return r.body as { ticketId: string; url: string };
  };
  const path = (url: string) => new URL(url).pathname;
  const redeem = (url: string, srv = server()) => request(srv).get(path(url)).buffer(true).parse(binary);
  const code = (r: { body: unknown }) => (Buffer.isBuffer(r.body) ? (JSON.parse(r.body.toString('utf8')) as { code: string }).code : (r.body as { code: string }).code);
  const row = async (ticketId: string) => (await s.query<Row>('SELECT redemption, "useCount", "usedAt", "leaseId", "leaseUntil", "expiresAt", "revokedAt" FROM file_access_ticket WHERE id = $1', [ticketId]))[0]!;
  const objectPath = async (fileId: string) => join(TEST_STORAGE_ROOT, (await s.query<{ storageKey: string }>('SELECT "storageKey" FROM file WHERE id = $1', [fileId]))[0]!.storageKey);
  /** A reservation as another process mid-transfer (or a crashed one) leaves it: the lease ends at `until` seconds from now. */
  const reserve = (ticketId: string, until: number) =>
    s.query(`UPDATE file_access_ticket SET redemption = 'reserved', "leaseId" = gen_random_uuid(), "leaseUntil" = now() + make_interval(secs => $2) WHERE id = $1`, [ticketId, until]);
  async function grantTicket(): Promise<{ grantId: string; fileId: string; ticketId: string; url: string }> {
    const f = await uploaded();
    const g = await request(server()).post(`/file/files/${f.id}/evidence-grants`).set({ ...auth(drive), 'idempotency-key': randomUUID() }).send({ purpose: 'dispute_evidence', caseRef: randomUUID() });
    const tk = await request(server()).post(`/file/evidence-grants/${g.body.grantId}/files/${f.id}/tickets`).set(auth(payment)).send({ operation: 'download', singleUse: true });
    expect(tk.status).toBe(201);
    return { grantId: g.body.grantId as string, fileId: f.id, ticketId: tk.body.ticketId as string, url: tk.body.url as string };
  }
  const accesses = async (grantId: string) =>
    (await s.query<{ payload: Record<string, any> }>(`SELECT payload FROM outbox WHERE name = 'audit.file.granted_read' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt", id`, [grantId]))
      .map((r) => r.payload);

  // ───────────────────────────────────────────────────────────────────────────────────────────────── the lifecycle

  describe('reserve, then settle', () => {
    it('a completed transfer commits: the ticket is consumed for good (a retry meets it settling, 409, then consumed, 404)', async () => {
      const f = await uploaded();
      const tk = await issue(f.id);
      const before = Date.now();
      const r = await redeem(tk.url);
      expect(r.status).toBe(200);
      expect(sha(r.body as Buffer)).toBe(sha(f.bytes));
      expect(['ticket_in_use', 'ticket_invalid']).toContain(code(await redeem(tk.url))); // the settlement follows the response
      await waitFor(async () => (await row(tk.ticketId)).redemption === 'committed');
      const after = await row(tk.ticketId);
      expect(after).toMatchObject({ redemption: 'committed', useCount: 1, usedAt: expect.any(Date), leaseId: expect.any(String) });
      expect(after.leaseUntil!.getTime()).toBeLessThanOrEqual(before + 61_000); // 60 s, never more
      expect(after.leaseUntil!.getTime()).toBeLessThanOrEqual(after.expiresAt.getTime());
      expect(code(await redeem(tk.url))).toBe('ticket_invalid');
    });

    it('a lease never outlives its ticket: a ticket ending in 20 s gets a 20 s lease, not 60', async () => {
      const f = await uploaded();
      const tok = newToken();
      const [tk] = await s.query<{ id: string }>(`INSERT INTO file_access_ticket (id, operation, "fileId", "issuedBy", "tokenDigest", disposition, "singleUse", "createdAt", "expiresAt")
        VALUES ($1, 'download', $2, 'core-drive', $3, 'attachment', true, now() - interval '50 seconds', now() + interval '20 seconds') RETURNING id`, [randomUUID(), f.id, tok.digest]);
      expect((await redeem(`https://x.invalid/file/t/${tok.token}`)).status).toBe(200);
      const r = await row(tk!.id);
      expect(r.leaseUntil!.getTime()).toBe(r.expiresAt.getTime());
    });

    it('a failure BEFORE anything was sent releases the reservation: the same link works once the cause is gone', async () => {
      const f = await uploaded();
      const tk = await issue(f.id);
      const p = await objectPath(f.id);
      renameSync(p, `${p}.away`);
      try {
        const r = await redeem(tk.url);
        expect([r.status, code(r)]).toEqual([500, 'file_content_missing']);
      } finally {
        renameSync(`${p}.away`, p);
      }
      expect(await row(tk.ticketId)).toMatchObject({ redemption: null, useCount: 0, leaseId: null, leaseUntil: null });
      const again = await redeem(tk.url);
      expect(again.status).toBe(200);
      expect(sha(again.body as Buffer)).toBe(sha(f.bytes));
      await waitFor(async () => (await row(tk.ticketId)).redemption === 'committed');
    });

    it('a stream cut AFTER bytes left is uncertain: consumed, never reusable (a tampered multi-chunk object)', async () => {
      const f = await uploaded(SAMPLES.pdf(400_000));
      const tk = await issue(f.id);
      const p = await objectPath(f.id);
      const altered = Buffer.from(readFileSync(p));
      altered[10] = altered[10]! ^ 0xff; // same size, wrong digest: found only at the end, after earlier chunks were sent
      chmodSync(p, 0o600);
      writeFileSync(p, altered);
      const r = await redeem(tk.url).catch((e: Error) => e);
      expect(r instanceof Error || (r.body as Buffer).length < 400_000).toBe(true);
      await waitFor(async () => (await row(tk.ticketId)).redemption === 'uncertain');
      expect(await row(tk.ticketId)).toMatchObject({ redemption: 'uncertain', useCount: 1 });
      writeFileSync(p, f.bytes);
      expect(code(await redeem(tk.url))).toBe('ticket_invalid');
    });

    it('a tampered single-chunk object fails before its headers are written: proven unsent, so released', async () => {
      const f = await uploaded(SAMPLES.pdf(2000));
      const tk = await issue(f.id);
      const p = await objectPath(f.id);
      const altered = Buffer.from(readFileSync(p));
      altered[10] = altered[10]! ^ 0xff;
      chmodSync(p, 0o600);
      writeFileSync(p, altered);
      await redeem(tk.url).catch(() => undefined);
      await waitFor(async () => JSON.stringify(ALL_LOGS).includes(`file_ticket_lease_settled ticket=${tk.ticketId} outcome=released`));
      expect(await row(tk.ticketId)).toMatchObject({ redemption: null, useCount: 0, leaseId: null });
      writeFileSync(p, f.bytes);
      expect((await redeem(tk.url)).status).toBe(200);
    });

    it('a client that disconnects mid-transfer never gets a second redemption (uncertain, or committed if every byte was already written)', async () => {
      const f = await uploaded(SAMPLES.pdf(900_000));
      const tk = await issue(f.id);
      const { port } = (server().address() as AddressInfo);
      await new Promise<void>((resolve) => {
        const req = httpGet({ host: '127.0.0.1', port, path: path(tk.url) }, (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        });
        req.on('error', () => resolve());
      });
      await waitFor(async () => ['uncertain', 'committed'].includes((await row(tk.ticketId)).redemption ?? ''));
      expect((await row(tk.ticketId)).useCount).toBe(1);
      expect(code(await redeem(tk.url))).toBe('ticket_invalid');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────── concurrency and recovery

  describe('concurrency and recovery', () => {
    it('one reservation at a time: concurrent redemptions give ONE transfer; the others meet it in progress (409) or consumed (404)', async () => {
      const f = await uploaded(SAMPLES.pdf(200_000));
      const tk = await issue(f.id);
      const results = await Promise.all(Array.from({ length: 10 }, () => redeem(tk.url)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status !== 200).every((r) => (r.status === 409 && code(r) === 'ticket_in_use') || (r.status === 404 && code(r) === 'ticket_invalid'))).toBe(true);
      expect(await row(tk.ticketId)).toMatchObject({ redemption: 'committed', useCount: 1 });
    });

    it('a reservation in progress elsewhere is 409 ticket_in_use, consumes nothing and is not a failed redemption', async () => {
      const f = await uploaded();
      const tk = await issue(f.id);
      await reserve(tk.ticketId, 30);
      const before = await row(tk.ticketId);
      for (let i = 0; i < 3; i++) expect(await redeem(tk.url).then((r) => [r.status, code(r)])).toEqual([409, 'ticket_in_use']);
      expect(await row(tk.ticketId)).toEqual(before);
    });

    it('a crashed process (a lease run out unsettled) is never returned to the pool: the next redemption settles it uncertain, 404', async () => {
      const f = await uploaded();
      const tk = await issue(f.id);
      await reserve(tk.ticketId, -1);
      expect(code(await redeem(tk.url))).toBe('ticket_invalid');
      expect(await row(tk.ticketId)).toMatchObject({ redemption: 'uncertain', useCount: 1 });
    });

    it('the settling sweep (the cleanup pass) settles runaway reservations uncertain, and records it for a grant ticket', async () => {
      const f = await uploaded();
      const tk = await issue(f.id);
      const g = await grantTicket();
      await reserve(tk.ticketId, -1);
      await reserve(g.ticketId, -1);
      const pass = await t.app.get(CleanupWorker).runOnce();
      expect(pass.leasesSettled).toBeGreaterThanOrEqual(2);
      expect((await row(tk.ticketId)).redemption).toBe('uncertain');
      expect((await row(g.ticketId)).redemption).toBe('uncertain');
      const last = (await accesses(g.grantId)).at(-1)!;
      expect(last).toMatchObject({ actor: { type: 'system', id: 'file_granted_ticket_redemption' }, changes: { access: 'ticket_redemption_uncertain' } });
      expect(() => validateAuditPayload(last, 'file-service')).not.toThrow();
    });

    it('a lost settlement (the commit write fails) never reopens the ticket: in progress until the lease runs out, then uncertain', async () => {
      const short = await createTestApp({ databaseUrl: db.url, tokens, policy: JSON.stringify(POLICY), env: { FILE_TICKET_LEASE_SECONDS: '10', FILE_TICKET_FAILURE_LIMIT: '1000' } });
      try {
        const f = await uploaded();
        const tk = await issue(f.id);
        await s.query(`CREATE OR REPLACE FUNCTION s2f4_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'commit refused (test)'; END $$;
                       CREATE TRIGGER s2f4_refuse BEFORE UPDATE ON file_access_ticket FOR EACH ROW WHEN (NEW.redemption = 'committed') EXECUTE FUNCTION s2f4_refuse()`);
        try {
          const r = await redeem(tk.url, short.app.getHttpServer());
          expect(r.status).toBe(200); // the bytes were sent: the settlement failing does not change the response
          expect(sha(r.body as Buffer)).toBe(sha(f.bytes));
          await waitFor(async () => JSON.stringify(ALL_LOGS).includes(`file_ticket_lease_settle_failed ticket=${tk.ticketId} outcome=committed`));
          expect((await row(tk.ticketId)).redemption).toBe('reserved');
          expect(code(await redeem(tk.url, short.app.getHttpServer()))).toBe('ticket_in_use');
        } finally {
          await s.query('DROP TRIGGER IF EXISTS s2f4_refuse ON file_access_ticket');
        }
        await new Promise((r) => setTimeout(r, 10_500));
        expect(code(await redeem(tk.url, short.app.getHttpServer()))).toBe('ticket_invalid');
        expect(await row(tk.ticketId)).toMatchObject({ redemption: 'uncertain', useCount: 1 });
      } finally {
        await short.app.close();
      }
    }, 30_000);

    it('a settlement for another lease, or a repeated one, changes nothing', async () => {
      const f = await uploaded();
      const tk = await issue(f.id);
      await reserve(tk.ticketId, 30);
      const leases = t.app.get(TicketLeases);
      expect(await leases.settle(tk.ticketId, randomUUID(), 'released')).toBe(false);
      const { leaseId } = await row(tk.ticketId);
      expect(await leases.settle(tk.ticketId, leaseId!, 'uncertain')).toBe(true);
      expect(await leases.settle(tk.ticketId, leaseId!, 'released')).toBe(false); // never back to unused once uncertain
      expect(await leases.settle(tk.ticketId, leaseId!, 'committed')).toBe(true); // the same lease finished after all
      expect(await leases.settle(tk.ticketId, leaseId!, 'uncertain')).toBe(false);
      expect(await row(tk.ticketId)).toMatchObject({ redemption: 'committed', useCount: 1 });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────── grants, revocation, deletion, holds

  describe('grants, revocation, deletion and holds', () => {
    it('a single-use grant ticket: authorized, then committed, both recorded; a released one records the release', async () => {
      const g = await grantTicket();
      expect((await redeem(g.url)).status).toBe(200);
      await waitFor(async () => (await row(g.ticketId)).redemption === 'committed');
      expect((await accesses(g.grantId)).map((p) => p.changes.access)).toEqual(['ticket_issued', 'ticket_redemption_authorized', 'ticket_redemption_committed']);
      const h = await grantTicket();
      const p = await objectPath(h.fileId);
      renameSync(p, `${p}.away`);
      try {
        await redeem(h.url);
      } finally {
        renameSync(`${p}.away`, p);
      }
      const recs = await accesses(h.grantId);
      expect(recs.map((x) => x.changes.access)).toEqual(['ticket_issued', 'ticket_redemption_authorized', 'ticket_redemption_released']); // released before the 500 answer
      for (const x of recs) expect(() => validateAuditPayload(x, 'file-service')).not.toThrow();
    });

    it('revoking the grant during a reservation: no new reservation; the reservation in progress may still settle (it was authorized)', async () => {
      const g = await grantTicket();
      await reserve(g.ticketId, 30);
      const { leaseId } = await row(g.ticketId);
      expect((await request(server()).post(`/file/evidence-grants/${g.grantId}/revoke`).set(auth(drive)).send()).status).toBe(200);
      expect((await row(g.ticketId)).revokedAt).not.toBeNull();
      expect(await t.app.get(TicketLeases).settle(g.ticketId, leaseId!, 'committed')).toBe(true);
      expect(code(await redeem(g.url))).toBe('ticket_invalid');
      // a released reservation of a revoked ticket is unused again, and still refused
      const h = await grantTicket();
      await reserve(h.ticketId, 30);
      const lease = (await row(h.ticketId)).leaseId!;
      await request(server()).post(`/file/evidence-grants/${h.grantId}/revoke`).set(auth(drive)).send();
      expect(await t.app.get(TicketLeases).settle(h.ticketId, lease, 'released')).toBe(true);
      expect(code(await redeem(h.url))).toBe('ticket_invalid');
    });

    it('a reservation never blocks a deletion: the file is deleted, the ticket revoked, nothing more is served', async () => {
      const f = await uploaded();
      const tk = await issue(f.id);
      await reserve(tk.ticketId, 30);
      expect((await request(server()).delete(`/file/files/${f.id}`).set(auth(drive))).status).toBe(202);
      expect((await row(tk.ticketId)).revokedAt).not.toBeNull();
      expect(code(await redeem(tk.url))).toBe('ticket_in_use'); // the reservation is still in progress; it can only settle
    });

    it('a held file serves its single-use ticket as usual; the hold still blocks the deletion', async () => {
      const f = await uploaded();
      await request(server()).post(`/file/files/${f.id}/holds`).set(auth(drive)).send({ holdRef: randomUUID() });
      const tk = await issue(f.id);
      expect((await redeem(tk.url)).status).toBe(200);
      await waitFor(async () => (await row(tk.ticketId)).redemption === 'committed');
      expect((await request(server()).delete(`/file/files/${f.id}`).set(auth(drive))).body.code).toBe('file_held');
    });

    it('reservations are per ticket: one in progress never touches another ticket of the same file; reusable tickets are unchanged', async () => {
      const f = await uploaded();
      const a = await issue(f.id);
      const b = await issue(f.id);
      await reserve(a.ticketId, 30);
      expect((await redeem(b.url)).status).toBe(200);
      const multi = await issue(f.id, false);
      expect((await redeem(multi.url)).status).toBe(200);
      expect((await redeem(multi.url)).status).toBe(200);
      expect(await row(multi.ticketId)).toMatchObject({ redemption: null, useCount: 2, leaseId: null });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────── the schema on its own

  describe('the schema', () => {
    async function refused(text: string, params: unknown[]): Promise<string> {
      try {
        await s.query(text, params);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error(`accepted: ${text}`);
    }

    it('the state machine: only the drawn transitions; a lease never changes; settled states count the one use', async () => {
      const f = await uploaded();
      const tk = await issue(f.id);
      expect(await refused(`UPDATE file_access_ticket SET redemption = 'committed', "leaseId" = gen_random_uuid(), "leaseUntil" = now(), "useCount" = 1, "usedAt" = now() WHERE id = $1`, [tk.ticketId]))
        .toMatch(/cannot become committed/);
      await reserve(tk.ticketId, 30);
      expect(await refused(`UPDATE file_access_ticket SET "leaseUntil" = "leaseUntil" + interval '1 minute' WHERE id = $1`, [tk.ticketId])).toMatch(/lease never changes/);
      expect(await refused(`UPDATE file_access_ticket SET redemption = 'committed' WHERE id = $1`, [tk.ticketId])).toMatch(/redemption_shape/);
      await s.query(`UPDATE file_access_ticket SET redemption = 'committed', "useCount" = 1, "usedAt" = now() WHERE id = $1`, [tk.ticketId]);
      expect(await refused(`UPDATE file_access_ticket SET redemption = NULL, "leaseId" = NULL, "leaseUntil" = NULL WHERE id = $1`, [tk.ticketId])).toMatch(/cannot become unused/);
      expect(await refused(`UPDATE file_access_ticket SET redemption = 'uncertain' WHERE id = $1`, [tk.ticketId])).toMatch(/cannot become uncertain/);
    });

    it('only a valid, unused, single-use download ticket is ever reserved; a ticket is created unused', async () => {
      const f = await uploaded();
      const multi = await issue(f.id, false);
      expect(await refused(`UPDATE file_access_ticket SET redemption = 'reserved', "leaseId" = gen_random_uuid(), "leaseUntil" = now() WHERE id = $1`, [multi.ticketId]))
        .toMatch(/single_use_download/);
      const revoked = await issue(f.id);
      await request(server()).delete(`/file/tickets/${revoked.ticketId}`).set(auth(drive));
      expect(await refused(`UPDATE file_access_ticket SET redemption = 'reserved', "leaseId" = gen_random_uuid(), "leaseUntil" = now() WHERE id = $1`, [revoked.ticketId]))
        .toMatch(/not usable/);
      expect(await refused(`INSERT INTO file_access_ticket (id, operation, "fileId", "issuedBy", "tokenDigest", disposition, "singleUse", "expiresAt", redemption, "leaseId", "leaseUntil")
        VALUES ($1, 'download', $2, 'core-drive', $3, 'attachment', true, now() + interval '2 minutes', 'reserved', gen_random_uuid(), now())`, [randomUUID(), f.id, randomBytes(32).toString('hex')]))
        .toMatch(/created unused/);
    });

    it('the retention purge never removes a reservation still open (only once it settled)', async () => {
      const f = await uploaded();
      const tok = newToken();
      const [tk] = await s.query<{ id: string }>(`INSERT INTO file_access_ticket (id, operation, "fileId", "issuedBy", "tokenDigest", disposition, "singleUse", "createdAt", "expiresAt")
        VALUES ($1, 'download', $2, 'core-drive', $3, 'attachment', true, now() - interval '61 seconds', now() + interval '2 seconds') RETURNING id`, [randomUUID(), f.id, tok.digest]);
      await reserve(tk!.id, 1);
      await new Promise((r) => setTimeout(r, 2_100)); // the ticket and its lease have both ended, unsettled
      const tickets = t.app.get(TicketRepository);
      await tickets.purgeExpired(0, 1_000);
      expect((await row(tk!.id)).redemption).toBe('reserved'); // still there: kept until settled
      await t.app.get(TicketLeases).settleExpired(100);
      expect((await row(tk!.id)).redemption).toBe('uncertain');
      await tickets.purgeExpired(0, 1_000);
      expect(await s.query('SELECT 1 FROM file_access_ticket WHERE id = $1', [tk!.id])).toEqual([]);
    });
  });

  it('never a token, URL or byte in a log line', async () => {
    const f = await uploaded();
    const tk = await issue(f.id);
    await redeem(tk.url);
    await waitFor(async () => (await row(tk.ticketId)).redemption === 'committed');
    const token = path(tk.url).split('/').pop()!;
    const logs = JSON.stringify(ALL_LOGS);
    expect(logs).not.toContain(token);
    expect(logs).toContain(`file_ticket_lease_settled ticket=${tk.ticketId} outcome=committed`);
  });
});

async function waitFor(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
}
