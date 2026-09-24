import { randomUUID } from 'node:crypto';
import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, RateLimitService, getRequestContext, type Queryable } from '@nawara/service-kit';
import { NOTIFICATION_CONFIG } from '../config/notification-config.token.js';
import type { NotificationConfig } from '../config/notification-config.js';
import { isValidDestination } from '../intake/destination.js';
import { IntentCore, type PublishedVersion } from '../intake/intent-core.js';
import { validateVariableValues } from '../templates/variables.js';
import { matchesRequestHash, requestHash } from './request-hash.js';
import { IDEMPOTENCY_KEY, parseSendRequest } from './send-request.js';

const fail = (status: number, code: string, message: string | string[]): never => {
  throw new HttpException({ message, code }, status);
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORRELATION = /^[A-Za-z0-9._:-]{1,128}$/;
const TERMINAL = new Set(['SENT', 'FAILED', 'UNCONFIRMED', 'EXPIRED', 'CANCELLED']);

export interface AcceptedResponse {
  id: string;
  status: 'accepted';
  deliveries: Array<{ id: string; channel: string; status: 'PENDING' }>;
}
export interface NotificationView {
  id: string;
  template: string;
  category: string;
  organizationId: string | null;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  createdAt: string;
  scheduledAt: string | null;
  expiresAt: string | null;
  cancelledAt: string | null;
  deliveries: Array<{ id: string; channel: string; status: string; attempts: number; locale: string; templateVersion: number; destinationHint: string | null; sentAt: string | null; failureCode: string | null }>;
}

/**
 * The internal send API (SDD §7.2, §9, §11), for authenticated Core services. It records durable work only: an intent and its PENDING
 * deliveries, committed before the `202`. It never calls a provider and never creates an attempt (Stage 16.7 sends).
 *
 * Identity and idempotency: `(authenticated caller, Idempotency-Key)` on `notification` (the 16.4 partial unique index), with the
 * keyed request hash (`request-hash.ts`). Same key and same hash → the original `202` replayed; same key, different hash → `422
 * idempotency_key_reused`; another caller's key is another namespace. A concurrent copy loses the insert (`ON CONFLICT DO NOTHING`)
 * and is answered from the winner's row.
 *
 * Log lines carry the caller, ids, the template key and channels; never the body, a destination, data, a code or the hash key.
 */
@Injectable()
export class NotificationApiService {
  private readonly log = new Logger('NotificationApi');

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(IntentCore) private readonly core: IntentCore,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
  ) {}

  async send(caller: string, idempotencyKey: string | undefined, body: unknown): Promise<AcceptedResponse> {
    if (idempotencyKey === undefined || idempotencyKey === '') fail(400, 'idempotency_key_required', 'The Idempotency-Key header is required.');
    if (!IDEMPOTENCY_KEY.test(idempotencyKey!)) fail(400, 'validation_error', ['Idempotency-Key: must be 8-128 characters of letters, digits and . _ : -']);
    const parsed = parseSendRequest(body);
    if ('problems' in parsed) return fail(400, 'validation_error', parsed.problems);
    const req = parsed.value;

    const policy = this.config.callerPolicy.of(caller);
    if (!policy || !policy.templates.has(req.template)) return this.refuse(caller, 403, 'template_not_allowed', 'This caller may not use this template.');
    if (req.channels.some((c) => !policy.channels.has(c.channel))) return this.refuse(caller, 403, 'channel_not_allowed', 'This caller may not use this channel.');
    if (req.organizationId !== null && policy.organizations !== 'request') return this.refuse(caller, 403, 'organization_not_allowed', 'This caller may not address an organization.');
    await this.limits.assert('notif_api_caller', caller, { limit: this.config.apiIntakeLimitPerMinute, windowSec: 60 });

    const hash = requestHash(this.config.requestHashKey, body);
    const existing = await this.findApiIntent(this.db, caller, idempotencyKey!);
    if (existing) return this.replayOrConflict(caller, existing, body);

    if (new Set(req.channels.map((c) => c.channel)).size !== req.channels.length) return this.refuse(caller, 422, 'duplicate_channel', 'A channel is listed twice: one delivery per channel.');
    const now = Date.now();
    const scheduled = req.scheduledAt ? Date.parse(req.scheduledAt) : null;
    const expires = req.expiresAt ? Date.parse(req.expiresAt) : null;
    if (scheduled !== null && (scheduled <= now || scheduled > now + this.config.maxScheduleAheadSec * 1000)) {
      return this.refuse(caller, 422, 'schedule_out_of_range', `scheduledAt must be in the future and at most ${this.config.maxScheduleAheadSec} s ahead.`);
    }
    if (expires !== null && (expires <= now || (scheduled !== null && expires <= scheduled))) {
      return this.refuse(caller, 422, 'schedule_out_of_range', 'expiresAt must be in the future and after scheduledAt.');
    }

    const versions: Array<{ channel: 'EMAIL' | 'SMS'; destination: string; version: PublishedVersion }> = [];
    for (const c of req.channels) {
      const version = await this.core.activeVersion(req.template, c.channel, req.locale);
      if (!version) return this.refuse(caller, 404, 'unknown_template', 'No published version of this template exists for this channel.');
      versions.push({ ...c, version });
    }
    for (const v of versions) {
      const invalid = validateVariableValues(v.version.variables, req.data);
      if (invalid.length > 0) return this.refuse(caller, 422, 'invalid_template_data', invalid.map((e) => e.split(':')[0]).map((n) => `${n}: is invalid`));
    }
    const bad = versions.filter((v) => !isValidDestination(v.channel, v.destination)).map((v) => v.channel);
    if (bad.length > 0) return this.refuse(caller, 422, 'invalid_destination', `The ${bad.join(' and ')} destination is not valid (SMS: E.164 such as +21620000000; EMAIL: an address).`);

    const notificationId = randomUUID();
    const { data, secrets } = this.core.split(versions[0].version.variables, req.data);
    const sealed = this.core.seal(secrets, notificationId);
    const correlation = getRequestContext()?.correlationId;
    const deliveries = versions.map((v) => ({ id: randomUUID(), ...v })).sort((a, b) => a.channel.localeCompare(b.channel));

    const created = await this.db.tx(async (q) => {
      const ins = await q.query(
        `INSERT INTO notification (id, "sourceKind", "sourceService", "idempotencyKey", "requestHash", "templateId", category, "organizationId",
           "recipientType", "recipientId", "requestedLocale", data, "secretCiphertext", "secretKeyId", "scheduledAt", "expiresAt", "correlationId")
         VALUES ($1, 'api', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT ("sourceService", "idempotencyKey") WHERE "sourceKind" = 'api' DO NOTHING
         RETURNING id`,
        [notificationId, caller, idempotencyKey, hash, versions[0].version.templateId, versions[0].version.category, req.organizationId,
          req.recipient?.type ?? null, req.recipient?.id ?? null, req.locale, JSON.stringify(data), sealed?.ciphertext ?? null, sealed?.keyId ?? null,
          req.scheduledAt, req.expiresAt, correlation && CORRELATION.test(correlation) ? correlation : null],
      );
      if (ins.rowCount === 0) return false; // a concurrent request with this key won
      for (const d of deliveries) await this.core.insertDelivery(q, { id: d.id, notificationId, channel: d.channel, destination: d.destination, version: d.version, dueAt: req.scheduledAt });
      return true;
    });
    if (!created) {
      const winner = await this.findApiIntent(this.db, caller, idempotencyKey!);
      if (!winner) throw new Error('idempotency key vanished after a conflicting insert'); // cannot happen: rows are never deleted by the API
      return this.replayOrConflict(caller, winner, body);
    }
    this.log.log(`notification_api_accepted caller=${caller} notificationId=${notificationId} template=${req.template} channels=${deliveries.map((d) => d.channel).join(',')} scheduled=${req.scheduledAt ? 'yes' : 'no'}`);
    return { id: notificationId, status: 'accepted', deliveries: deliveries.map((d) => ({ id: d.id, channel: d.channel, status: 'PENDING' })) };
  }

  async get(caller: string, id: string): Promise<NotificationView> {
    return (await this.view(this.db, caller, id)) ?? fail(404, 'notification_not_found', 'Notification not found.');
  }

  /**
   * Cancellation (SDD §7.2, §9.3), in one transaction on the locked intent: the cancel stamp is set (once) while any delivery is PENDING
   * or SENDING, and every PENDING delivery becomes CANCELLED. A SENDING delivery cannot be recalled: `409 delivery_in_progress` (the
   * pending ones ARE cancelled). Repeating it, or cancelling a notification whose deliveries are all terminal, changes nothing and is `200`.
   */
  async cancel(caller: string, id: string): Promise<NotificationView> {
    if (!UUID.test(id)) fail(404, 'notification_not_found', 'Notification not found.');
    const outcome = await this.db.tx(async (q) => {
      const own = await q.query(`SELECT 1 FROM notification WHERE id = $1 AND "sourceService" = $2 FOR UPDATE`, [id, caller]);
      if (own.rowCount === 0) return undefined;
      const { rows } = await q.query<{ status: string }>(`SELECT status FROM notification_delivery WHERE "notificationId" = $1`, [id]);
      if (rows.some((r) => r.status === 'PENDING' || r.status === 'SENDING')) {
        await q.query(`UPDATE notification SET "cancelledAt" = now(), "cancelledBy" = $2 WHERE id = $1 AND "cancelledAt" IS NULL`, [id, caller]);
      }
      const cancelled = await q.query(
        `UPDATE notification_delivery SET status = 'CANCELLED', "nextAttemptAt" = NULL, "completedAt" = now() WHERE "notificationId" = $1 AND status = 'PENDING'`,
        [id],
      );
      return { cancelled: cancelled.rowCount ?? 0, sending: rows.filter((r) => r.status === 'SENDING').length, view: await this.view(q, caller, id) };
    });
    if (!outcome) return fail(404, 'notification_not_found', 'Notification not found.');
    this.log.log(`notification_cancelled caller=${caller} notificationId=${id} cancelledDeliveries=${outcome.cancelled} inProgress=${outcome.sending}`);
    if (outcome.sending > 0) {
      fail(409, 'delivery_in_progress', `${outcome.cancelled} pending deliveries were cancelled; ${outcome.sending} already being sent cannot be recalled.`);
    }
    return outcome.view!;
  }

  private async findApiIntent(q: Queryable, caller: string, key: string): Promise<{ id: string; requestHash: string } | undefined> {
    const { rows } = await q.query<{ id: string; requestHash: string }>(
      `SELECT id, "requestHash" FROM notification WHERE "sourceKind" = 'api' AND "sourceService" = $1 AND "idempotencyKey" = $2`,
      [caller, key],
    );
    return rows[0];
  }

  /** The original `202` for the same request (rebuilt from the rows: always `accepted` / PENDING, as first answered), else a conflict. */
  private async replayOrConflict(caller: string, existing: { id: string; requestHash: string }, body: unknown): Promise<AcceptedResponse> {
    if (!matchesRequestHash(existing.requestHash, [this.config.requestHashKey, ...this.config.requestHashPreviousKeys], body)) {
      return this.refuse(caller, 422, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request.');
    }
    const { rows } = await this.db.query<{ id: string; channel: string }>(`SELECT id, channel FROM notification_delivery WHERE "notificationId" = $1 ORDER BY channel`, [existing.id]);
    this.log.log(`notification_api_replayed caller=${caller} notificationId=${existing.id}`);
    return { id: existing.id, status: 'accepted', deliveries: rows.map((r) => ({ id: r.id, channel: r.channel, status: 'PENDING' })) };
  }

  /** The caller's own notification, or undefined (another caller's notification is indistinguishable from a missing one). */
  private async view(q: Queryable, caller: string, id: string): Promise<NotificationView | undefined> {
    if (!UUID.test(id)) return undefined;
    const { rows } = await q.query<Record<string, any>>(
      `SELECT n.id, t.key, n.category, n."organizationId", n."createdAt", n."scheduledAt", n."expiresAt", n."cancelledAt"
         FROM notification n JOIN notification_template t ON t.id = n."templateId" WHERE n.id = $1 AND n."sourceService" = $2`,
      [id, caller],
    );
    const n = rows[0];
    if (!n) return undefined;
    const d = (
      await q.query<Record<string, any>>(
        `SELECT d.id, d.channel, d.status, d.attempts, d.locale, v.version, d.destination, d."sentAt", d."failureCode"
           FROM notification_delivery d JOIN notification_template_version v ON v.id = d."templateVersionId" WHERE d."notificationId" = $1 ORDER BY d.channel`,
        [id],
      )
    ).rows;
    const allTerminal = d.every((x) => TERMINAL.has(x.status));
    const status = !allTerminal ? 'IN_PROGRESS' : n.cancelledAt ? 'CANCELLED' : 'COMPLETED';
    const iso = (v: Date | null) => (v ? v.toISOString() : null);
    return {
      id: n.id, template: n.key, category: n.category, organizationId: n.organizationId, status,
      createdAt: n.createdAt.toISOString(), scheduledAt: iso(n.scheduledAt), expiresAt: iso(n.expiresAt), cancelledAt: iso(n.cancelledAt),
      deliveries: d.map((x) => ({
        id: x.id, channel: x.channel, status: x.status, attempts: x.attempts, locale: x.locale, templateVersion: x.version,
        destinationHint: x.destination ? `…${x.destination.slice(-2)}` : null, sentAt: iso(x.sentAt), failureCode: x.failureCode,
      })),
    };
  }

  private refuse(caller: string, status: number, code: string, message: string | string[]): never {
    this.log.warn(`notification_api_rejected caller=${caller} status=${status} code=${code}`);
    return fail(status, code, message);
  }
}
