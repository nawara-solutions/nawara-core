#!/usr/bin/env node
// Stage 15.7: data growth and log volume campaigns (test-only). Plan, results and decisions: docs/architecture/core-validation.md §13.7.
//
//   node scripts/validation/growth-campaigns.mjs [--out results.json] [campaign ...]      (default: all, in plan order)
//
// Starts its OWN throwaway RabbitMQ and PostgreSQL containers (`validation-*`, loopback) and removes them at the end. Real Billing and
// Payment processes (lib/core-stack.mjs), real Auth and Organization for their probes. Synthetic volume is made by cloning rows the REAL
// flow wrote (so the status mix, sizes and references are the service's own), inside throwaway databases only, with the services
// stopped. Log lines are counted and classified, never printed: payload-bearing fields are not copied into the results.
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import amqp from 'amqplib';
import { describeFailure, inspectDeadLetters, replayDeadLetter } from '../../libs/service-kit/dist/index.js';
import * as h from './lib/harness.mjs';
import { coreStacks } from './lib/core-stack.mjs';
import { liveCore, probe } from './lib/live-core.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('refusing to run with NODE_ENV=production');
const log = (...a) => process.stderr.write(`[15.7] ${a.join(' ')}\n`);
let uncaught = 0;
process.on('uncaughtException', (e) => {
  uncaught++;
  log('UNCAUGHT', describeFailure(e), String(e?.message).slice(0, 160));
});
process.on('unhandledRejection', (e) => {
  uncaught++;
  log('UNHANDLED', describeFailure(e), String(e?.message).slice(0, 160));
});

const rabbit = await h.throwawayRabbit();
const pgc = await h.throwawayPostgres();
const ADMIN = pgc.adminUrl;
log(`throwaway broker ${rabbit.name} :${rabbit.port}, postgres ${pgc.name} :${pgc.port}`);
const stack = coreStacks({ adminUrl: ADMIN, rabbit, pgPort: pgc.port });
const core = liveCore({ adminUrl: ADMIN, rabbit });
const RECONCILE_FAST = { BILLING_RECONCILE_INTERVAL_MS: '2000', BILLING_RECONCILE_STALE_REQUESTED_MS: '5000' }; // test values

const C = {};

// ------------------------------------------------------------------------------------------------ database measurement
/** Runs statements on one client (multi-statement text allowed); returns the last result's rows. */
async function onClient(url, fn) {
  const c = new pg.Client({ connectionString: url, application_name: 'validation-growth' });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const GROWTH_SKIP = /^(validation_|schema_migrations|kit_schema_migrations)/;
/** Rows (exact count) and bytes (heap, indexes, TOAST) of every table of one database. */
async function tableStats(url) {
  const rows = await h.adminQuery(url, `
    SELECT c.relname AS t, pg_relation_size(c.oid) AS heap, pg_indexes_size(c.oid) AS idx, pg_total_relation_size(c.oid) AS total,
           coalesce(pg_total_relation_size(NULLIF(c.reltoastrelid, 0)), 0) AS toast
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname = 'public' ORDER BY 1`);
  const out = {};
  for (const r of rows) {
    if (GROWTH_SKIP.test(r.t)) continue;
    const [{ n }] = await h.adminQuery(url, `SELECT count(*)::int AS n FROM "${r.t}"`);
    out[r.t] = { rows: n, heap: Number(r.heap), idx: Number(r.idx), toast: Number(r.toast), total: Number(r.total) };
  }
  return out;
}
const delta = (a, b) => Object.fromEntries(Object.keys(b).map((t) => [t, { rows: b[t].rows - (a[t]?.rows ?? 0), total: b[t].total - (a[t]?.total ?? 0) }]).filter(([, d]) => d.rows !== 0));
const perOp = (d, n) => Object.fromEntries(Object.entries(d).map(([t, x]) => [t, { rows: h.round(x.rows / n, 2) }]));

/** EXPLAIN (ANALYZE, BUFFERS) run 3 times: median execution time, range, the scan nodes used, buffers. Writes are rolled back. */
async function explain(url, sql) {
  return onClient(url, async (c) => {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      await c.query('BEGIN');
      try {
        const r = await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
        runs.push(r.rows[0]['QUERY PLAN'][0]);
      } finally {
        await c.query('ROLLBACK');
      }
    }
    const nodes = [];
    const walk = (p) => {
      if (/Scan/.test(p['Node Type'])) nodes.push(`${p['Node Type']}${p['Index Name'] ? `(${p['Index Name']})` : ''}${p['Relation Name'] && !p['Index Name'] ? `(${p['Relation Name']})` : ''}`);
      for (const k of p.Plans ?? []) walk(k);
    };
    walk(runs[0].Plan);
    const ms = runs.map((r) => r['Execution Time']);
    const top = runs[2].Plan;
    return { ms: h.stats(ms), scans: [...new Set(nodes)], buffers: (top['Shared Hit Blocks'] ?? 0) + (top['Shared Read Blocks'] ?? 0), rows: top['Actual Rows'] };
  });
}

