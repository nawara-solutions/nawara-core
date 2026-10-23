import { describe, expect, it } from 'vitest';
import {
  CODE_BEARING_EVENTS, ProducerReemission, inspectReemissionEligibility, REEMISSION_APPROVALS, ReemissionRefused, eventMessage, mayTransition, migrationOwnership, outboxEnvelope,
  reemissionAttemptOutcome, reemissionAuditFacts, reemissionPolicy, reemissionRequest, type ProducerReemissionOptions, type PublishedOutboxRow,
  type ReemissionAuthorizationClaims, type ReemissionIntent, type ReemissionPlan, type ReemissionPublishOutcome, type ReemissionTransition,
} from '../src/index.js';
import { RabbitMqEventBus } from '../src/events/rabbitmq-event-bus.js';

/**
 * Core V2 S1c-3 R1 (ADR-0057 §13.7 "S0-C4"): the re-emission foundation's refusals, ordering and outcomes, with fakes for every producer-owned
 * part (authorizer, ownership, publication evidence, attempt store, publisher). The real PostgreSQL / RabbitMQ half is reemission.int-spec.ts.
 */
const PRODUCER = 'payment-service';
const EVENT_ID = '7d1c4f0a-2b3e-4c5d-8e6f-0a1b2c3d4e5f';
const PAYLOAD = Object.freeze({ amount: 1200, currency: 'TND', paymentId: 'p-1' });
const policy = () => reemissionPolicy(PRODUCER, [{ name: 'payment.succeeded', version: 1 }, { name: 'payment.failed', version: 1 }]);
const request = (extra: Record<string, unknown> = {}) => ({ eventId: EVENT_ID, eventName: 'payment.succeeded', reason: 'consumer_outage', ...extra });
const storedRow = (extra: Partial<PublishedOutboxRow> = {}): PublishedOutboxRow => ({
  id: EVENT_ID, name: 'payment.succeeded', payload: { ...PAYLOAD }, correlationId: 'corr-abcdef12', eventVersion: 1,
  occurredAt: new Date('2026-10-23T08:15:30.123Z'), publishedAt: new Date('2026-10-23T08:15:31.000Z'), ...extra,
});

interface Harness {
  opts: ProducerReemissionOptions;
  log: string[];
  intents: ReemissionIntent[];
  transitions: ReemissionTransition[];
  plans: ReemissionPlan[];
}
function harness(over: {
  row?: PublishedOutboxRow | null;
  owned?: boolean;
  pipeline?: number | undefined;
  claims?: (c: ReemissionAuthorizationClaims) => ReemissionAuthorizationClaims;
  authorizerThrows?: boolean;
  receipt?: (i: ReemissionIntent) => unknown;
  commitThrows?: boolean;
  appendThrows?: 'publishing' | 'outcome';
  outcome?: ReemissionPublishOutcome;
  lookupThrows?: boolean;
} = {}): Harness {
  const log: string[] = [];
  const intents: ReemissionIntent[] = [];
  const transitions: ReemissionTransition[] = [];
  const plans: ReemissionPlan[] = [];
  const row = over.row === undefined ? storedRow() : over.row;
  const q = {
    query: async (sql: string, params?: unknown[]) => {
      log.push(`sql:${sql.split(/\s+/).slice(0, 3).join(' ')}`);
      if (over.lookupThrows && sql.includes('FROM outbox')) throw new Error(`connection lost while reading ${JSON.stringify(PAYLOAD)}`);
      if (sql.includes('FROM outbox')) return { rows: row && params?.[0] === row.id ? [{ ...row, payload: { ...row.payload } }] : [], rowCount: row ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    },
  };
  const opts: ProducerReemissionOptions = {
    policy: policy(),
    environment: 'production',
    db: { tx: async (fn) => { log.push('tx'); return fn(q as never); } },
    ownership: { confirm: async () => { log.push('ownership'); return over.owned ?? true; } },
    evidence: { pipelineVersionOf: async (_q, facts) => { log.push(`evidence:${'payload' in facts}`); return 'pipeline' in over ? over.pipeline : 1; } },
    authorizer: {
      verify: async (req, ctx) => {
        log.push('authorize');
        if (over.authorizerThrows) throw new Error('approval token sk_live_secret rejected');
        const c: ReemissionAuthorizationClaims = { ...req, producer: ctx.producer, environment: ctx.environment, operation: ctx.operation, approvalRef: 'gh-env-approval-123' };
        return over.claims ? over.claims(c) : c;
      },
    },
    attempts: {
      commitIntent: async (i) => {
        log.push('commitIntent');
        if (over.commitThrows) throw new Error('db down');
        intents.push(i);
        return (over.receipt ? over.receipt(i) : { attemptId: i.attemptId, intentCommitted: true, auditIntentRecorded: true }) as never;
      },
      appendTransition: async (t) => {
        log.push(`append:${t.to}`);
        if ((over.appendThrows === 'publishing' && t.to === 'publishing') || (over.appendThrows === 'outcome' && t.to !== 'publishing')) throw new Error('db down');
        transitions.push(t);
      },
    },
    publisher: {
      publishReemission: async (plan) => {
        log.push('publish');
        plans.push(plan);
        return over.outcome ?? { outcome: 'confirmed' };
      },
    },
  };
  return { opts, log, intents, transitions, plans };
}
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ReemissionRefused);
    expect((e as Error).cause).toBeUndefined();
    return (e as ReemissionRefused).code;
  }
  throw new Error('expected a refusal');
};

