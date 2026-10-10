import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BrokerProxy } from '@nawara/service-kit/testing';
import { AuditService } from '../src/audit/audit.service.js';
import type { AppConfig } from '../src/config/app-config.js';
import { DbService } from '../src/db/db.service.js';
import { ChallengeService } from '../src/owner/challenge.service.js';
import { FactorService } from '../src/owner/factor.service.js';
import { SecretKeyService } from '../src/owner/secret-key.service.js';
import { StepUpService } from '../src/owner/step-up.service.js';
import { ThrottleService } from '../src/throttle/throttle.service.js';
import { bearer, claims, createTestApp, type TestCtx, type Tokens } from './helpers/app.js';

/**
 * A5.4-A3 slice A (ADR-0061 §4 step 3; ADR-0065 §5, S2; the A3 design §6 and §11.5, O8): `StepUpService.consumeForReferenceRepair`.
 *
 * One autocommit statement consumes a reference-repair proof, and the method says what it KNOWS afterwards:
 * consumed, rejected, not_consumed (the database itself reported the failure) or uncertain (everything else).
 *
 * Every case runs against a real PostgreSQL, and the stored `consumedAt` is read back wherever the database can show what happened.
 * Failures are provoked for real: a row lock with the server's statement timeout, `pg_cancel_backend`, `pg_terminate_backend`, and a TCP
 * relay that stalls or cuts the connection. Nothing here calls a route: slice A adds no caller.
 */
const PURPOSE = 'hierarchy.reference.repair';
const uniq = () => randomUUID().slice(0, 8);
type Owner = Awaited<ReturnType<TestCtx['readyOwner']>>;

