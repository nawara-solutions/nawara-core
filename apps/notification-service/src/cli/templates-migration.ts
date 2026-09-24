#!/usr/bin/env node
import { readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../templates/catalog.js';
import { nextPublishMigration } from '../templates/publish-sql.js';

/**
 * `npm run templates:migration -- <name>` (development tool, never run by the service): runs the publish check over `templates/` and
 * writes the next publishing migration (the statements no committed migration contains yet) to
 * `db/migrations/NNNN_publish_templates_<name>.sql`, numbered after the last migration. Exits non-zero, printing every problem, when
 * the catalog fails the check. It writes the file itself rather than printing: nothing else can end up in the migration.
 */
const root = fileURLToPath(new URL('../../', import.meta.url));
const { catalog, errors } = loadCatalog(`${root}templates`);
if (errors.length > 0) {
  process.stderr.write(`template publish check failed:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
  process.exit(1);
}
const name = process.argv[2] ?? '';
if (!/^[a-z0-9_]{1,40}$/.test(name)) {
  process.stderr.write('usage: npm run templates:migration -- <name>   (lowercase letters, digits and underscores)\n');
  process.exit(2);
}
const dir = `${root}db/migrations`;
const sql = nextPublishMigration(catalog, dir);
if (sql === undefined) {
  process.stderr.write('nothing to publish: every catalog version is already in a committed migration\n');
} else {
  const last = readdirSync(dir).map((f) => Number(/^(\d{4})_/.exec(f)?.[1] ?? 0)).reduce((a, b) => Math.max(a, b), 0);
  const file = `${String(last + 1).padStart(4, '0')}_publish_templates_${name}.sql`;
  writeFileSync(`${dir}/${file}`, sql);
  process.stderr.write(`wrote db/migrations/${file}\n`);
}