describe('re-emission policy (S0-C4 approvals)', () => {
  it('the approvals are exactly the Payment-first four, version 1, with no pattern', () => {
    expect(REEMISSION_APPROVALS).toStrictEqual({
      'payment-service': [{ name: 'payment.succeeded', version: 1 }, { name: 'payment.failed', version: 1 }, { name: 'payment.cancelled', version: 1 }, { name: 'payment.expired', version: 1 }],
    });
    expect(Object.isFrozen(REEMISSION_APPROVALS) && Object.isFrozen(REEMISSION_APPROVALS['payment-service'])).toBe(true);
    expect(Object.isFrozen(CODE_BEARING_EVENTS)).toBe(true);
  });

  it.each([
    ['another producer', 'auth-service', [{ name: 'payment.succeeded', version: 1 }]],
    ['an unapproved event of the producer', PRODUCER, [{ name: 'payment.created', version: 1 }]],
    ['an unsupported version', PRODUCER, [{ name: 'payment.succeeded', version: 2 }]],
    ['a wildcard', PRODUCER, [{ name: 'payment.*', version: 1 }]],
    ['a multi-word wildcard', PRODUCER, [{ name: 'payment.#', version: 1 }]],
    ['a code-bearing event', 'auth-service', [{ name: 'member.contact_verification_requested', version: 1 }]],
    ['an empty list', PRODUCER, []],
    ['a duplicate', PRODUCER, [{ name: 'payment.failed', version: 1 }, { name: 'payment.failed', version: 1 }]],
    ['an inherited key as producer', 'constructor', [{ name: 'payment.failed', version: 1 }]],
  ])('refuses %s', (_t, producer, events) => {
    expect(() => reemissionPolicy(producer as string, events as never)).toThrow(ReemissionRefused);
  });

  it('a hand-built policy gets no further than reemissionPolicy', () => {
    const h = harness();
    expect(() => new ProducerReemission({ ...h.opts, policy: { producer: PRODUCER, events: [{ name: 'payment.created', version: 1 }] } })).toThrow(ReemissionRefused);
    expect(() => new ProducerReemission({ ...h.opts, policy: { producer: 'auth-service', events: [{ name: 'admin.operator_code_issued', version: 1 }] } })).toThrow(ReemissionRefused);
    expect(() => new ProducerReemission({ ...h.opts, environment: '' })).toThrow(ReemissionRefused);
    expect(() => new ProducerReemission({ ...h.opts, attempts: undefined as never })).toThrow(ReemissionRefused);
  });
});

