import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, PermanentEventFailure, type EventEnvelope, type Queryable } from '@nawara/service-kit';
import { NOTIFICATION_CONFIG } from '../config/notification-config.token.js';
import type { NotificationConfig } from '../config/notification-config.js';
import { NotificationSecretCipher } from '../secrets/secret-cipher.js';
import { validateVariableValues, type VariableSchema } from '../templates/variables.js';
import { isValidDestination, type DeliveryChannel } from './destination.js';
import { mappingFor, payloadProblems, type EventMapping } from './event-map.js';
import { resolveLocale } from './locale.js';

/** What the intake did with one event: a new intent, or a duplicate of one already recorded (nothing written). */
export type IntakeOutcome = { kind: 'accepted'; notificationId: string; deliveryId: string; invalidDestination: boolean } | { kind: 'duplicate' };

const CORRELATION = /^[A-Za-z0-9._:-]{1,128}$/;

interface PublishedVersion {
  templateId: string;
  category: string;
  versionId: string;
  locale: string;
  version: number;
  variables: VariableSchema;
}

/**
 * Event intake (SDD §7.1, Stage 16.5): a canonical event becomes a durable notification intent and its delivery, in ONE transaction,
 * and nothing else. No provider is called, no attempt is created, no delivery leaves `PENDING` (except an undeliverable destination,
 * below). The handler returns only after the commit; the kit acknowledges only after the handler returns.
 *
 * Failure classes (SDD §13):
 * - permanent (`PermanentEventFailure`, dead-lettered at once, nothing written): an unmapped event, an unsupported version, a
 *   malformed payload, no destination, an unknown template, invalid template data;
 * - transient (anything else, e.g. the database is down): nothing committed, the kit retries 3 x 5 s, then dead-letters;
 * - duplicate: the event identity `(sourceService, sourceEventId)` already exists: nothing written, acknowledged;
 * - an invalid destination (not E.164 for SMS, not an email address for EMAIL) is NOT a malformed event: the intent is recorded and
 *   its delivery ends `FAILED invalid_destination` in the same transaction, visibly, never sent and never retried (SDD §7.1, D20).
 *
 * Log lines carry ids, names and classes only: never the payload, a destination, a code or any template data.
 */