// The queries the services run on the hot or periodic paths (copied from the code, parameters inlined with representative values).
const QUERIES = {
  payment: {
    outboxClaim: `SELECT id, name, payload, "correlationId", "eventVersion", "occurredAt", attempts FROM outbox WHERE "publishedAt" IS NULL AND "availableAt" <= now() ORDER BY "occurredAt", id LIMIT 50 FOR UPDATE SKIP LOCKED`,
    expirySweeperScan: `SELECT id FROM payment WHERE "expiresAt" IS NOT NULL AND "expiresAt" <= now() AND status IN ('created', 'pending')`,
    attemptResolverScan: `SELECT * FROM payment_attempt WHERE status = 'unknown' OR status = 'initiated' OR (status = 'submitted' AND "submittedAt" < now() - make_interval(secs => 300)) ORDER BY "initiatedAt" LIMIT 100`,
    webhookRetrierScan: `SELECT * FROM webhook_event WHERE state IN ('received', 'processing', 'failed', 'unmatched') AND NOT (state = 'failed' AND outcome IN ('malformed_body', 'retries_exhausted')) AND attempts < 10 AND "receivedAt" <= now() - make_interval(secs => 10 * power(2, LEAST(attempts, 30))) ORDER BY "receivedAt" LIMIT 100`,
    webhookDedupe: (x) => `SELECT id FROM webhook_event WHERE provider = 'test' AND "providerEventId" = '${x.webhookEventId}'`,
    idempotencyLookup: (x) => `SELECT "requestHash", "responseStatus", "resourceId" FROM idempotency_key WHERE caller = '${x.idemCaller}' AND operation = '${x.idemOperation}' AND key = '${x.idemKey}'`,
    paymentById: (x) => `SELECT * FROM payment WHERE id = '${x.paymentId}'`,
    paymentByRequest: (x) => `SELECT id, status FROM payment WHERE producer = 'billing-service' AND "paymentRequestId" = '${x.paymentRequestId}'`,
    expiredIdempotencyKeys: `SELECT count(*) FROM idempotency_key WHERE "expiresAt" <= now()`,
  },
  billing: {
    outboxClaim: `SELECT id, name, payload, "correlationId", "eventVersion", "occurredAt", attempts FROM outbox WHERE "publishedAt" IS NULL AND "availableAt" <= now() ORDER BY "occurredAt", id LIMIT 50 FOR UPDATE SKIP LOCKED`,
    dispatcherClaim: `SELECT * FROM payment_request WHERE status = 'created' OR (status = 'sending' AND "sendingSince" < now() - make_interval(secs => 60)) ORDER BY "createdAt" LIMIT 50 FOR UPDATE SKIP LOCKED`,
    reconcilerScan: `SELECT id, "paymentId", "correlationId", "updatedAt"::text FROM payment_request WHERE status = 'requested' AND "paymentId" IS NOT NULL AND "updatedAt" < now() - make_interval(secs => 60) AND (NULL::timestamptz IS NULL OR ("updatedAt", id) > (NULL::timestamptz, NULL::uuid)) ORDER BY "updatedAt", id LIMIT 50`,
    receiptByEvent: (x) => `SELECT outcome, "detailCode" FROM payment_event_receipt WHERE "eventId" = '${x.eventId}'`,
    receiptsByRequest: (x) => `SELECT * FROM payment_event_receipt WHERE "paymentRequestId" = '${x.requestId}' ORDER BY "receivedAt"`,
    inboxDedupe: (x) => `INSERT INTO inbox("eventId", source, name) VALUES ('${x.eventId}', 'payment-service', 'payment.succeeded') ON CONFLICT ("eventId") DO NOTHING`,
    rateLimitHit: `INSERT INTO kit_rate_limit(bucket, key, "windowStart", count) VALUES ('validation', 'k-${randomUUID()}', now(), 1) ON CONFLICT (bucket, key) DO UPDATE SET count = kit_rate_limit.count + 1 RETURNING count`,
    invoicesOfPayer: (x) => `SELECT * FROM invoice WHERE "payerType" = 'user' AND "payerId" = '${x.payerId}' ORDER BY "createdAt" DESC LIMIT 20`,
    historyOfEntity: (x) => `SELECT * FROM billing_transition WHERE "entityType" = 'payment_request' AND "entityId" = '${x.requestId}' ORDER BY revision`,
    openReceiptsScan: `SELECT count(*) FROM payment_event_receipt WHERE outcome IN ('deferred', 'conflict') AND "receivedAt" < now() - interval '1 minute'`,
    publishedOutboxOlderThan: `SELECT count(*) FROM outbox WHERE "publishedAt" IS NOT NULL AND "publishedAt" < now() - interval '1 hour'`,
  },
  auth: {
    throttleHit: `INSERT INTO auth_throttle(bucket, key, "windowStart", count) VALUES ('login', 'k-${randomUUID()}', now(), 1) ON CONFLICT (bucket, key) DO UPDATE SET count = auth_throttle.count + 1 RETURNING count`,
    throttleExpiredWindows: `SELECT count(*) FROM auth_throttle WHERE "windowStart" < now() - interval '1 hour'`,
    auditOfActor: (x) => `SELECT * FROM auth_audit_event WHERE "actorId" = '${x.actorId}' ORDER BY "occurredAt" DESC LIMIT 50`,
    refreshByHash: (x) => `SELECT * FROM refresh_token WHERE "tokenHash" = '${x.tokenHash}'`,
    expiredRefreshTokens: `SELECT count(*) FROM refresh_token WHERE "expiresAt" < now() OR "revokedAt" IS NOT NULL`,
  },
  organization: {
    idempotencyLookup: (x) => `SELECT "requestHash", "resourceId" FROM idempotency_key WHERE caller = '${x.caller}' AND operation = 'company.create' AND key = '${x.key}'`,
    kitRateLimitExpired: `SELECT count(*) FROM kit_rate_limit WHERE "windowStart" < now() - interval '1 hour'`,
  },
};