describe('re-emission request: only an id, an expected name and a reason code', () => {
  it.each([
    ['a caller-supplied payload', { payload: { amount: 1 } }],
    ['a caller-supplied body', { body: '{}' }],
    ['a caller-supplied source', { source: 'billing-service' }],
    ['a caller-supplied user_id', { userId: 'payment-service' }],
    ['a caller-supplied exchange', { exchange: '' }],
    ['a caller-supplied routing key', { routingKey: 'payment.succeeded' }],
    ['caller-supplied headers', { headers: { source: 'x' } }],
    ['a caller-supplied approval reference', { approvalRef: 'APPROVED' }],
    ['a new event id', { id: '00000000-0000-4000-8000-000000000000' }],
  ])('refuses %s', async (_t, extra) => {
    expect(() => reemissionRequest(request(extra))).toThrow(ReemissionRefused);
    const h = harness();
    expect(await refusal(new ProducerReemission(h.opts).reemit(request(extra)))).toBe('request_invalid');
    expect(h.log).toStrictEqual([]); // refused before anything else ran
  });

  it.each([
    ['a malformed id', { eventId: 'not-a-uuid' }],
    ['a pattern as name', { eventName: 'payment.#' }],
    ['free text as reason', { reason: 'because the Owner said so' }],
    ['a missing field', { reason: undefined }],
  ])('refuses %s', (_t, extra) => {
    const r: Record<string, unknown> = request(extra);
    if (r.reason === undefined) delete r.reason;
    expect(() => reemissionRequest(r)).toThrow(ReemissionRefused);
  });

  it('refuses a non-plain object (a class instance or an inherited field)', () => {
    expect(() => reemissionRequest(Object.assign(Object.create({ payload: {} }), request()))).toThrow(ReemissionRefused);
    expect(() => reemissionRequest([EVENT_ID])).toThrow(ReemissionRefused);
    expect(() => reemissionRequest(null)).toThrow(ReemissionRefused);
  });

  it('refuses a code-bearing name before anything else runs, and an event outside the policy', async () => {
    for (const name of CODE_BEARING_EVENTS) {
      const h = harness();
      expect(await refusal(new ProducerReemission(h.opts).reemit(request({ eventName: name })))).toBe('code_bearing_event');
      expect(h.log).toStrictEqual([]);
    }
    const h = harness();
    expect(await refusal(new ProducerReemission(h.opts).reemit(request({ eventName: 'payment.expired' })))).toBe('event_not_allowed');
    expect(h.log).toStrictEqual([]);
  });
});

describe('authorization: verified claims bound to the request and the producer context', () => {
  it.each([
    ['another producer', (c: ReemissionAuthorizationClaims) => ({ ...c, producer: 'billing-service' })],
    ['another event id', (c: ReemissionAuthorizationClaims) => ({ ...c, eventId: '00000000-0000-4000-8000-000000000000' })],
    ['another event name', (c: ReemissionAuthorizationClaims) => ({ ...c, eventName: 'payment.failed' })],
    ['another reason', (c: ReemissionAuthorizationClaims) => ({ ...c, reason: 'other' })],
    ['another environment', (c: ReemissionAuthorizationClaims) => ({ ...c, environment: 'staging' })],
    ['another operation', (c: ReemissionAuthorizationClaims) => ({ ...c, operation: 'event.publish' })],
    ['no approval reference', (c: ReemissionAuthorizationClaims) => ({ ...c, approvalRef: '' })],
    ['nothing', () => undefined as never],
  ])('refuses claims naming %s, before any database read', async (_t, claims) => {
    const h = harness({ claims });
    expect(await refusal(new ProducerReemission(h.opts).reemit(request()))).toBe('authorization_invalid');
    expect(h.log).toStrictEqual(['authorize']);
  });

  it('an authorizer that throws is a refusal that carries none of its text', async () => {
    const h = harness({ authorizerThrows: true });
    const p = new ProducerReemission(h.opts).reemit(request());
    await expect(p).rejects.toThrow('event re-emission refused: authorization_invalid');
    await p.catch((e: Error) => expect(e.message).not.toMatch(/sk_live|secret|token/));
  });
});

