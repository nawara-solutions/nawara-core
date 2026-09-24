import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { notificationMigrationsDir } from '../src/app.module.js';
import { loadCatalog, versionChecksum, type Channel } from '../src/templates/catalog.js';
import type { VariableSchema } from '../src/templates/variables.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';

const KIT = ['kit_0001_outbox_inbox.sql', 'kit_0002_rate_limit.sql', 'kit_0003_generic_triggers.sql'];
const OWN = ['0001_notification_schema.sql', '0002_publish_templates_v1.sql'];
/** Exactly the schema of this stage: the five frozen tables, the kit's, the migration ledger. Nothing else (no recipient list, no preference). */
const TABLES = ['inbox', 'kit_rate_limit', 'notification', 'notification_delivery', 'notification_delivery_attempt', 'notification_template', 'notification_template_version', 'outbox', 'schema_migrations'];
/** Every index on the five tables, each justified in the Stage 16.4 record (no duplicate, no speculative one). */
const INDEXES = [
  'notification_api_identity_unique', 'notification_event_identity_unique', 'notification_organization_created_idx', 'notification_pkey',
  'notification_secret_expiry_idx', 'notification_source_created_idx',
  'notification_delivery_attempt_number_unique', 'notification_delivery_attempt_pkey',
  'notification_delivery_channel_unique', 'notification_delivery_due_idx', 'notification_delivery_lease_idx', 'notification_delivery_pkey',
  'notification_template_id_category_unique', 'notification_template_pkey', 'notification_template_platform_key_unique',
  'notification_template_version_id_channel_locale_unique', 'notification_template_version_identity_unique', 'notification_template_version_pkey',
].sort();
const ROOT = fileURLToPath(new URL('../', import.meta.url));

describeWithEnv('notification migrations (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'notifmig');
  });
  afterAll(() => db.drop());

  it('applies the kit migrations and this service\'s own from an EMPTY database, in order, creating exactly the expected tables', async () => {
    const r = await runMigrations(db.url, [kitMigrationsDir, notificationMigrationsDir]);
    expect(r.applied).toEqual([...KIT, ...OWN]);
    const tables = await sql<{ t: string }>(db.url, `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`);
    expect(tables.map((x) => x.t)).toEqual(TABLES);
  });

  it('is a no-op when run again (checksummed, locked runner)', async () => {
    const r = await runMigrations(db.url, [kitMigrationsDir, notificationMigrationsDir]);
    expect(r.applied).toEqual([]);
    expect(r.alreadyApplied).toEqual([...KIT, ...OWN]);
  });

  it('creates exactly the justified indexes on the five tables', async () => {
    const rows = await sql<{ i: string }>(db.url, `SELECT indexname AS i FROM pg_indexes WHERE schemaname = 'public' AND tablename LIKE 'notification%' ORDER BY 1`);
    expect(rows.map((r) => r.i)).toEqual(INDEXES);
  });

  it('keeps every foreign key inside the notification tables (no cross-service reference)', async () => {
    const fks = await sql<{ f: string; t: string }>(db.url, `SELECT conrelid::regclass::text AS f, confrelid::regclass::text AS t FROM pg_constraint WHERE contype = 'f' ORDER BY 1, 2`);
    expect(fks).toEqual([
      { f: 'notification', t: 'notification_template' },
      { f: 'notification_delivery', t: 'notification' },
      { f: 'notification_delivery', t: 'notification_template_version' },
      { f: 'notification_delivery_attempt', t: 'notification_delivery' },
      { f: 'notification_template_version', t: 'notification_template' },
    ]);
    const cascades = await sql(db.url, `SELECT conname FROM pg_constraint WHERE contype = 'f' AND confdeltype = 'c'`);
    expect(cascades).toEqual([]); // no ON DELETE CASCADE: evidence never disappears as a side effect
  });

  it('stores no rendered content, no provider payload and no aggregate notification status (D18, SDD §3.5)', async () => {
    const cols = await sql<{ t: string; c: string }>(db.url, `SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'notification%'`);
    const of = (t: string) => cols.filter((x) => x.t === t).map((x) => x.c);
    for (const t of ['notification', 'notification_delivery', 'notification_delivery_attempt']) {
      expect(of(t).filter((c) => /render|body|subject|html|content|payload|response|request(?!Hash|edLocale)|credential|password|apiKey/i.test(c)), t).toEqual([]);
    }
    expect(of('notification')).not.toContain('status');
    expect(of('notification_delivery')).toContain('status');
  });

  it('has the frozen triggers: immutability, the transition guard, attempt lifecycle, template version permanence', async () => {
    const trg = await sql<{ t: string; n: string }>(db.url, `SELECT event_object_table AS t, trigger_name AS n FROM information_schema.triggers WHERE event_object_table LIKE 'notification%' GROUP BY 1, 2 ORDER BY 1, 2`);
    expect(trg.map((x) => `${x.t}.${x.n}`)).toEqual([
      'notification.notification_immutable', 'notification.notification_purge_and_cancel_guard',
      'notification_delivery.notification_delivery_immutable', 'notification_delivery.notification_delivery_starts_pending',
      'notification_delivery.notification_delivery_status_transition', 'notification_delivery.notification_delivery_template_matches',
      'notification_delivery.notification_delivery_terminal_final',
      'notification_delivery_attempt.notification_delivery_attempt_immutable', 'notification_delivery_attempt.notification_delivery_attempt_lifecycle',
      'notification_template.notification_template_immutable',
      'notification_template_version.notification_template_version_immutable', 'notification_template_version.notification_template_version_no_delete',
    ]);
  });

  it('publishes exactly the catalog: every row matches its template file, and its checksum recomputes from the stored content', async () => {
    const { catalog } = loadCatalog(`${ROOT}templates`);
    const rows = await sql<{ id: string; key: string; channel: Channel; locale: string; version: number; variables: VariableSchema; subject: string | null; bodyText: string; bodyHtml: string | null; smsMaxSegments: number | null; checksum: string }>(
      db.url,
      `SELECT v.id, t.key, v.channel, v.locale, v.version, v.variables, v.subject, v."bodyText", v."bodyHtml", v."smsMaxSegments", v.checksum
         FROM notification_template_version v JOIN notification_template t ON t.id = v."templateId" ORDER BY t.key, v.channel`,
    );
    expect(rows).toHaveLength(catalog.versions.length);
    for (const r of rows) {
      const { id, checksum, ...content } = r;
      expect(versionChecksum(content), `${r.key} ${r.channel}`).toBe(checksum);
      expect(catalog.versions.find((v) => v.id === id)?.checksum).toBe(checksum);
    }
    const templates = await sql<{ key: string; category: string; ownerScope: string; organizationId: string | null }>(db.url, 'SELECT key, category, "ownerScope", "organizationId" FROM notification_template ORDER BY key');
    expect(templates.map((t) => [t.key, t.category, t.ownerScope, t.organizationId])).toEqual(catalog.templates.map((t) => [t.key, t.category, 'platform', null]));
  });
});