/**
 * Columns of `table` for cloning: uuid columns remapped consistently across tables (md5(old || ':' || g), so references still meet),
 * unique text suffixed, times spread back one second per copy. `keep`: uuid columns a CHECK ties to an unchanged text column (tenant).
 */
async function cloneSql(url, table, from, to, { suffix = [], keepTime = [], keep = [] } = {}) {
  const cols = await h.adminQuery(url, `
    SELECT a.attname AS c, format_type(a.atttypid, a.atttypmod) AS ty, a.attidentity AS ident FROM pg_attribute a
     WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '' ORDER BY a.attnum`, [table]);
  const use = cols.filter((c) => c.ident === '');
  const expr = (c) => {
    const q = `t."${c.c}"`;
    if (keep.includes(c.c)) return q;
    if (c.ty === 'uuid') return `CASE WHEN ${q} IS NULL THEN NULL ELSE md5(${q}::text || ':' || g)::uuid END`;
    if (suffix.includes(c.c)) return `CASE WHEN ${q} IS NULL THEN NULL ELSE ${q} || '.' || g END`;
    if (c.ty === 'timestamp with time zone' && !keepTime.includes(c.c)) return `${q} - make_interval(secs => g)`;
    return q;
  };
  return `INSERT INTO "${table}" (${use.map((c) => `"${c.c}"`).join(', ')}) SELECT ${use.map(expr).join(', ')} FROM "validation_tpl_${table}" t CROSS JOIN generate_series(${from}, ${to}) g`;
}
const CLONE = {
  billing: {
    invoice: { suffix: ['number', 'sourceId'], keepTime: ['dueAt'], keep: ['organizationId'] }, invoice_line: { suffix: ['sourceId'] }, payment_request: { suffix: ['correlationId'], keepTime: ['expiresAt'] },
    payment_event_receipt: {}, billing_transition: { suffix: ['correlationId'] }, outbox: { suffix: ['correlationId'] }, inbox: {}, kit_rate_limit: { suffix: ['key'] },
  },
  payment: {
    payment: { suffix: ['sourceId', 'reference'], keepTime: ['expiresAt'], keep: ['organizationId'] }, payment_attempt: { suffix: ['providerTransactionId'] }, outbox: { suffix: ['correlationId'] },
    idempotency_key: { suffix: ['key'] }, inbox: {}, kit_rate_limit: { suffix: ['key'] },
  },
};