describe('the source row (one read-only transaction on the producer database)', () => {
  it.each([
    ['the database is not confirmed as the producer\'s', { owned: false }, 'database_ownership_unconfirmed'],
    ['a missing (or purged) row', { row: null }, 'row_missing'],
    ['a row of another name', { row: storedRow({ name: 'payment.failed' }) }, 'row_name_mismatch'],
    ['an unpublished row', { row: storedRow({ publishedAt: null as never }) }, 'row_unpublished'],
    ['an unsupported event version', { row: storedRow({ eventVersion: 2 }) }, 'version_not_allowed'],
    ['no publication evidence', { pipeline: undefined }, 'pipeline_unknown'],
    ['a malformed pipeline version', { pipeline: 1.5 }, 'pipeline_unknown'],
    ['an incompatible pipeline version', { pipeline: 2 }, 'pipeline_incompatible'],
    ['a lookup failure', { lookupThrows: true }, 'lookup_failed'],
  ] as const)('refuses %s and publishes nothing', async (_t, over, code) => {
    const h = harness(over as never);
    const p = new ProducerReemission(h.opts).reemit(request());
    expect(await refusal(p)).toBe(code);
    await p.catch((e: Error) => expect(e.message).not.toContain('TND'));
    expect(h.log).not.toContain('commitIntent');
    expect(h.log).not.toContain('publish');
  });

  it('reads inside a read-only transaction, confirms ownership first, and never gives the evidence the payload', async () => {
    const h = harness();
    await new ProducerReemission(h.opts).reemit(request());
    expect(h.log.slice(0, 6)).toStrictEqual(['authorize', 'tx', 'sql:SET TRANSACTION READ', 'ownership', 'sql:SELECT id, name,', 'evidence:false']);
  });
});

describe('durable intent before publication', () => {
  it.each([
    ['the store fails', { commitThrows: true }],
    ['no receipt', { receipt: () => undefined }],
    ['a receipt for another attempt', { receipt: () => ({ attemptId: '00000000-0000-4000-8000-000000000000', intentCommitted: true, auditIntentRecorded: true }) }],
    ['a receipt without the audit intent', { receipt: (i: ReemissionIntent) => ({ attemptId: i.attemptId, intentCommitted: true, auditIntentRecorded: false }) }],
    ['a receipt without the commit', { receipt: (i: ReemissionIntent) => ({ attemptId: i.attemptId, intentCommitted: 'yes', auditIntentRecorded: true }) }],
  ])('refuses when %s, and publishes nothing', async (_t, over) => {
    const h = harness(over as never);
    expect(await refusal(new ProducerReemission(h.opts).reemit(request()))).toBe('intent_not_durable');
    expect(h.log).not.toContain('publish');
    expect(h.transitions).toStrictEqual([]);
  });

  it('refuses when the publishing state cannot be recorded, and publishes nothing', async () => {
    const h = harness({ appendThrows: 'publishing' });
    expect(await refusal(new ProducerReemission(h.opts).reemit(request()))).toBe('attempt_state_not_durable');
    expect(h.log).not.toContain('publish');
  });

  it('records the intent (never the body), then publishing, then publishes, then appends the outcome', async () => {
    const h = harness();
    const r = await new ProducerReemission(h.opts).reemit(request());
    expect(h.log.slice(-4)).toStrictEqual(['commitIntent', 'append:publishing', 'publish', 'append:confirmed']);
    const [intent] = h.intents;
    expect(intent).toStrictEqual({
      attemptId: r.attemptId, producer: PRODUCER, eventId: EVENT_ID, eventName: 'payment.succeeded', eventVersion: 1, reason: 'consumer_outage',
      approvalRef: 'gh-env-approval-123', environment: 'production', operation: 'event.reemit', pipelineVersion: 1, requestedAt: intent!.requestedAt,
    });
    expect(JSON.stringify(h.intents)).not.toContain('TND');
    expect(Object.keys(reemissionAuditFacts(intent!)).sort()).toStrictEqual(['approvalRef', 'attemptId', 'environment', 'eventId', 'eventName', 'producer', 'reason', 'requestedAt']);
    expect(h.transitions.map((t) => `${t.from}>${t.to}`)).toStrictEqual(['requested>publishing', 'publishing>confirmed']);
    expect(r).toStrictEqual({ attemptId: r.attemptId, publish: { outcome: 'confirmed' }, outcomeRecorded: true });
  });
});