describe('A5.4-A3 slice A: reference-repair proof consumption (real PostgreSQL)', () => {
  let t: TestCtx;
  let stepUp: StepUpService;
  let dbUrl: string;
  let proxy: BrokerProxy;
  let viaProxy: string;
  const services: DbService[] = [];

  const who = (tokens: Tokens) => {
    const c = claims(tokens) as { sub: string; sid: string };
    return { ownerId: c.sub, sid: c.sid };
  };
  const owner = async (): Promise<Owner> => t.readyOwner(await t.newCompany(), `rp${uniq()}@a.test`);
  const proofFor = (o: Owner, purpose = PURPOSE) => t.stepUpToken(o.tokens, purpose, o.totpSecret);
  const consumedAt = async (id: string): Promise<Date | null> => (await t.db.query(`SELECT "consumedAt" FROM owner_step_up WHERE id=$1`, [id])).rows[0].consumedAt;
  const counts = async () => (await t.db.query(
    `SELECT (SELECT count(*) FROM auth_audit_event WHERE type LIKE 'hierarchy.%')::int AS local,
            (SELECT count(*) FROM outbox WHERE name LIKE 'audit.hierarchy.%')::int AS central,
            (SELECT count(*) FROM owner_step_up WHERE "consumedAt" IS NOT NULL)::int AS consumed`)).rows[0] as { local: number; central: number; consumed: number };

  /** A DbService of its own (its own pool and timeouts), directly to the database or through the relay. */
  const database = (url: string, db: Partial<AppConfig['db']>) => {
    const cfg = { databaseUrl: url, db: { poolMax: 1, connectionTimeoutMs: 5000, statementTimeoutMs: 30_000, idleInTransactionTimeoutMs: 60_000, ...db } } as AppConfig;
    const s = new DbService(cfg);
    services.push(s);
    return s;
  };
  /** What the database client actually threw from `query`, as the method under test received it. */
  const observe = (db: DbService) => {
    const seen: Array<{ severity?: string; code?: string; message: string }> = [];
    const real = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation(((sql: string, params?: unknown[]) => real(sql, params).catch((e: { severity?: string; code?: string; message: string }) => {
      seen.push({ severity: e.severity, code: e.code, message: e.message });
      throw e;
    })) as never);
    return seen;
  };
  /** The same StepUpService, over another DbService: only the database connection differs. */
  const stepUpOver = (db: DbService) => new StepUpService(db, t.cfg, t.clock, t.app.get(ThrottleService), t.app.get(FactorService),
    t.app.get(SecretKeyService), t.app.get(ChallengeService), t.app.get(AuditService));

  /** Another session holds the proof's row lock: the consume statement waits behind it until `release()`. */
  const lockRow = async (id: string) => {
    const c = new pg.Client({ connectionString: dbUrl });
    await c.connect();
    await c.query('BEGIN');
    await c.query('SELECT 1 FROM owner_step_up WHERE id=$1 FOR UPDATE', [id]);
    return { release: async () => { await c.query('ROLLBACK'); await c.end(); } };
  };
  const admin = async (sql: string, params?: unknown[]) => {
    const c = new pg.Client({ connectionString: dbUrl });
    await c.connect();
    try {
      return (await c.query(sql, params)).rows;
    } finally {
      await c.end();
    }
  };
  /** The backend that is running the consume statement and waiting for the row lock. */
  const waitingBackend = async (): Promise<number> => {
    for (let i = 0; i < 100; i += 1) {
      const rows = await admin(`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'UPDATE owner_step_up SET "consumedAt"%'`);
      if (rows[0]) return rows[0].pid as number;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the consume statement never reached the row lock');
  };
  /** Until no backend is still running a consume statement (a statement the client gave up on may still finish on the server). */
  const settled = async () => {
    for (let i = 0; i < 200; i += 1) {
      const rows = await admin(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND state <> 'idle' AND query LIKE 'UPDATE owner_step_up SET "consumedAt"%'`);
      if (!rows[0]) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('a consume statement is still running');
  };

  beforeAll(async () => {
    t = await createTestApp();
    stepUp = t.app.get(StepUpService);
    dbUrl = (t.env as { DATABASE_URL: string }).DATABASE_URL;
    const u = new URL(dbUrl);
    proxy = new BrokerProxy({ host: u.hostname === 'localhost' ? '127.0.0.1' : u.hostname, port: Number(u.port || 5432) });
    await proxy.start();
    u.hostname = '127.0.0.1';
    u.port = String(proxy.port);
    viaProxy = u.toString();
  });
  afterEach(() => { vi.restoreAllMocks(); proxy.thaw(); });
  afterAll(async () => {
    proxy.thaw();
    for (const s of services) await s.onApplicationShutdown().catch(() => undefined);
    await proxy.sever();
    await t.close();
  });

  describe('confirmed consumption, and invalid or rejected proofs', () => {
    it('a valid proof is consumed once: `consumed`, then `rejected`; the row is stamped once and nothing else is written', async () => {
      const o = await owner();
      const proof = await proofFor(o);
      const before = await counts();
      expect(await consumedAt(proof)).toBeNull();

      expect(await stepUp.consumeForReferenceRepair({ ...who(o.tokens), token: proof })).toBe('consumed');
      const stamped = await consumedAt(proof);
      expect(stamped).toBeInstanceOf(Date);

      expect(await stepUp.consumeForReferenceRepair({ ...who(o.tokens), token: proof })).toBe('rejected'); // already consumed
      expect((await consumedAt(proof))!.getTime()).toBe(stamped!.getTime()); // never re-stamped
      // it records nothing (no local audit, no central intent): the caller owns the evidence. Exactly one more consumed proof exists.
      expect(await counts()).toEqual({ ...before, consumed: before.consumed + 1 });
    });

    it('no statement is sent for an absent or malformed proof; an unknown proof is `rejected`', async () => {
      const o = await owner();
      const query = vi.spyOn(t.dbs, 'query');
      for (const token of [undefined, '', 'not-a-uuid', `${randomUUID()}x`, "' OR 1=1 --"]) {
        expect(await stepUp.consumeForReferenceRepair({ ...who(o.tokens), token })).toBe('rejected');
      }
      expect(query).not.toHaveBeenCalled();
      expect(await stepUp.consumeForReferenceRepair({ ...who(o.tokens), token: randomUUID() })).toBe('rejected');
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('an expired proof is `rejected` and stays unconsumed', async () => {
      const o = await owner();
      const proof = await proofFor(o);
      t.clock.advance((t.cfg.stepUp.ttlSec + 5) * 1000);
      expect(await stepUp.consumeForReferenceRepair({ ...who(o.tokens), token: proof })).toBe('rejected');
      expect(await consumedAt(proof)).toBeNull();
    });

    it('bound to its owner and to its session: another owner, or another session of the same owner, is `rejected` and burns nothing', async () => {
      const o = await owner();
      const other = await owner();
      const proof = await proofFor(o);
      expect(await stepUp.consumeForReferenceRepair({ ...who(other.tokens), token: proof })).toBe('rejected');
      expect(await stepUp.consumeForReferenceRepair({ ownerId: who(o.tokens).ownerId, sid: who(other.tokens).sid, token: proof })).toBe('rejected');
      // each binding on its own: the right session with another owner, and (above) the right owner with another session
      expect(await stepUp.consumeForReferenceRepair({ ownerId: who(other.tokens).ownerId, sid: who(o.tokens).sid, token: proof })).toBe('rejected');
      const otherSession = await t.ownerLogin({ email: o.email, password: o.password }, o.totpSecret);
      expect(who(otherSession).ownerId).toBe(who(o.tokens).ownerId);
      expect(await stepUp.consumeForReferenceRepair({ ...who(otherSession), token: proof })).toBe('rejected');
      expect(await consumedAt(proof)).toBeNull();
      expect(await stepUp.consumeForReferenceRepair({ ...who(o.tokens), token: proof })).toBe('consumed'); // still good for its owner and session
    });

    it('bound to its purpose: a proof for another purpose is `rejected`, is not burned, and still works for its own purpose', async () => {
      const o = await owner();
      const create = await proofFor(o, 'organization.create');
      expect(await stepUp.consumeForReferenceRepair({ ...who(o.tokens), token: create })).toBe('rejected');
      expect(await consumedAt(create)).toBeNull();
      await t.http.post('/auth/step-up/verify').set(bearer(o.tokens)).send({ purpose: 'organization.create', stepUpToken: create }).expect(204);
    });

    it('bound to an allowed method IN the statement: a secret-key proof for the purpose is `rejected` and NOT consumed', async () => {
      const o = await owner();
      const id = randomUUID();
      const now = t.clock.now();
      // Such a row cannot be issued (the purpose is factor-only); it is inserted directly to prove the statement itself refuses it.
      await t.db.query(
        `INSERT INTO owner_step_up(id,"ownerId",method,"factorId",purpose,"sessionFamilyId","verifiedAt","expiresAt") VALUES ($1,$2,'secret_key',NULL,$3,$4,$5,$6)`,
        [id, who(o.tokens).ownerId, PURPOSE, who(o.tokens).sid, now, new Date(now.getTime() + 60_000)],
      );
      expect(await stepUp.consumeForReferenceRepair({ ...who(o.tokens), token: id })).toBe('rejected');
      expect(await consumedAt(id)).toBeNull();
    });

    it('two simultaneous requests with one proof: exactly one `consumed`, the other `rejected`', async () => {
      const o = await owner();
      const proof = await proofFor(o);
      const lock = await lockRow(proof); // both statements queue behind the same lock, then race for the row
      const a = stepUp.consumeForReferenceRepair({ ...who(o.tokens), token: proof });
      const b = stepUp.consumeForReferenceRepair({ ...who(o.tokens), token: proof });
      await waitingBackend();
      await lock.release();
      expect([await a, await b].sort()).toEqual(['consumed', 'rejected']);
      expect(await consumedAt(proof)).toBeInstanceOf(Date);
    });
  });

  describe('confirmed no consumption: the database itself reports the failure', () => {
    it("the server's own statement timeout (ERROR 57014): `not_consumed`; the row is untouched and the proof still works", async () => {
      const o = await owner();
      const proof = await proofFor(o);
      const db = database(dbUrl, { statementTimeoutMs: 1000, queryTimeoutMs: 20_000 }); // the SERVER gives up first
      const bounded = stepUpOver(db);
      const seen = observe(db);
      const lock = await lockRow(proof);
      const started = Date.now();
      expect(await bounded.consumeForReferenceRepair({ ...who(o.tokens), token: proof })).toBe('not_consumed');
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(seen).toEqual([expect.objectContaining({ severity: 'ERROR', code: '57014' })]); // what PostgreSQL really reported
      await lock.release();
      await settled();
      expect(await consumedAt(proof)).toBeNull(); // observed: nothing was committed
      vi.restoreAllMocks();
      expect(await bounded.consumeForReferenceRepair({ ...who(o.tokens), token: proof })).toBe('consumed'); // the same session is still usable
    }, 30_000);

    it('a statement cancelled on the server (`pg_cancel_backend`, ERROR 57014): `not_consumed`, row untouched', async () => {
      const o = await owner();
      const proof = await proofFor(o);
      const db = database(dbUrl, { statementTimeoutMs: 30_000, queryTimeoutMs: 40_000 });
      const own = stepUpOver(db);
      const seen = observe(db);
      const lock = await lockRow(proof);
      const pending = own.consumeForReferenceRepair({ ...who(o.tokens), token: proof });
      await admin('SELECT pg_cancel_backend($1)', [await waitingBackend()]);
      expect(await pending).toBe('not_consumed');
      expect(seen).toEqual([expect.objectContaining({ severity: 'ERROR', code: '57014' })]);
      await lock.release();
      await settled();
      expect(await consumedAt(proof)).toBeNull();
    }, 30_000);
  });

  describe('uncertain consumption: no proof that nothing was committed', () => {
    it('a terminated session (`pg_terminate_backend`, FATAL 57P01, a report WITH a status code): `uncertain`, never `not_consumed`', async () => {
      const o = await owner();
      const proof = await proofFor(o);
      const db = database(dbUrl, { statementTimeoutMs: 30_000, queryTimeoutMs: 40_000 });
      const own = stepUpOver(db);
      const seen = observe(db);
      const lock = await lockRow(proof);
      const pending = own.consumeForReferenceRepair({ ...who(o.tokens), token: proof });
      await admin('SELECT pg_terminate_backend($1)', [await waitingBackend()]);
      expect(await pending).toBe('uncertain');
      // PostgreSQL did send a report, with a status code; its severity is FATAL, so it proves nothing about the statement
      expect(seen).toEqual([expect.objectContaining({ severity: 'FATAL', code: '57P01' })]);
      await lock.release();
      await settled();
      expect(await consumedAt(proof)).toBeNull(); // here the database shows it was NOT applied; the caller could not know
    }, 30_000);

    it('a lost acknowledgment: the statement IS applied, its answer never arrives, the client deadline fires: `uncertain`, and the proof is in fact consumed', async () => {
      const o = await owner();
      const proof = await proofFor(o);
      const db = database(viaProxy, { statementTimeoutMs: 30_000, queryTimeoutMs: 1500 });
      await db.query('SELECT 1'); // an established connection
      const stalled = stepUpOver(db);
      const seen = observe(db);
      proxy.freeze(); // the statement reaches PostgreSQL; nothing comes back
      const started = Date.now();
      expect(await stalled.consumeForReferenceRepair({ ...who(o.tokens), token: proof })).toBe('uncertain');
      expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.severity).toBeUndefined(); // the client's own deadline: no database report at all
      proxy.thaw();
      await settled();
      expect(await consumedAt(proof)).toBeInstanceOf(Date); // observed: it WAS committed, although the caller only saw a timeout
      expect(await stepUp.consumeForReferenceRepair({ ...who(o.tokens), token: proof })).toBe('rejected'); // re-presenting decides: spent
    }, 30_000);

    it('a client-side deadline while the statement waits on the server: `uncertain`; the statement may still commit AFTER the client gave up', async () => {
      const o = await owner();
      const proof = await proofFor(o);
      const db = database(dbUrl, { statementTimeoutMs: 30_000, queryTimeoutMs: 1500 }); // the CLIENT gives up first
      const impatient = stepUpOver(db);
      const seen = observe(db);
      const lock = await lockRow(proof);
      expect(await impatient.consumeForReferenceRepair({ ...who(o.tokens), token: proof })).toBe('uncertain');
      expect(seen).toHaveLength(1);
      expect(seen[0]!.severity).toBeUndefined();
      expect(await consumedAt(proof)).toBeNull(); // not yet: the statement is still waiting on the server
      await lock.release();
      await settled();
      // Whatever the server did with the abandoned statement, the stored state and a fresh request agree with each other.
      const spent = (await consumedAt(proof)) !== null;
      expect(await stepUp.consumeForReferenceRepair({ ...who(o.tokens), token: proof })).toBe(spent ? 'rejected' : 'consumed');
    }, 30_000);

    it('a connection cut while the statement is in flight: `uncertain`', async () => {
      const o = await owner();
      const proof = await proofFor(o);
      const db = database(viaProxy, { statementTimeoutMs: 30_000, queryTimeoutMs: 20_000 });
      await db.query('SELECT 1');
      const cut = stepUpOver(db);
      const seen = observe(db);
      const lock = await lockRow(proof);
      const pending = cut.consumeForReferenceRepair({ ...who(o.tokens), token: proof });
      await waitingBackend();
      await proxy.sever(); // every socket dies, in both directions
      expect(await pending).toBe('uncertain');
      expect(seen).toHaveLength(1);
      expect(seen[0]!.severity).toBeUndefined(); // a broken connection: no database report
      await proxy.start();
      await lock.release();
      await settled();
      const spent = (await consumedAt(proof)) !== null;
      expect(await stepUp.consumeForReferenceRepair({ ...who(o.tokens), token: proof })).toBe(spent ? 'rejected' : 'consumed');
    }, 30_000);

    it('the answer is lost after the commit (the statement runs for real, then the connection fails): `uncertain`, and the proof is spent', async () => {
      const o = await owner();
      const proof = await proofFor(o);
      const real = t.dbs.query.bind(t.dbs);
      vi.spyOn(t.dbs, 'query').mockImplementationOnce(async (sql: string, params?: unknown[]) => {
        await real(sql, params); // PostgreSQL applied and committed it
        throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
      });
      expect(await stepUp.consumeForReferenceRepair({ ...who(o.tokens), token: proof })).toBe('uncertain');
      expect(await consumedAt(proof)).toBeInstanceOf(Date);
      expect(await stepUp.consumeForReferenceRepair({ ...who(o.tokens), token: proof })).toBe('rejected');
    });
  });

  describe('the classification is narrow: a status code alone never proves that nothing was committed', () => {
    const failing = async (error: unknown) => {
      const o = await owner();
      const proof = await proofFor(o);
      vi.spyOn(t.dbs, 'query').mockRejectedValueOnce(error);
      const outcome = await stepUp.consumeForReferenceRepair({ ...who(o.tokens), token: proof });
      vi.restoreAllMocks();
      expect(await consumedAt(proof)).toBeNull(); // the statement never ran in these cases; only the classification is under test
      return outcome;
    };
    const report = (severity: string | undefined, code: string | undefined) => Object.assign(new Error('database report'), { severity, code });

    it.each([
      ['an ERROR report with an ordinary status code (a check violation)', report('ERROR', '23514'), 'not_consumed'],
      ['an ERROR report: serialization failure', report('ERROR', '40001'), 'not_consumed'],
      ['an ERROR report: query cancelled', report('ERROR', '57014'), 'not_consumed'],
      ['a FATAL report with a status code (administrator shutdown)', report('FATAL', '57P01'), 'uncertain'],
      ['a PANIC report with a status code', report('PANIC', 'XX000'), 'uncertain'],
      ['an ERROR report whose code says completion is unknown', report('ERROR', '40003'), 'uncertain'],
      ['an ERROR report of the connection-exception class', report('ERROR', '08006'), 'uncertain'],
      ['a status code with no severity', report(undefined, '23514'), 'uncertain'],
      ['a severity that is not exactly ERROR (a localized one)', report('ERREUR', '23514'), 'uncertain'],
      ['an ERROR report without a status code', report('ERROR', undefined), 'uncertain'],
      ['an ERROR report with a malformed status code', report('ERROR', 'oops'), 'uncertain'],
      ['a client-side deadline', new Error('Query read timeout'), 'uncertain'],
      ['a socket error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), 'uncertain'],
      ['a value that is not an Error', { severity: 'ERROR', code: '23514' }, 'uncertain'],
      ['nothing at all', undefined, 'uncertain'],
    ])('%s -> %s', async (_name, error, expected) => {
      expect(await failing(error)).toBe(expected);
    });
  });

  describe('slice A adds a method and nothing else', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '../src');
    const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sources(path) : name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
    });

    it('nothing calls it: the method is named in step-up.service.ts only (no route, no repair service, no caller)', () => {
      const named = sources(src).filter((path) => readFileSync(path, 'utf8').includes('consumeForReferenceRepair'));
      expect(named.map((path) => path.slice(src.length + 1))).toEqual(['hierarchy/reference-repair.service.ts', 'owner/step-up.service.ts']);
    });

    it('S1: POST /auth/step-up/verify refuses a repair proof (403 step_up_required) without consuming it; the dedicated consumption then consumes it, once', async () => {
      const o = await owner();
      const proof = await proofFor(o);
      const r = await t.http.post('/auth/step-up/verify').set(bearer(o.tokens)).send({ purpose: PURPOSE, stepUpToken: proof });
      expect([r.status, r.body.code]).toEqual([403, 'step_up_required']);
      expect(await consumedAt(proof)).toBeNull();
      expect(await stepUp.consumeForReferenceRepair({ ...who(o.tokens), token: proof })).toBe('consumed');
      expect(await stepUp.consumeForReferenceRepair({ ...who(o.tokens), token: proof })).toBe('rejected');
    });
  });
});