C.growth = async () => {
  // Part 1: rows and bytes per business operation, through the REAL flow (paid lifecycle, cancelled lifecycle, open request).
  // Part 2: those rows cloned to 1k / 10k / 50k / 100k lifecycles (same mix); sizes and the services' own queries at each volume.
  const s = await stack();
  const out = { perOperation: {}, levels: {} };
  try {
    const B = { b: await tableStats(s.bdb.url), p: await tableStats(s.pdb.url) };
    const PAID = 45, CANCELLED = 4, OPEN = 1;
    const items = await s.seed(PAID + CANCELLED + OPEN);
    const R = { b: await tableStats(s.bdb.url), p: await tableStats(s.pdb.url) };
    for (const it of items.slice(0, PAID)) await s.pay(it);
    for (const it of items.slice(0, PAID)) if (!(await s.until(it, (x) => x.request === 'paid', 60_000))) throw new Error('paid lifecycle did not converge');
    const P = { b: await tableStats(s.bdb.url), p: await tableStats(s.pdb.url) };
    for (const it of items.slice(PAID, PAID + CANCELLED)) await s.billingCancel(it);
    for (const it of items.slice(PAID, PAID + CANCELLED)) if (!(await s.until(it, (x) => x.request === 'cancelled', 60_000))) throw new Error('cancel did not converge');
    await h.sleep(1500); // the last outbox stamps and receipts
    const E = { b: await tableStats(s.bdb.url), p: await tableStats(s.pdb.url) };
    out.perOperation = {
      createInvoiceAndRequest: { billing: perOp(delta(B.b, R.b), items.length), payment: perOp(delta(B.p, R.p), items.length) },
      payToPaid: { billing: perOp(delta(R.b, P.b), PAID), payment: perOp(delta(R.p, P.p), PAID) },
      cancelToCancelled: { billing: perOp(delta(P.b, E.b), CANCELLED), payment: perOp(delta(P.p, E.p), CANCELLED) },
      bytesPerLifecycleMix: { billing: h.round(Object.values(delta(B.b, E.b)).reduce((a, x) => a + x.total, 0) / items.length), payment: h.round(Object.values(delta(B.p, E.p)).reduce((a, x) => a + x.total, 0) / items.length) },
      templateLifecycles: { paid: PAID, cancelled: CANCELLED, open: OPEN },
    };
    const outboxBytes = await s.pq(`SELECT avg(pg_column_size(payload))::int AS payload, avg(pg_column_size(t.*))::int AS row FROM outbox t`);
    const receiptKinds = await s.bq(`SELECT "causeType", outcome, count(*)::int AS n FROM payment_event_receipt GROUP BY 1, 2`);
    const transitionCauses = await s.bq(`SELECT "entityType", "causeType", count(*)::int AS n FROM billing_transition GROUP BY 1, 2 ORDER BY 1, 2`);
    out.templates = { paymentOutboxAvgBytes: outboxBytes[0], receiptKinds, transitionCauses };

    // Services stop: volume is written directly (triggers and foreign keys off for the loader session only; CHECKs still apply).
    await s.stop('billing');
    await s.stop('payment');
    const sample = {
      billing: (await s.bq(`SELECT pr.id AS "requestId", i."payerId", r."eventId" FROM payment_request pr JOIN invoice i ON i.id = pr."invoiceId" JOIN payment_event_receipt r ON r."paymentRequestId" = pr.id LIMIT 1`))[0],
      payment: (await s.pq(`SELECT p.id AS "paymentId", p."paymentRequestId", k.caller AS "idemCaller", k.operation AS "idemOperation", k.key AS "idemKey" FROM payment p, idempotency_key k LIMIT 1`))[0],
    };
    // Auth and Organization have no business flow here: their growing tables are loaded synthetically, one row per lifecycle (a scale proxy).
    const adb = await h.throwawayDatabase(ADMIN, 'auth-service');
    const odb = await h.throwawayDatabase(ADMIN, 'organization-service');
    const urls = { billing: s.bdb.url, payment: s.pdb.url, auth: adb.url, organization: odb.url };
    for (const svc of ['billing', 'payment']) {
      for (const t of Object.keys(CLONE[svc])) await h.adminQuery(urls[svc], `CREATE TABLE "validation_tpl_${t}" AS SELECT * FROM "${t}"`);
    }
    const webhookBody = (i) => Buffer.from(JSON.stringify({ id: `evt_${i}`, type: 'payment.succeeded', data: { reference: randomUUID(), amount: 1000, currency: 'TND', filler: randomBytes(160).toString('base64') } }));
    const synthetic = async (from, to) => {
      const n = to - from + 1;
      await h.adminQuery(urls.payment, `INSERT INTO webhook_event (provider, "providerEventId", "eventType", "rawBody", "receivedAt", state, outcome, attempts, "processedAt")
        SELECT 'test', 'evt_' || g, 'payment.succeeded', $1::bytea, now() - make_interval(secs => g),
               CASE WHEN g % 200 = 0 THEN 'failed' ELSE 'processed' END, CASE WHEN g % 200 = 0 THEN 'provider_error' ELSE 'applied' END, 1, now() - make_interval(secs => g)
          FROM generate_series(${from}, ${to}) g`, [webhookBody(from)]);
      await h.adminQuery(urls.auth, `SET session_replication_role = replica;
        INSERT INTO auth_throttle (bucket, key, "windowStart", count) SELECT 'login', md5('k' || g), now() - make_interval(secs => g), 1 + g % 5 FROM generate_series(${from}, ${to}) g;
        INSERT INTO auth_audit_event ("occurredAt", type, outcome, "actorId", ip, metadata)
          SELECT now() - make_interval(secs => g), 'auth.login', 'success', md5('actor' || (g % 5000))::uuid, '203.0.113.' || (g % 250), '{}'::jsonb FROM generate_series(${from}, ${to}) g;
        INSERT INTO refresh_token (id, "userId", "tokenHash", "familyId", "revokedAt", "expiresAt", "sessionExpiresAt", "createdAt")
          SELECT md5('rt' || g)::uuid, md5('actor' || (g % 5000))::uuid, md5('h' || g), md5('f' || (g / 3))::uuid,
                 CASE WHEN g % 3 <> 0 THEN now() END, now() - make_interval(secs => g) + interval '30 days', now() + interval '60 days', now() - make_interval(secs => g)
            FROM generate_series(${from}, ${to}) g;`);
      await h.adminQuery(urls.organization, `SET session_replication_role = replica;
        INSERT INTO idempotency_key (caller, operation, key, "requestHash", "resourceId", "createdAt")
          SELECT 'service:validation', 'company.create', 'validation-key-' || g, md5('r' || g), md5('res' || g)::uuid, now() - make_interval(secs => g) FROM generate_series(${from}, ${to}) g;
        INSERT INTO kit_rate_limit (bucket, key, "windowStart", count) SELECT 'org-create', md5('o' || g), now() - make_interval(secs => g), 1 FROM generate_series(${from}, ${to}) g;`);
      return n;
    };
    const sampleAuth = async () => ({ actorId: (await h.adminQuery(urls.auth, `SELECT md5('actor1')::uuid AS a`))[0].a, tokenHash: (await h.adminQuery(urls.auth, `SELECT md5('h1') AS x`))[0].x });
    const TPL = items.length;
    let doneK = 0; // clone multiples written so far
    let synthDone = 0;
    for (const L of [1_000, 10_000, 50_000, 100_000]) {
      const k = L / TPL;
      const t0 = h.now();
      for (const svc of ['billing', 'payment']) {
        for (const [t, opt] of Object.entries(CLONE[svc])) {
          const sql = await cloneSql(urls[svc], t, doneK + 1, k - 1, opt); // the template itself counts as multiple 0
          if (k - 1 >= doneK + 1) await h.adminQuery(urls[svc], `SET session_replication_role = replica; ${sql}`);
        }
      }
      await synthetic(synthDone + 1, L);
      synthDone = L;
      doneK = k - 1;
      for (const u of Object.values(urls)) await h.adminQuery(u, 'VACUUM ANALYZE');
      const loadS = h.round((h.now() - t0) / 1000);
      const level = { loadS, sizes: {}, queries: {} };
      for (const [svc, u] of Object.entries(urls)) level.sizes[svc] = await tableStats(u);
      const params = { ...sample.billing, ...sample.payment, ...(await sampleAuth()), caller: 'service:validation', key: `validation-key-${Math.floor(L / 2)}`, webhookEventId: `evt_${Math.floor(L / 2)}` };
      for (const [svc, qs] of Object.entries(QUERIES)) {
        level.queries[svc] = {};
        for (const [name, q] of Object.entries(qs)) {
          try {
            level.queries[svc][name] = await explain(urls[svc], typeof q === 'function' ? q(params) : q);
          } catch (e) {
            level.queries[svc][name] = { error: String(e.message).slice(0, 160) };
          }
        }
      }
      out.levels[L] = level;
      log(`growth level ${L} loaded in ${loadS}s; billing ${h.round(Object.values(level.sizes.billing).reduce((a, x) => a + x.total, 0) / 1048576)} MB, payment ${h.round(Object.values(level.sizes.payment).reduce((a, x) => a + x.total, 0) / 1048576)} MB`);
    }
    // After growth: the services start against the grown databases and must be ready, with workers scanning at size.
    const tStart = h.now();
    await s.start('payment');
    await s.start('billing');
    out.startAtSize = { readyMs: h.round(h.now() - tStart), readiness: await s.readiness() };
    const [x] = await s.seed(1);
    await s.pay(x);
    out.startAtSize.newLifecycleAtSize = await s.until(x, (st) => st.request === 'paid', 60_000);
    await adb.drop();
    await odb.drop();
    return out;
  } finally {
    await s.close();
  }
};