describe('the publication plan', () => {
  it('is the relay\'s envelope of the stored row, frozen, with the original id and no caller content', async () => {
    const h = harness();
    await new ProducerReemission(h.opts).reemit(request());
    const [plan] = h.plans;
    expect(plan!.event).toStrictEqual(outboxEnvelope(storedRow(), PRODUCER));
    expect(Object.isFrozen(plan) && Object.isFrozen(plan!.event) && Object.isFrozen(plan!.event.payload) && Object.isFrozen(plan!.event.headers)).toBe(true);
    expect(eventMessage(plan!.event, PRODUCER).content.toString()).toBe('{"amount":1200,"currency":"TND","paymentId":"p-1"}');
  });

  it('repeated and concurrent attempts re-emit the same id and bytes under distinct attempts', async () => {
    const h = harness();
    const re = new ProducerReemission(h.opts);
    const results = await Promise.all([re.reemit(request()), re.reemit(request()), re.reemit(request())]);
    expect(new Set(results.map((r) => r.attemptId)).size).toBe(3);
    expect(new Set(h.plans.map((p) => p.event.id))).toStrictEqual(new Set([EVENT_ID]));
    expect(new Set(h.plans.map((p) => eventMessage(p.event, PRODUCER).content.toString('base64'))).size).toBe(1);
    expect(new Set(h.plans.map((p) => JSON.stringify(eventMessage(p.event, PRODUCER).options))).size).toBe(1);
  });

  it('the bus publishes only a plan issued by ProducerReemission, and only once', async () => {
    const bus = new RabbitMqEventBus({ url: 'amqp://svc:pw@127.0.0.1:1' });
    const forged = { attemptId: 'x', event: outboxEnvelope(storedRow(), PRODUCER) };
    await expect(bus.publishReemission(forged)).rejects.toThrow('not an issued re-emission plan');
    const h = harness();
    await new ProducerReemission(h.opts).reemit(request());
    await expect(bus.publishReemission(h.plans[0]!)).rejects.toThrow('not an issued re-emission plan'); // spent once the attempt ended
  });

  it('a bus whose broker user is not the producer refuses before sending (no impersonation)', async () => {
    const notices: string[] = [];
    const bus = new RabbitMqEventBus({ url: 'amqp://billing-service:pw@127.0.0.1:1', onNotice: (m) => notices.push(m) });
    const h = harness();
    const re = new ProducerReemission({ ...h.opts, publisher: bus });
    expect((await re.reemit(request())).publish).toStrictEqual({ outcome: 'failed', stage: 'not_sent' });
    expect(notices.join('\n')).not.toMatch(/TND|pw|amount/);
    const anonymous = new ProducerReemission({ ...h.opts, publisher: new RabbitMqEventBus({ url: 'amqp://127.0.0.1:1' }) });
    expect((await anonymous.reemit(request())).publish).toStrictEqual({ outcome: 'failed', stage: 'not_sent' });
  });
});

