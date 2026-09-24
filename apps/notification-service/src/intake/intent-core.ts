import { Inject, Injectable } from '@nestjs/common';
import { DbService, type Queryable } from '@nawara/service-kit';
import { NOTIFICATION_CONFIG } from '../config/notification-config.token.js';
import type { NotificationConfig } from '../config/notification-config.js';
import { NotificationSecretCipher, type SealedSecrets } from '../secrets/secret-cipher.js';
import type { VariableSchema } from '../templates/variables.js';
import type { DeliveryChannel } from './destination.js';
import { resolveLocale } from './locale.js';

/** The active published version of a template for one channel, in the resolved locale. */
export interface PublishedVersion {
  templateId: string;
  category: string;
  versionId: string;
  locale: string;
  version: number;
  variables: VariableSchema;
}

/**
 * The intake rules both transports share (Stage 16.5 events, Stage 16.6 API): template and locale resolution against the DATABASE (the
 * published authority), the split of template variables into non-secret `data` and sealed secrets, and the creation of a delivery.
 * What differs per transport stays in the adapter: the identity (`(source, eventId)` vs `(caller, Idempotency-Key)` + request hash),
 * the policy, and the outcome of an invalid destination (a durable FAILED delivery for an event, a 422 for the API).
 */
@Injectable()
export class IntentCore {
  private readonly cipher: NotificationSecretCipher;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
  ) {
    this.cipher = new NotificationSecretCipher(config.secretKeys, config.secretActiveKeyId);
  }

  /** The active (highest) published version of the platform template `key` for the channel, in the resolved locale (SDD §3.4, §6.4). */
  async activeVersion(key: string, channel: DeliveryChannel, requestedLocale: string | null): Promise<PublishedVersion | undefined> {
    const { rows } = await this.db.query<PublishedVersion>(
      `SELECT t.id AS "templateId", t.category, v.id AS "versionId", v.locale, v.version, v.variables
         FROM notification_template t JOIN notification_template_version v ON v."templateId" = t.id
        WHERE t.key = $1 AND t."organizationId" IS NULL AND v.channel = $2
        ORDER BY v.version DESC`,
      [key, channel],
    );
    const locale = resolveLocale(requestedLocale, new Set(rows.map((r) => r.locale)), this.config.defaultLocale);
    return rows.find((r) => r.locale === locale); // rows are newest first: the first match is the active version
  }

  /** Splits validated variable values: secret-flagged ones to be sealed, never into `data`; the rest into `data`. */
  split(schema: VariableSchema, values: Record<string, unknown>): { data: Record<string, unknown>; secrets: Record<string, string> } {
    const data: Record<string, unknown> = {};
    const secrets: Record<string, string> = {};
    for (const [name, v] of Object.entries(values)) {
      if (v === undefined || v === null) continue;
      if (schema[name]?.secret) secrets[name] = String(v);
      else data[name] = v;
    }
    return { data, secrets };
  }

  /** Seals the secrets of one notification (AES-256-GCM, AAD bound to its id), or undefined when there are none. */
  seal(secrets: Record<string, string>, notificationId: string): SealedSecrets | undefined {
    return Object.keys(secrets).length > 0 ? this.cipher.seal(secrets, notificationId) : undefined;
  }

  /** Creates a delivery `PENDING`, due at `dueAt` (the schedule) or now, pinned to the version, its channel and its locale. */
  async insertDelivery(q: Queryable, d: { id: string; notificationId: string; channel: DeliveryChannel; destination: string; version: PublishedVersion; dueAt: string | null }): Promise<void> {
    await q.query(
      `INSERT INTO notification_delivery (id, "notificationId", channel, destination, "templateVersionId", locale, "nextAttemptAt")
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))`,
      [d.id, d.notificationId, d.channel, d.destination, d.version.versionId, d.version.locale, d.dueAt],
    );
  }
}