// ------------------------------------------------------------------------------------------------ outbox accumulation (RabbitMQ unreachable)
C.outboxOutage = async () => {
  // Payment cannot reach RabbitMQ while payers pay: every payment.succeeded waits in Payment's outbox. Then the broker returns: drain
  // time, Billing applies each once. 3 runs.
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const s = await stack();
    try {
      const N = 100;
      const items = await s.seed(N);
      await s.brokerProxy.payment.down();
      const t0 = h.now();
      for (const it of items) await s.pay(it);
      const payMs = h.round(h.now() - t0);
      await h.sleep(5000);
      const [acc] = await s.pq(`SELECT count(*) FILTER (WHERE "publishedAt" IS NULL)::int AS pending, pg_total_relation_size('outbox') AS bytes,
        extract(epoch FROM now() - min("occurredAt") FILTER (WHERE "publishedAt" IS NULL))::int AS "oldestS", max(attempts)::int AS "maxAttempts",
        round(extract(epoch FROM max("availableAt") FILTER (WHERE "publishedAt" IS NULL) - now())::numeric, 1)::float AS "nextRetryInS" FROM outbox`);
      const paymentLines = s.procs.payment.since(t0);
      await s.brokerProxy.payment.up();
      const t1 = h.now();
      const drained = await h.waitFor(async () => (await s.pq(`SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NULL`))[0].n === 0, 120_000, 100);
      const drainMs = h.round(h.now() - t1);
      const applied = await h.waitFor(async () => (await s.bq(`SELECT count(*)::int AS n FROM payment_request WHERE status = 'paid'`))[0].n === N, 120_000, 100);
      const appliedMs = h.round(h.now() - t1);
      const acct = await s.account(items);
      runs.push({ payMs, accumulated: { ...acc, bytes: Number(acc.bytes) }, outageLogLines: paymentLines.length, outageLogBytes: paymentLines.reduce((a, l) => a + l.raw.length + 1, 0), drained: Boolean(drained), drainMs, allApplied: Boolean(applied), appliedMs, acct });
      log(`outboxOutage run ${i + 1}: pending ${acc.pending} oldest ${acc.oldestS}s maxAttempts ${acc.maxAttempts}; drain ${drainMs} ms, applied ${appliedMs} ms`);
    } finally {
      await s.close();
    }
  }
  return { runs, drainMs: h.stats(runs.map((r) => r.drainMs)), appliedMs: h.stats(runs.map((r) => r.appliedMs)) };
};