describe('outcomes and attempt states', () => {
  it.each([
    [{ outcome: 'confirmed' }, 'confirmed'],
    [{ outcome: 'unroutable' }, 'unroutable'],
    [{ outcome: 'failed', stage: 'nacked' }, 'failed'],
    [{ outcome: 'failed', stage: 'refused' }, 'failed'],
    [{ outcome: 'uncertain', stage: 'confirm_timeout' }, 'uncertain'],
    [{ outcome: 'uncertain', stage: 'channel_closed' }, 'uncertain'],
  ] as const)('%o is appended as %s, with its stage', async (outcome, state) => {
    const h = harness({ outcome });
    const r = await new ProducerReemission(h.opts).reemit(request());
    expect(r.publish).toStrictEqual(outcome);
    expect(h.transitions.at(-1)).toMatchObject({ from: 'publishing', to: state, ...('stage' in outcome ? { stage: outcome.stage } : {}) });
  });

  it('a publisher that throws is uncertain, never failed', async () => {
    const h = harness();
    const r = await new ProducerReemission({ ...h.opts, publisher: { publishReemission: async () => { throw new Error('socket'); } } }).reemit(request());
    expect(r.publish.outcome).toBe('uncertain');
  });

  it('an outcome that cannot be appended is reported, and the history then reads uncertain', async () => {
    const h = harness({ appendThrows: 'outcome' });
    const r = await new ProducerReemission(h.opts).reemit(request());
    expect(r).toMatchObject({ publish: { outcome: 'confirmed' }, outcomeRecorded: false });
    expect(reemissionAttemptOutcome(['requested', ...h.transitions.map((t) => t.to)])).toBe('uncertain');
  });

  it('transitions are append-only and never leave a final state, uncertain included', () => {
    expect(mayTransition('requested', 'publishing')).toBe(true);
    expect(mayTransition('requested', 'confirmed')).toBe(false); // no outcome without a publication attempt
    for (const final of ['confirmed', 'unroutable', 'failed', 'uncertain'] as const) {
      for (const to of ['requested', 'publishing', 'confirmed', 'unroutable', 'failed', 'uncertain'] as const) expect(mayTransition(final, to)).toBe(false);
    }
    expect(reemissionAttemptOutcome(['requested'])).toBe('not_published');
    expect(reemissionAttemptOutcome(['requested', 'publishing'])).toBe('uncertain'); // a crash after publication began
    expect(reemissionAttemptOutcome(['requested', 'publishing', 'unroutable'])).toBe('unroutable');
    expect(() => reemissionAttemptOutcome(['requested', 'publishing', 'uncertain', 'confirmed'])).toThrow();
    expect(() => reemissionAttemptOutcome(['publishing', 'confirmed'])).toThrow();
  });
});

describe('migration ownership evidence', () => {
  const sum = 'a'.repeat(64);
  const q = (rows: { name: string; checksum: string | null }[]) => ({ query: async () => ({ rows, rowCount: rows.length }) }) as never;
  it('refuses an empty list, kit migrations and malformed checksums', () => {
    expect(() => migrationOwnership([])).toThrow(ReemissionRefused);
    expect(() => migrationOwnership([{ name: 'kit_0001_outbox_inbox.sql', checksum: sum }])).toThrow(ReemissionRefused);
    expect(() => migrationOwnership([{ name: '0001_init.sql', checksum: 'abc' }])).toThrow(ReemissionRefused);
  });
  it('confirms only when every listed migration is recorded with exactly its checksum', async () => {
    const own = migrationOwnership([{ name: '0001_init.sql', checksum: sum }, { name: '0002_more.sql', checksum: sum }]);
    expect(await own.confirm(q([{ name: '0001_init.sql', checksum: sum }, { name: '0002_more.sql', checksum: sum }]))).toBe(true);
    expect(await own.confirm(q([{ name: '0001_init.sql', checksum: sum }]))).toBe(false);
    expect(await own.confirm(q([{ name: '0001_init.sql', checksum: sum }, { name: '0002_more.sql', checksum: 'b'.repeat(64) }]))).toBe(false);
    expect(await own.confirm(q([{ name: '0001_init.sql', checksum: sum }, { name: '0002_more.sql', checksum: null }]))).toBe(false);
  });
});