@Injectable()
export class IntakeService {
  private readonly log = new Logger('EventIntake');
  private readonly cipher: NotificationSecretCipher;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
  ) {
    this.cipher = new NotificationSecretCipher(config.secretKeys, config.secretActiveKeyId);
  }

  async handle(event: EventEnvelope): Promise<IntakeOutcome> {
    const who = `eventId=${event.id} name=${event.name} source=${event.headers.source} correlationId=${event.headers.correlationId ?? '-'}`;
    const reject = (reason: string, detail = ''): never => {
      this.log.warn(`notification_event_rejected ${who} reason=${reason}${detail}`);
      throw new PermanentEventFailure(reason);
    };

    const m = mappingFor(event.headers.source, event.name);
    if (!m) return reject('unmapped_event');
    if (event.headers.version !== m.version) return reject('unsupported_version', ` version=${Number(event.headers.version) || '-'}`);
    const bad = payloadProblems(m, event.payload);
    if (bad.length > 0) return reject('malformed_payload', ` fields=${bad.join(',')}`);
    const p = event.payload;
    if (p.destination === null) return reject('no_destination');

    const channel: DeliveryChannel = p.channel === 'phone' ? 'SMS' : 'EMAIL';
    const destination = p.destination as string;
    const version = await this.publishedVersion(m, channel, null);
    if (!version) return reject('unknown_template', ` template=${m.template} channel=${channel}`);

    const values: Record<string, unknown> = {};
    for (const [variable, field] of Object.entries(m.variables)) values[variable] = p[field];
    const invalid = validateVariableValues(version.variables, values);
    if (invalid.length > 0) return reject('invalid_template_data', ` variables=${invalid.map((e) => e.split(':')[0]).join(',')}`);

    const secrets: Record<string, string> = {};
    const data: Record<string, unknown> = {};
    for (const [name, v] of Object.entries(values)) {
      if (v === undefined || v === null) continue;
      if (version.variables[name].secret) secrets[name] = String(v);
      else data[name] = v;
    }

    const deliverable = isValidDestination(channel, destination);
    const notificationId = randomUUID();
    const deliveryId = randomUUID();
    // Seal only what may still be sent: an undeliverable intent keeps no secret at all.
    const sealed = deliverable && Object.keys(secrets).length > 0 ? this.cipher.seal(secrets, notificationId) : undefined;
    const correlationId = event.headers.correlationId && CORRELATION.test(event.headers.correlationId) ? event.headers.correlationId : null;

    const created = await this.db.tx(async (q) => {
      const ins = await q.query(
        `INSERT INTO notification (id, "sourceKind", "sourceService", "sourceEventId", "templateId", category, "organizationId", "recipientType",
           "recipientId", "requestedLocale", data, "secretCiphertext", "secretKeyId", "expiresAt", "correlationId")
         VALUES ($1, 'event', $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10, $11, $12, $13)
         ON CONFLICT ("sourceService", "sourceEventId") WHERE "sourceKind" = 'event' DO NOTHING
         RETURNING id`,
        [notificationId, event.headers.source, event.id, version.templateId, version.category, m.organizationFrom ? p[m.organizationFrom] : null,
          m.recipient.type, p[m.recipient.idFrom], JSON.stringify(data), sealed?.ciphertext ?? null, sealed?.keyId ?? null,
          m.expiresAtFrom ? p[m.expiresAtFrom] : null, correlationId],
      );
      if (ins.rowCount === 0) return false; // the same event is already recorded (a redelivery, a replay, a concurrent copy)
      await this.insertDelivery(q, deliveryId, notificationId, channel, destination, version, deliverable);
      return true;
    });

    if (!created) {
      this.log.log(`notification_duplicate ${who}`);
      return { kind: 'duplicate' };
    }
    if (!deliverable) this.log.warn(`notification_delivery_failed ${who} notificationId=${notificationId} deliveryId=${deliveryId} channel=${channel} failureCode=invalid_destination`);
    this.log.log(`notification_accepted ${who} notificationId=${notificationId} deliveryId=${deliveryId} channel=${channel} template=${m.template} version=${version.version} locale=${version.locale}`);
    return { kind: 'accepted', notificationId, deliveryId, invalidDestination: !deliverable };
  }

  /**
   * Creates the delivery `PENDING` and due now (events are immediate, D16). An undeliverable destination is taken to its terminal state
   * within the SAME transaction along the frozen matrix (PENDING → SENDING → FAILED; SDD §5.2 has no PENDING → FAILED edge), so no
   * other process can ever see or claim it. No attempt row is written: no provider is called.
   */
  private async insertDelivery(q: Queryable, id: string, notificationId: string, channel: DeliveryChannel, destination: string, v: PublishedVersion, deliverable: boolean) {
    await q.query(
      `INSERT INTO notification_delivery (id, "notificationId", channel, destination, "templateVersionId", locale, "nextAttemptAt") VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [id, notificationId, channel, destination, v.versionId, v.locale],
    );
    if (!deliverable) {
      await q.query(`UPDATE notification_delivery SET status = 'SENDING', "nextAttemptAt" = NULL, "leaseUntil" = now() WHERE id = $1`, [id]);
      await q.query(
        `UPDATE notification_delivery SET status = 'FAILED', "leaseUntil" = NULL, "failedAt" = now(), "completedAt" = now(),
           "failureClass" = 'terminal', "failureCode" = 'invalid_destination' WHERE id = $1`,
        [id],
      );
    }
  }

  /** The active (highest) published version of the mapping's template for the channel, in the resolved locale (SDD §3.4, §6.4). */
  async publishedVersion(m: EventMapping, channel: DeliveryChannel, requestedLocale: string | null): Promise<PublishedVersion | undefined> {
    const { rows } = await this.db.query<{ templateId: string; category: string; versionId: string; locale: string; version: number; variables: VariableSchema }>(
      `SELECT t.id AS "templateId", t.category, v.id AS "versionId", v.locale, v.version, v.variables
         FROM notification_template t JOIN notification_template_version v ON v."templateId" = t.id
        WHERE t.key = $1 AND t."organizationId" IS NULL AND v.channel = $2
        ORDER BY v.version DESC`,
      [m.template, channel],
    );
    const locale = resolveLocale(requestedLocale, new Set(rows.map((r) => r.locale)), this.config.defaultLocale);
    const row = rows.find((r) => r.locale === locale); // rows are newest first: the first match is the active version
    if (!row || row.category !== m.category) return undefined;
    return row;
  }
}