// ------------------------------------------------------------------------------------------------ log volume
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const template = (l) => `${l.level ?? '-'} ${l.context ?? ''} ${String(l.msg ?? '').replace(UUID, '<id>').replace(/\b[0-9a-f]{16,}\b/gi, '<hex>').replace(/\d+(\.\d+)?/g, '<n>').slice(0, 110)}`;
const SENSITIVE = [
  ['bearer', /bearer\s+[A-Za-z0-9._~+/-]{12,}/i], ['password', /password\s*[=:]/i], ['secret', /secret\s*[=:]/i], ['authorization', /authorization\s*[=:]/i],
  ['url-credentials', /[a-z]+:\/\/[^:/\s"]+:[^@/\s"]+@/i], ['token=', /token\s*=\s*[A-Za-z0-9._-]{12,}/i], ['cookie', /set-cookie|cookie\s*[=:]/i],
];
const allLines = []; // every line of every campaign, for the sensitive-data scan (only counts leave this process)
const secretsSeen = new Set();
function summarise(lines, windowMs) {
  const bySvc = {};
  for (const l of lines) {
    const s = (bySvc[l.svc] ??= { lines: 0, bytes: 0, levels: {}, templates: {}, withCorrelation: 0, withRequestId: 0 });
    s.lines++;
    s.bytes += l.raw.length + 1;
    s.levels[l.level ?? 'raw'] = (s.levels[l.level ?? 'raw'] ?? 0) + 1;
    const t = template(l);
    s.templates[t] = (s.templates[t] ?? 0) + 1;
    if (l.correlationId || /correlationId=/.test(String(l.msg))) s.withCorrelation++;
    if (l.requestId) s.withRequestId++;
  }
  for (const s of Object.values(bySvc)) {
    const sorted = Object.entries(s.templates).sort((a, b) => b[1] - a[1]);
    s.distinctTemplates = sorted.length;
    s.top = sorted.slice(0, 6).map(([t, n]) => ({ n, t }));
    s.linesPerMin = h.round((s.lines / windowMs) * 60_000);
    s.bytesPerMin = h.round((s.bytes / windowMs) * 60_000);
    delete s.templates;
  }
  return bySvc;
}
const linesOf = (s, t0, t1 = Infinity) => ['billing', 'payment'].flatMap((n) => (s.procs[n]?.since(t0) ?? []).filter((l) => l.t < t1).map((l) => ({ ...l, svc: n })));
/** Probes /ready and /health on both services every second during `ms` (a probing orchestrator's load). */
async function probing(s, ms) {
  const end = h.now() + ms;
  const seen = [];
  while (h.now() < end) {
    for (const n of ['billing', 'payment']) if (s.procs[n]?.alive()) seen.push((await probe(s.base(n), '/ready', 3000)).status, (await probe(s.base(n), '/health', 3000)).status);
    await h.sleep(1000);
  }
  return seen.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
}
async function window(s, name, { fault, restore, windowMs = 30_000, recoveryMs = 15_000, during } = {}) {
  const t0 = h.now();
  await fault?.();
  const [probes] = await Promise.all([probing(s, windowMs), during?.()]);
  const t1 = h.now();
  await restore?.();
  await probing(s, recoveryMs);
  const t2 = h.now();
  const faultLines = linesOf(s, t0, t1);
  const recoveryLines = linesOf(s, t1, t2);
  allLines.push(...faultLines, ...recoveryLines);
  const recoveryTemplates = [...new Set(recoveryLines.map(template))].slice(0, 12);
  return { name, windowMs: h.round(t1 - t0), probes, fault: summarise(faultLines, t1 - t0), recovery: { lines: recoveryLines.length, templates: recoveryTemplates }, readinessAfter: await s.readiness() };
}