describe('read-only eligibility inspection (S1c-3 R2a): the same row checks, nothing else', () => {
  const inspect = (h: Harness, input: unknown) => inspectReemissionEligibility({ policy: h.opts.policy, db: h.opts.db, ownership: h.opts.ownership, evidence: h.opts.evidence }, input);
  const target = { eventId: EVENT_ID, eventName: 'payment.succeeded' };

  it('an eligible row: its identity, version and pipeline only (no payload, no correlation id), with nothing authorized, recorded or published', async () => {
    const h = harness();
    const r = await inspect(h, target);
    expect(r).toStrictEqual({ rowEligible: true, eventId: EVENT_ID, eventName: 'payment.succeeded', eventVersion: 1, pipelineVersion: 1, occurredAt: '2026-10-23T08:15:30.123Z', publishedAt: '2026-10-23T08:15:31.000Z' });
    expect(JSON.stringify(r)).not.toMatch(/TND|corr-/);
    expect(h.log).toStrictEqual(['tx', 'sql:SET TRANSACTION READ', 'ownership', 'sql:SELECT id, name,', 'evidence:false']);
    expect(h.log.some((l) => /authorize|commitIntent|append:|publish/.test(l))).toBe(false);
    expect(h.plans).toStrictEqual([]);
  });

  it.each([
    ['the database is not confirmed as the producer\'s', { owned: false }, 'database_ownership_unconfirmed'],
    ['a missing row', { row: null }, 'row_missing'],
    ['a row of another name', { row: storedRow({ name: 'payment.failed' }) }, 'row_name_mismatch'],
    ['an unpublished row', { row: storedRow({ publishedAt: null as never }) }, 'row_unpublished'],
    ['an unsupported version', { row: storedRow({ eventVersion: 2 }) }, 'version_not_allowed'],
    ['no publication evidence', { pipeline: undefined }, 'pipeline_unknown'],
    ['an incompatible pipeline', { pipeline: 2 }, 'pipeline_incompatible'],
    ['a lookup failure', { lookupThrows: true }, 'lookup_failed'],
  ] as const)('answers %s with the same code reemit refuses with', async (_t, over, code) => {
    const h = harness(over as never);
    expect(await inspect(h, target)).toStrictEqual({ rowEligible: false, reason: code });
    const r = harness(over as never);
    expect(await refusal(new ProducerReemission(r.opts).reemit(request()))).toBe(code);
    expect(h.plans).toStrictEqual([]);
  });

  it.each([
    ['a reason (an inspection is not a request)', { ...target, reason: 'consumer_outage' }, 'request_invalid'],
    ['a payload', { ...target, payload: {} }, 'request_invalid'],
    ['a source', { ...target, source: 'billing-service' }, 'request_invalid'],
    ['a malformed id', { ...target, eventId: 'x' }, 'request_invalid'],
    ['a pattern', { ...target, eventName: 'payment.*' }, 'request_invalid'],
    ['a code-bearing name', { ...target, eventName: 'admin.operator_code_issued' }, 'code_bearing_event'],
    ['an event outside the policy', { ...target, eventName: 'payment.expired' }, 'event_not_allowed'],
    ['nothing', null, 'request_invalid'],
  ])('refuses %s before reading the database', async (_t, input, code) => {
    const h = harness();
    expect(await inspect(h, input)).toStrictEqual({ rowEligible: false, reason: code });
    expect(h.log).toStrictEqual([]);
  });

  it('refuses a hand-built policy outside the approvals', async () => {
    const h = harness();
    await expect(inspectReemissionEligibility({ ...h.opts, policy: { producer: 'auth-service', events: [{ name: 'member.contact_verification_requested', version: 1 }] } }, target)).rejects.toThrow(ReemissionRefused);
  });
});
