import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DbService, PollLoop, RateLimitService, describeFailure, runWithRequestContext, type DrainOutcome, type Queryable } from '@nawara/service-kit';
import { NOTIFICATION_CONFIG } from '../config/notification-config.token.js';
import type { NotificationConfig } from '../config/notification-config.js';
import { NotificationSecretCipher } from '../secrets/secret-cipher.js';
import type { VariableSchema } from '../templates/variables.js';
import { retryDelayMs } from './backoff.js';
import { DestinationLimiter } from './destination-limiter.js';
import { DELIVERY_PROVIDERS, boundedCode, boundedDiagnostic, type ChannelProvider, type ProviderCallContext, type ProviderDiagnostic, type ProviderRegistry, type ProviderResult } from './provider.js';
import { RenderError, render, type RenderedMessage } from './renderer.js';

/** One claim held by this instance: the delivery and its lease token (the exact `leaseUntil` this instance wrote). */
interface Claim {
  id: string;
  token: Date;
  /** Queued claims are renewed while earlier ones are processed; an active claim is not (its lease was set when it started). */
  phase: 'queued' | 'active' | 'done';
}

/** Everything the send path needs, read once per claim. The version is the PINNED one (`templateVersionId`), never the latest. */
interface DeliveryContext {
  id: string;
  notificationId: string;
  channel: 'EMAIL' | 'SMS';
  destination: string;
  locale: string;
  attempts: number;
  ambiguousResends: number;
  cancelledAt: Date | null;
  expiresAt: Date | null;
  data: Record<string, unknown>;
  secretCiphertext: Buffer | null;
  secretKeyId: string | null;
  sourceService: string;
  correlationId: string | null;
  templateKey: string;
  variables: VariableSchema;
  subject: string | null;
  bodyText: string;
  bodyHtml: string | null;
  smsMaxSegments: number | null;
}

export interface PassResult {
  recovered: number;
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  unconfirmed: number;
  resent: number;
  expired: number;
  cancelled: number;
}

/** A conditional write found the claim no longer ours (its lease expired and it was recovered): the result is refused, never applied. */
class LeaseLost extends Error {
  constructor() {
    super('lease_lost');
    this.name = 'LeaseLost';
  }
}

const TERMINAL = `('SENT', 'FAILED', 'UNCONFIRMED', 'EXPIRED', 'CANCELLED')`;
const LEASE = `date_trunc('milliseconds', now() + $LEASE * interval '1 millisecond')`;

/**
 * The delivery engine (SDD §8, §5, §12.1; Stage 16.7). One pass:
 *
 *   1. recover  expired leases, by durable evidence: a STARTED attempt means the provider MAY have been called → the attempt is
 *               AMBIGUOUS (`worker_lost`) and §8.5 applies; no attempt means no call was made (an attempt is committed BEFORE every
 *               call) → PENDING, due now.
 *   2. claim    due PENDING deliveries, `FOR UPDATE SKIP LOCKED`, in one statement: SENDING with a lease (the claim's token).
 *   3. process  with at most NOTIFICATION_WORKER_CONCURRENCY in flight; the queued claims are renewed every lease / 4. Per claim:
 *               pre-send checks (cancelled → CANCELLED, expired → EXPIRED, caller+template limit → FAILED rate_limited) → decrypt and
 *               render the pinned version (a render error → FAILED) → attempt STARTED, committed → the provider call, OUTSIDE any
 *               transaction, bounded by NOTIFICATION_PROVIDER_TIMEOUT_MS → ONE transaction: attempt outcome + delivery transition.
 *
 * The secret purge of SDD §12.1 is its own loop (`SecretPurgeWorker`); a delivery reaching the last terminal state also purges its
 * intent's secret in the same transaction.
 *
 * Every write after the claim is conditional on the claim's token (`status = 'SENDING' AND leaseUntil = token`) and the attempt's
 * `outcome = 'STARTED'`: a worker whose lease was recovered can never apply a late result. A failure anywhere leaves the rows as they
 * are; the lease then expires and step 1 decides from the evidence. The guarantee is exactly-once INTERNAL processing per claim and
 * at-least-once processing overall; an external send is never claimed to be exactly once (a provider can accept a call whose answer
 * is lost: §8.5 then applies).
 *
 * Log lines carry ids, the channel, the template key, attempt numbers, classes, codes and latency; never a destination, data, a
 * code, a rendered message, a ciphertext or a provider body.
 */