C.logVolume = async () => {
  const out = {};
  const run = async (name, opts, stackOpts = {}) => {
    const s = await stack(stackOpts);
    try {
      [s.producer.token, s.b2p.token].forEach((t) => secretsSeen.add(t));
      await opts.setup?.(s);
      out[name] = await window(s, name, { ...opts, fault: opts.fault && (() => opts.fault(s)), restore: opts.restore && (() => opts.restore(s)), during: opts.during && (() => opts.during(s)) });
      if (opts.after) out[name].after = await opts.after(s);
      log(`logVolume ${name}: ${JSON.stringify(Object.fromEntries(Object.entries(out[name].fault).map(([k, v]) => [k, `${v.lines} lines / ${v.bytes} B (${v.linesPerMin}/min)`])))}`);
    } finally {
      await s.close();
    }
  };
  await run('healthyIdle', {});
  await run('healthyBusy', { during: async (s) => { const it = await s.seed(20); for (const x of it) await s.pay(x); } });
  await run('dbDownBoth', { fault: async (s) => { await s.dbProxy.billing.down(); await s.dbProxy.payment.down(); }, restore: async (s) => { await s.dbProxy.billing.up(); await s.dbProxy.payment.up(); } });
  await run('rabbitStopped', { fault: () => rabbit.appStop(), restore: () => rabbit.appStart() });
  await run('rabbitFrozen', { fault: (s) => { s.brokerProxy.billing.freeze(); s.brokerProxy.payment.freeze(); }, restore: (s) => { s.brokerProxy.billing.thaw(); s.brokerProxy.payment.thaw(); } });
  for (const mode of ['blackhole', 'unavailable', 'refuse']) {
    await run(`paymentApi_${mode}`, {
      fault: (s) => s.payHttp.setMode(mode), restore: (s) => s.payHttp.setMode('pass'),
      during: async (s) => { await s.seed(20, { wait: false }); },
      after: async (s) => ({ requested: (await s.bq(`SELECT status, count(*)::int AS n FROM payment_request GROUP BY 1`)), billingDispatchCalls: s.payHttp.seen.length }),
    }, { billingEnv: { BILLING_DISPATCH_STALE_SENDING_MS: '5000', PAYMENT_TIMEOUT_MS: '2500' } });
  }
  await run('providerTimeouts', {
    // 20 attempts whose provider outcome is unknown (timeout after accept): the AttemptResolver asks the provider again every pass.
    during: async (s) => {
      const it = await s.seed(20);
      for (const x of it) {
        const [p] = await s.paymentOf(x);
        await s.call(s.base('payment'), 'POST', `/payment/payments/${p.id}/attempts`, { token: x.payer, body: { provider: 'test', providerOptions: { scenario: 'timeout_after_accept' } }, headers: { 'idempotency-key': `a-${randomUUID()}` } });
      }
    },
    after: async (s) => ({ attempts: await s.pq(`SELECT status, count(*)::int AS n FROM payment_attempt GROUP BY 1`) }),
  });
  await run('consumerRetryStorm', {
    // Billing's database is gone while 20 Payment events arrive: each is retried by the consumer, then dead-lettered.
    setup: async (s) => { s.items = await s.seed(20); },
    fault: async (s) => { await s.dbProxy.billing.down(); for (const x of s.items) await s.paymentCancelDirect(x); },
    restore: (s) => s.dbProxy.billing.up(),
    after: async (s) => ({ dlq: rabbit.queues().find((q) => q.name === 'billing.payment-events.dead')?.messages_ready ?? null }),
  }, { billingEnv: RECONCILE_FAST });
  return out;
};

// ------------------------------------------------------------------------------------------------ O4 / O5: DLQ residue after reconciliation
C.dlqLifecycle = async () => {
  // A Payment event is dead-lettered while Billing's database is down; the reconciler then applies the same fact from Payment's API. The
  // message stays in the DLQ (O4). The existing operator tooling inspects and replays it: the consumer acknowledges it as `ignored` (already
  // applied) under its own event id, so one more receipt row and no second effect (O5). 3 runs.
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const s = await stack({ billingEnv: RECONCILE_FAST });
    const conn = await amqp.connect(rabbit.url);
    try {
      const [x] = await s.seed(1);
      await s.dbProxy.billing.down();
      await s.paymentCancelDirect(x);
      await h.waitFor(() => Number(rabbit.queues().find((q) => q.name === 'billing.payment-events.dead')?.messages_ready ?? 0) >= 1, 60_000, 250);
      await s.dbProxy.billing.up();
      const settled = await s.until(x, (st) => st.request === 'cancelled', 60_000);
      await h.sleep(2000);
      const before = { dlq: (await inspectDeadLetters(conn, 'billing.payment-events.dead')).depth, receipts: await s.bq(`SELECT "causeType", outcome FROM payment_event_receipt WHERE "paymentRequestId" = $1 ORDER BY "receivedAt"`, [x.requestId]),
        transitions: await s.bq(`SELECT "entityType", "toStatus", "causeType" FROM billing_transition WHERE "entityId" = $1 OR "entityId" = $2 ORDER BY "occurredAt"`, [x.requestId, x.invoiceId]) };
      const inspected = await inspectDeadLetters(conn, 'billing.payment-events.dead');
      const eventId = inspected.messages[0]?.eventId;
      const replay = eventId ? await replayDeadLetter(conn, 'billing.payment-events.dead', eventId, { waitMs: 10_000 }) : null;
      await h.sleep(1000);
      const after = { dlq: (await inspectDeadLetters(conn, 'billing.payment-events.dead')).depth, receipts: await s.bq(`SELECT "causeType", outcome, "detailCode" FROM payment_event_receipt WHERE "paymentRequestId" = $1 ORDER BY "receivedAt"`, [x.requestId]), state: await s.state(x) };
      const replayAgain = eventId ? await replayDeadLetter(conn, 'billing.payment-events.dead', eventId, { waitMs: 2000 }) : null;
      runs.push({ settledByReconciler: Boolean(settled), failure: inspected.messages[0]?.failure ?? null, before, replay: replay?.outcome, after, replayAgain: replayAgain?.outcome });
      log(`dlqLifecycle run ${i + 1}: dlq ${before.dlq} → replay ${replay?.outcome} → dlq ${after.dlq}; receipts ${after.receipts.map((r) => `${r.causeType}/${r.outcome}`).join(',')}`);
    } finally {
      await conn.close().catch(() => undefined);
      await s.close();
    }
  }
  return { runs };
};