@Injectable()
export class DeliveryWorker implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown {
  private readonly log = new Logger('DeliveryWorker');
  private readonly loop: PollLoop;
  private readonly cipher: NotificationSecretCipher;
  private stopping?: Promise<unknown>;
  /** Set at shutdown start: no new claim is taken and no queued claim is started; the in-flight sends finish (bounded). */
  private shuttingDown = false;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
    @Inject(DELIVERY_PROVIDERS) private readonly providers: ProviderRegistry,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
    @Inject(DestinationLimiter) private readonly destinations: DestinationLimiter,
  ) {
    this.cipher = new NotificationSecretCipher(config.secretKeys, config.secretActiveKeyId);
    this.loop = new PollLoop(
      () => this.passOnce(),
      (e) => this.log.error(`notification_worker_pass_failure ${describeFailure(e)} — the next pass retries`),
      (ms) => this.log.warn(`worker_drain_timeout worker=notification_delivery drainTimeoutMs=${ms}`),
    );
  }

  /** The worker runs only when a provider is configured (NOTIFICATION_EMAIL_PROVIDER / NOTIFICATION_SMS_PROVIDER); otherwise deliveries stay PENDING. */
  onApplicationBootstrap(): void {
    if (Object.keys(this.providers).length > 0 && !this.destinations.configured) {
      throw new Error('a provider is configured but the destination limiter is not (NOTIFICATION_DESTINATION_LIMIT_KEY)'); // cannot happen via configuration
    }
    if (Object.keys(this.providers).length > 0 && this.config.delivery.intervalMs > 0) this.loop.start(this.config.delivery.intervalMs);
  }

  get running(): boolean {
    return this.loop.running;
  }

  /**
   * Stage 15.5: stop claiming at shutdown START, then drain the in-flight pass (bounded: provider timeout + 2 s) while the pool is still
   * open (the kit closes it in `onApplicationShutdown`, after every `beforeApplicationShutdown`). Queued claims are released, not sent.
   */
  onModuleDestroy(): void {
    this.shuttingDown = true;
    this.stopping ??= this.loop.stop(this.config.delivery.drainTimeoutMs);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    await (this.stopping ??= this.loop.stop(this.config.delivery.drainTimeoutMs));
  }

  /** Stops the poll loop only (tests and operators drive `passOnce` themselves); the shutdown hooks still drain. */
  stopPolling(): Promise<DrainOutcome> {
    return this.loop.stop(this.config.delivery.drainTimeoutMs);
  }

  /** One pass (the loop's unit; exposed for tests and operators). */
  async passOnce(): Promise<PassResult> {
    const r: PassResult = { recovered: 0, claimed: 0, sent: 0, retried: 0, failed: 0, unconfirmed: 0, resent: 0, expired: 0, cancelled: 0 };
    r.recovered = await this.recoverStale(r);
    if (this.shuttingDown) return r;
    const claims = await this.claim();
    r.claimed = claims.length;
    if (claims.length > 0) this.log.log(`notification_delivery_claimed count=${claims.length}`);
    if (claims.length > 0) await this.processAll(claims, r);
    return r;
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────── 1. recovery

  /**
   * Expired leases, decided from the attempt evidence (SDD §5.3, §8.5, §13). Ordered by intent so two recovering instances take the
   * intents' locks (the purge check) in the same order and cannot deadlock.
   */
  async recoverStale(r: PassResult): Promise<number> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{ id: string; notificationId: string }>(
        `SELECT id, "notificationId" FROM notification_delivery
          WHERE status = 'SENDING' AND "leaseUntil" < now() ORDER BY "notificationId", id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [this.config.delivery.batchSize],
      );
      for (const d of rows) {
        const started = await q.query(
          `UPDATE notification_delivery_attempt SET outcome = 'AMBIGUOUS', "completedAt" = now(), "failureCode" = 'worker_lost'
            WHERE "deliveryId" = $1 AND outcome = 'STARTED' RETURNING "attemptNumber"`,
          [d.id],
        );
        if (started.rowCount === 0) {
          // No attempt was started for this claim, so no provider call was made (the attempt is committed before every call): safe retry.
          await this.transition(q, d.id, null, `status = 'PENDING', "nextAttemptAt" = now(), "leaseUntil" = NULL`);
          this.log.warn(`notification_delivery_lease_recovered deliveryId=${d.id} evidence=no_attempt outcome=PENDING`);
        } else {
          const ctx = await this.context(q, d.id);
          const outcome = await this.ambiguous(q, ctx, null, 'worker_lost', r);
          this.log.warn(`notification_delivery_lease_recovered deliveryId=${d.id} evidence=started_attempt attempt=${started.rows[0].attemptNumber} outcome=${outcome}`);
        }
      }
      return rows.length;
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────── 2. claim

  /** Due PENDING deliveries, `FOR UPDATE SKIP LOCKED` (competing instances never take the same row), SENDING under a fresh lease. */
  async claim(): Promise<Claim[]> {
    const { rows } = await this.db.query<{ id: string; leaseUntil: Date; nextAttemptAt: Date }>(
      `WITH due AS (
         SELECT id, "nextAttemptAt" FROM notification_delivery
          WHERE status = 'PENDING' AND "nextAttemptAt" <= now() AND channel = ANY($3::text[])
          ORDER BY "nextAttemptAt", id LIMIT $1 FOR UPDATE SKIP LOCKED)
       UPDATE notification_delivery d SET status = 'SENDING', "nextAttemptAt" = NULL, "leaseUntil" = ${LEASE.replace('$LEASE', '$2')}
         FROM due WHERE d.id = due.id
       RETURNING d.id, d."leaseUntil", due."nextAttemptAt"`,
      [this.config.delivery.batchSize, this.config.delivery.leaseMs, Object.keys(this.providers)],
    );
    return rows.sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime()).map((row) => ({ id: row.id, token: row.leaseUntil, phase: 'queued' as const }));
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────── 3. process

  private async processAll(claims: Claim[], r: PassResult): Promise<void> {
    const renewEvery = this.config.delivery.leaseMs / 4;
    const renewal = setInterval(() => void this.renewQueued(claims), renewEvery);
    renewal.unref?.();
    let next = 0;
    try {
      await Promise.all(
        Array.from({ length: Math.min(this.config.delivery.concurrency, claims.length) }, async () => {
          while (next < claims.length && !this.shuttingDown) {
            const c = claims[next++];
            c.phase = 'active';
            try {
              await this.processOne(c, r);
            } catch (e) {
              // A failure leaves the rows as they are (a crash has the same effect): the lease expires and recovery decides from the evidence.
              this.log.error(`notification_delivery_process_failure deliveryId=${c.id} ${e instanceof LeaseLost ? 'error=LeaseLost — the claim was recovered by another pass; this result is refused' : describeFailure(e)}`);
            } finally {
              c.phase = 'done';
            }
          }
        }),
      );
    } finally {
      clearInterval(renewal);
    }
    if (next < claims.length) await this.release(claims.slice(next));
  }

  /** Shutdown: the claims never started (no attempt, so no provider call) go back to PENDING at once rather than waiting for the lease. */
  private async release(claims: Claim[]): Promise<void> {
    try {
      const { rowCount } = await this.db.query(
        `UPDATE notification_delivery d SET status = 'PENDING', "nextAttemptAt" = now(), "leaseUntil" = NULL
           FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::timestamptz[]) AS token) c
          WHERE d.id = c.id AND d.status = 'SENDING' AND d."leaseUntil" = c.token`,
        [claims.map((c) => c.id), claims.map((c) => c.token)],
      );
      this.log.log(`notification_delivery_released count=${rowCount ?? 0} reason=shutdown`);
    } catch (e) {
      this.log.warn(`notification_delivery_release_failure count=${claims.length} ${describeFailure(e)} — their leases expire and a later pass recovers them (no attempt: PENDING)`);
    }
  }

  /** The Stage 15.8 renewal: the claims not started yet keep their lease while earlier ones are sent (conditional on each token). */
  private async renewQueued(claims: Claim[]): Promise<void> {
    const queued = claims.filter((c) => c.phase === 'queued');
    if (queued.length === 0) return;
    try {
      const { rows } = await this.db.query<{ id: string; leaseUntil: Date }>(
        `UPDATE notification_delivery d SET "leaseUntil" = ${LEASE.replace('$LEASE', '$3')}
           FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::timestamptz[]) AS token) c
          WHERE d.id = c.id AND d.status = 'SENDING' AND d."leaseUntil" = c.token
         RETURNING d.id, d."leaseUntil"`,
        [queued.map((c) => c.id), queued.map((c) => c.token), this.config.delivery.leaseMs],
      );
      for (const row of rows) {
        const c = queued.find((x) => x.id === row.id);
        if (c && c.phase === 'queued') c.token = row.leaseUntil;
      }
    } catch (e) {
      this.log.warn(`notification_delivery_renewal_failure pending=${queued.length} ${describeFailure(e)} — the unsent claims may be recovered by another pass (no provider call was made for them)`);
    }
  }

  async processOne(c: Claim, r: PassResult): Promise<void> {
    const ctx = await this.context(this.db, c.id);
    const who = `notificationId=${ctx.notificationId} deliveryId=${ctx.id} channel=${ctx.channel} template=${ctx.templateKey}`;
    await runWithRequestContext({ requestId: `delivery:${ctx.id}`, correlationId: ctx.correlationId ?? `notification:${ctx.notificationId}` }, async () => {
      // Pre-send checks, read AFTER the claim (SDD §9.3): a cancel or an expiry that happened meanwhile wins, and no attempt is made.
      if (ctx.cancelledAt) {
        await this.db.tx(async (q) => {
          await this.transition(q, c.id, c.token, `status = 'PENDING', "nextAttemptAt" = now(), "leaseUntil" = NULL`);
          await q.query(`UPDATE notification_delivery SET status = 'CANCELLED', "nextAttemptAt" = NULL, "completedAt" = now() WHERE id = $1 AND status = 'PENDING'`, [c.id]);
          await this.purgeIfFinished(q, ctx.notificationId);
        });
        r.cancelled++;
        this.log.log(`notification_delivery_cancelled ${who} stage=pre_send`);
        return;
      }
      if (ctx.expiresAt && ctx.expiresAt.getTime() <= Date.now()) {
        await this.db.tx(async (q) => {
          await this.transition(q, c.id, c.token, `status = 'EXPIRED', "leaseUntil" = NULL, "completedAt" = now()`);
          await this.purgeIfFinished(q, ctx.notificationId);
        });
        r.expired++;
        this.log.log(`notification_delivery_expired ${who} stage=pre_send`);
        return;
      }
      const limit = await this.limits.hit('notif_caller_template', `${ctx.sourceService}:${ctx.templateKey}`, { limit: this.config.delivery.callerTemplateLimitPerMinute, windowSec: 60 });
      if (!limit.allowed) return this.fail(c, ctx, 'terminal', 'rate_limited', r, `${who} bucket=notif_caller_template`);
      // D21 (Stage 16.9): per channel + destination, keyed by an HMAC under the dedicated limiter key. A failure here throws: nothing is
      // sent, and the claim (no attempt yet) is recovered as PENDING once its lease expires.
      if (!(await this.destinations.allow(ctx.channel, ctx.destination))) return this.fail(c, ctx, 'terminal', 'rate_limited', r, `${who} bucket=notif_dest`);

      const provider = this.providers[ctx.channel];
      if (!provider) throw new Error('no provider for this channel'); // cannot happen: the claim takes only channels with a provider

      // Decrypt as late as possible; the plaintext lives in `message` only, until the provider call returns.
      let message: RenderedMessage | undefined;
      try {
        const secrets = ctx.secretCiphertext && ctx.secretKeyId ? this.cipher.open(ctx.secretCiphertext, ctx.secretKeyId, ctx.notificationId) : {};
        message = render(ctx, { ...ctx.data, ...secrets }, ctx.destination, this.config.delivery.timeZone);
      } catch (e) {
        return this.fail(c, ctx, 'terminal', e instanceof RenderError ? e.code : 'render_failed', r, who);
      }

      const attempt = await this.startAttempt(c, provider);
      const t0 = Date.now();
      const result = await this.callProvider(provider, message, { reference: ctx.id, attemptId: attempt.id, idempotencyKey: attempt.idempotencyKey });
      message = undefined; // release the rendered content (and the code in it) as early as possible
      const latencyMs = Date.now() - t0;
      await this.finish(c, ctx, attempt, provider, result, latencyMs, r, who);
    });
  }

  /**
   * Attempt STARTED, committed BEFORE the provider call (the evidence recovery relies on), and a fresh lease for this call. The provider
   * idempotency key counts the definite (RETRYABLE_FAILURE) answers so far: it is unchanged by an ambiguous attempt, so a §8.5 resend
   * carries the key of the attempt whose answer was lost; it changes after the provider definitely answered (a provider may keep a
   * failed request's answer under its key, and must not replay it to a real retry).
   */
  async startAttempt(c: Claim, provider: ChannelProvider): Promise<{ id: string; number: number; idempotencyKey: string }> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{ attempts: number; leaseUntil: Date }>(
        `UPDATE notification_delivery SET attempts = attempts + 1, provider = $3, "leaseUntil" = ${LEASE.replace('$LEASE', '$4')}
          WHERE id = $1 AND status = 'SENDING' AND "leaseUntil" = $2 RETURNING attempts, "leaseUntil"`,
        [c.id, c.token, provider.id, this.config.delivery.leaseMs],
      );
      if (rows.length === 0) throw new LeaseLost();
      const id = randomUUID();
      await q.query(`INSERT INTO notification_delivery_attempt (id, "deliveryId", "attemptNumber", provider) VALUES ($1, $2, $3, $4)`, [id, c.id, rows[0].attempts, provider.id]);
      c.token = rows[0].leaseUntil;
      const definite = await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM notification_delivery_attempt WHERE "deliveryId" = $1 AND outcome = 'RETRYABLE_FAILURE'`,
        [c.id],
      );
      return { id, number: rows[0].attempts, idempotencyKey: `nawara-notification/${c.id}/${definite.rows[0].n}` };
    });
  }

  /**
   * The provider call, bounded twice: the engine's timer decides the outcome at NOTIFICATION_PROVIDER_TIMEOUT_MS whatever the adapter
   * does, and the same moment aborts the adapter's signal so its socket is released too. An exception or a timeout is AMBIGUOUS:
   * nothing proves the provider did not accept the message.
   */
  async callProvider(provider: ChannelProvider, message: RenderedMessage, call: Omit<ProviderCallContext, 'signal'>): Promise<ProviderResult> {
    let timer: NodeJS.Timeout | undefined;
    const abort = new AbortController();
    try {
      return await Promise.race([
        Promise.resolve().then(() => provider.send(message, { ...call, signal: abort.signal })).then((r) => this.checked(r)),
        new Promise<ProviderResult>((resolve) => {
          timer = setTimeout(() => {
            abort.abort();
            resolve({ kind: 'ambiguous', code: 'provider_timeout' });
          }, this.config.delivery.providerTimeoutMs);
        }),
      ]);
    } catch (e) {
      this.log.error(`notification_provider_failure provider=${provider.id} class=ambiguous code=provider_error ${describeFailure(e)}`);
      return { kind: 'ambiguous', code: 'provider_error' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** A result outside the port contract is AMBIGUOUS: nothing proves what the provider did with the message. */
  private checked(r: unknown): ProviderResult {
    const x = r as Partial<ProviderResult> & { failureClass?: unknown; providerMessageId?: unknown };
    if (x?.kind === 'accepted' && typeof x.providerMessageId === 'string' && /^[\x21-\x7e]{1,256}$/.test(x.providerMessageId)) return x as ProviderResult;
    if (x?.kind === 'accepted') {
      // Accepted, but with no usable reference: the send happened; the result is recorded without the id rather than risk a resend.
      this.log.warn(`notification_provider_failure class=accepted code=provider_reference_invalid — the accepted result's message id is missing or unbounded`);
      return { kind: 'accepted', providerMessageId: '', diagnostic: (x as { diagnostic?: ProviderDiagnostic }).diagnostic };
    }
    if (x?.kind === 'rejected' && (x.failureClass === 'retryable' || x.failureClass === 'terminal')) return x as ProviderResult;
    if (x?.kind === 'ambiguous') return x as ProviderResult;
    this.log.error(`notification_provider_failure class=ambiguous code=provider_invalid_result — the provider returned a result outside the port contract`);
    return { kind: 'ambiguous', code: 'provider_invalid_result' };
  }

  /** ONE transaction: the attempt outcome and the delivery transition, both conditional on this claim still being ours. */
  private async finish(c: Claim, ctx: DeliveryContext, attempt: { id: string; number: number }, provider: ChannelProvider, result: ProviderResult, latencyMs: number, r: PassResult, who: string): Promise<void> {
    const outcome = result.kind === 'accepted' ? 'ACCEPTED' : result.kind === 'ambiguous' ? 'AMBIGUOUS' : result.failureClass === 'retryable' ? 'RETRYABLE_FAILURE' : 'TERMINAL_FAILURE';
    const code = result.kind === 'accepted' ? null : boundedCode(result.code, result.kind === 'ambiguous' ? 'provider_ambiguous' : 'provider_rejected');
    const messageId = result.kind === 'accepted' && result.providerMessageId !== '' ? result.providerMessageId : null;
    const diag = boundedDiagnostic(result.diagnostic);
    const line = `${who} attempt=${attempt.number} provider=${provider.id} latencyMs=${latencyMs}${diag?.httpStatus ? ` httpStatus=${diag.httpStatus}` : ''}${diag?.providerCode ? ` providerCode=${diag.providerCode}` : ''}`;
    // SDD §8.3: our credentials or sender configuration refused: retryable (bounded by the attempt budget), but a fault that must alert.
    if (code === 'provider_auth_fault' || code === 'provider_config_fault') this.log.error(`${code} ${line}`);
    await this.db.tx(async (q) => {
      const done = await q.query(
        `UPDATE notification_delivery_attempt SET outcome = $2, "completedAt" = now(), "providerMessageId" = $3, "failureCode" = $4, "latencyMs" = $5
          WHERE id = $1 AND outcome = 'STARTED'`,
        [attempt.id, outcome, messageId, code, latencyMs],
      );
      if (done.rowCount === 0) throw new LeaseLost(); // recovery already recorded this attempt as AMBIGUOUS: never overwrite evidence
      if (result.kind === 'accepted') {
        await this.transition(q, c.id, c.token, `status = 'SENT', "leaseUntil" = NULL, "sentAt" = now(), "completedAt" = now(), "providerMessageId" = $3, "failureClass" = NULL, "failureCode" = NULL`, [messageId]);
        await this.purgeIfFinished(q, ctx.notificationId);
        r.sent++;
        this.log.log(`notification_delivery_sent ${line}`);
      } else if (result.kind === 'ambiguous') {
        const next = await this.ambiguous(q, { ...ctx, attempts: attempt.number }, c.token, code!, r);
        this.log.warn(`notification_provider_failure ${line} class=ambiguous code=${code} outcome=${next}`);
      } else if (result.failureClass === 'terminal') {
        await this.failIn(q, c, ctx, 'terminal', code!);
        r.failed++;
        this.log.warn(`notification_provider_failure ${line} class=terminal code=${code} outcome=FAILED`);
      } else if (attempt.number >= this.config.delivery.maxAttempts) {
        await this.failIn(q, c, ctx, 'retryable', 'retries_exhausted');
        r.failed++;
        this.log.warn(`notification_delivery_failed ${line} code=retries_exhausted lastCode=${code}`);
      } else {
        const d = this.config.delivery;
        const due = new Date(Date.now() + retryDelayMs(attempt.number, { baseMs: d.retryBaseMs, ceilingMs: d.retryCeilingMs, retryAfterMs: result.retryAfterMs }));
        if (ctx.expiresAt && due.getTime() >= ctx.expiresAt.getTime()) {
          await this.transition(q, c.id, c.token, `status = 'EXPIRED', "leaseUntil" = NULL, "completedAt" = now(), "failureClass" = 'retryable', "failureCode" = $3`, [code]);
          await this.purgeIfFinished(q, ctx.notificationId);
          r.expired++;
          this.log.warn(`notification_delivery_expired ${line} stage=retry lastCode=${code}`);
        } else {
          await this.transition(q, c.id, c.token, `status = 'PENDING', "leaseUntil" = NULL, "nextAttemptAt" = $3, "failureClass" = 'retryable', "failureCode" = $4`, [due, code]);
          r.retried++;
          this.log.warn(`notification_delivery_retry_scheduled ${line} code=${code} dueInMs=${due.getTime() - Date.now()}`);
        }
      }
    });
  }

  /**
   * SDD §8.5 (frozen): a notification carrying a sealed secret (a one-time code), not yet resent after an ambiguity and not expired, is
   * sent ONCE more with the same code (PENDING, due now, `ambiguousResends = 1`). Anything else ends UNCONFIRMED and is never resent.
   */
  private async ambiguous(q: Queryable, ctx: DeliveryContext, token: Date | null, code: string, r: PassResult): Promise<'PENDING' | 'UNCONFIRMED'> {
    const resend = ctx.secretCiphertext !== null && ctx.ambiguousResends === 0 && ctx.expiresAt !== null && ctx.expiresAt.getTime() > Date.now();
    if (resend) {
      await this.transition(q, ctx.id, token, `status = 'PENDING', "leaseUntil" = NULL, "nextAttemptAt" = now(), "ambiguousResends" = 1, "failureClass" = 'ambiguous', "failureCode" = $3`, [code]);
      r.resent++;
      this.log.warn(`notification_delivery_resend_after_ambiguity notificationId=${ctx.notificationId} deliveryId=${ctx.id} code=${code}`);
      return 'PENDING';
    }
    await this.transition(q, ctx.id, token, `status = 'UNCONFIRMED', "leaseUntil" = NULL, "completedAt" = now(), "failureClass" = 'ambiguous', "failureCode" = $3`, [code]);
    await this.purgeIfFinished(q, ctx.notificationId);
    r.unconfirmed++;
    this.log.warn(`notification_delivery_unconfirmed notificationId=${ctx.notificationId} deliveryId=${ctx.id} code=${code}`);
    return 'UNCONFIRMED';
  }

  private async fail(c: Claim, ctx: DeliveryContext, failureClass: 'terminal' | 'retryable', code: string, r: PassResult, who: string): Promise<void> {
    await this.db.tx((q) => this.failIn(q, c, ctx, failureClass, code));
    r.failed++;
    this.log.warn(`notification_delivery_failed ${who} code=${code}`);
  }

  private async failIn(q: Queryable, c: Claim, ctx: DeliveryContext, failureClass: 'terminal' | 'retryable', code: string): Promise<void> {
    await this.transition(q, c.id, c.token, `status = 'FAILED', "leaseUntil" = NULL, "failedAt" = now(), "completedAt" = now(), "failureClass" = $3, "failureCode" = $4`, [failureClass, code]);
    await this.purgeIfFinished(q, ctx.notificationId);
  }

  /**
   * A transition of OUR claim only: `status = 'SENDING' AND leaseUntil = token`, else the claim was recovered and nothing is written.
   * Recovery passes `null`: it holds the row lock of an EXPIRED lease (taken in the same transaction), so no token is needed.
   */
  private async transition(q: Queryable, id: string, token: Date | null, set: string, extra: unknown[] = []): Promise<void> {
    const { rowCount } = await q.query(
      `UPDATE notification_delivery SET ${set} WHERE id = $1 AND status = 'SENDING' AND ($2::timestamptz IS NULL AND "leaseUntil" < now() OR "leaseUntil" = $2)`,
      [id, token, ...extra],
    );
    if (rowCount === 0) throw new LeaseLost();
  }

  /**
   * The secret is purged in the same transaction as the last delivery becoming terminal (SDD §12.1). The intent row is locked FIRST, in
   * its own statement: two deliveries of one intent finishing at once then serialize here, and the second one's check (a fresh
   * snapshot) sees the first as terminal. Without it each sees the other still SENDING and neither purges.
   */
  private async purgeIfFinished(q: Queryable, notificationId: string): Promise<void> {
    await q.query(`SELECT 1 FROM notification WHERE id = $1 FOR UPDATE`, [notificationId]);
    await q.query(
      `UPDATE notification SET "secretCiphertext" = NULL, "secretKeyId" = NULL
        WHERE id = $1 AND "secretCiphertext" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM notification_delivery WHERE "notificationId" = $1 AND status NOT IN ${TERMINAL})`,
      [notificationId],
    );
  }

  private async context(q: Queryable, id: string): Promise<DeliveryContext> {
    const { rows } = await q.query<DeliveryContext>(
      `SELECT d.id, d."notificationId", d.channel, d.destination, d.locale, d.attempts, d."ambiguousResends",
              n."cancelledAt", n."expiresAt", n.data, n."secretCiphertext", n."secretKeyId", n."sourceService", n."correlationId",
              t.key AS "templateKey", v.variables, v.subject, v."bodyText", v."bodyHtml", v."smsMaxSegments"
         FROM notification_delivery d
         JOIN notification n ON n.id = d."notificationId"
         JOIN notification_template_version v ON v.id = d."templateVersionId"
         JOIN notification_template t ON t.id = v."templateId"
        WHERE d.id = $1`,
      [id],
    );
    if (!rows[0]) throw new Error('delivery not found');
    return rows[0];
  }
}