// ------------------------------------------------------------------------------------------------ Auth / Organization probes
C.edgeProbes = async () => {
  // Auth and Organization probed at 2/s for 65 s from one address (an orchestrator plus a load balancer): statuses and log lines.
  const adb = await h.throwawayDatabase(ADMIN, 'auth-service');
  const odb = await h.throwawayDatabase(ADMIN, 'organization-service');
  const auth = await core.start('auth-service', { db: adb, extra: { NODE_ENV: 'development' } });
  const org = await core.start('organization-service', { db: odb, extra: { AUTH_SERVICE_URL: auth.base } });
  try {
    const out = {};
    for (const [svc, paths] of [[auth, ['/auth/health', '/health', '/ready']], [org, ['/health', '/ready']]]) {
      const t0 = h.now();
      const st = {};
      let first429 = null;
      while (h.now() - t0 < 65_000) {
        for (const p of paths) {
          const r = await probe(svc.base, p, 3000);
          (st[p] ??= {})[r.status] = (st[p][r.status] ?? 0) + 1;
          if (r.status === 429 && first429 === null) first429 = { path: p, afterS: h.round((h.now() - t0) / 1000) };
        }
        await h.sleep(500);
      }
      const lines = svc.since(t0).map((l) => ({ ...l, svc: svc.service }));
      allLines.push(...lines);
      out[svc.service] = { statuses: st, first429, logs: summarise(lines, h.now() - t0) };
    }
    return out;
  } finally {
    for (const p of [auth, org]) if (p.alive()) { p.child.kill('SIGKILL'); await p.exited; }
    await adb.drop();
    await odb.drop();
  }
};

// ------------------------------------------------------------------------------------------------ run
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
const names = args.length ? args : Object.keys(C);
const results = {};
const started = new Date().toISOString();
try {
  for (const n of names) {
    if (!C[n]) throw new Error(`unknown campaign ${n}`);
    log(`campaign ${n} ...`);
    const t = Date.now();
    try {
      results[n] = { ...(await C[n]()), durationS: h.round((Date.now() - t) / 1000) };
    } catch (e) {
      results[n] = { error: describeFailure(e), message: String(e?.message).slice(0, 300), stack: String(e?.stack).split('\n').slice(0, 4) };
      log(`campaign ${n} ERROR ${describeFailure(e)} ${String(e?.message).slice(0, 200)}`);
    }
  }
  // Sensitive-data scan over every captured line: counts per pattern and whether a known live credential appeared (values never copied).
  const hits = {};
  for (const l of allLines) {
    for (const [k, re] of SENSITIVE) if (re.test(l.raw)) (hits[k] ??= { n: 0, templates: new Set() }).n++, hits[k].templates.add(template(l).slice(0, 80));
  }
  results.sensitiveScan = {
    linesScanned: allLines.length,
    patterns: Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, { n: v.n, templates: [...v.templates].slice(0, 5) }])),
    liveCredentialInLogs: allLines.some((l) => [...secretsSeen].some((t) => l.raw.includes(t))),
    rawLinesNotJson: allLines.filter((l) => l.level === 'raw').length,
  };
} finally {
  const env = await h.environment(ADMIN).catch(() => ({}));
  try { rabbit.queues(); } catch { await rabbit.appStart().catch(() => undefined); }
  rabbit.stop();
  pgc.stop();
  const doc = JSON.stringify({ env: { ...env, rabbitmq: '3.13 (throwaway container)' }, started, results, uncaughtOrUnhandled: uncaught, finished: new Date().toISOString() }, null, 1);
  if (outFile) writeFileSync(outFile, doc);
  else process.stdout.write(doc + '\n');
}
