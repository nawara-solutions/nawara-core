import { AUDIT_CATALOG, CORE_PRODUCERS, type CatalogEntry, type ChangeSpec } from './catalog.js';
import { AUDIT_CONTRACT_VERSION } from './contract.js';

/**
 * Renders `docs/architecture/audit-event-catalog.md` from the code catalog. The document is GENERATED (never edited by hand): a unit test
 * compares the file with this output, so the human-readable catalog and the enforced one cannot drift.
 * Not part of the package's public API (it is tooling: `npm run catalog:doc -w @nawara/audit-contract`).
 */

function actors(e: Readonly<CatalogEntry>): string {
  const parts: string[] = [];
  if (e.actors.user) parts.push(`user (${e.actors.user.join(', ')})`);
  if (e.actors.service) parts.push('service');
  if (e.actors.system) parts.push(`system (${e.actors.system.map((s) => `\`${s}\``).join(', ')})`);
  return parts.join('; ');
}

function organization(e: Readonly<CatalogEntry>): string {
  switch (e.organization) {
    case 'required':
      return 'required';
    case 'none':
      return 'none (platform)';
    case 'optional':
      return 'as recorded (UUID or null)';
    case 'self':
      return 'the organization itself';
    case 'resource':
      return 'the target when it is an organization, else none';
  }
}

function subject(e: Readonly<CatalogEntry>): string {
  return e.subject.rule === 'forbidden' ? '—' : `${e.subject.type} (${e.subject.rule})`;
}

function change(key: string, s: ChangeSpec): string {
  let type: string = s.type;
  if (s.type === 'code') type = s.values.join(' \\| ');
  if (s.type === 'integer') type = `integer ${s.min}–${s.max}`;
  const shape = s.shape === 'transition' ? `{from, to} of ${type}` : type;
  return `\`${key}\`${s.required ? '' : '?'}: ${shape}`;
}

function changes(e: Readonly<CatalogEntry>): string {
  const keys = Object.keys(e.changes);
  return keys.length === 0 ? '—' : keys.map((k) => change(k, e.changes[k]!)).join('<br>');
}

export function renderCatalogDocument(): string {
  const lines: string[] = [
    '# Core audit event catalog',
    '',
    '<!-- GENERATED from libs/audit-contract/src/catalog.ts by `npm run catalog:doc -w @nawara/audit-contract`. Do not edit by hand:',
    '     a unit test fails while this file and the code catalog differ. -->',
    '',
    `Contract version **${AUDIT_CONTRACT_VERSION}** ([ADR-0049](../adr/0049-audit-trail-architecture.md),`,
    '[Stage 18.4 record](./stage-18/stage-18-4-canonical-contract-catalog.md)). Every action is emitted as the kit event',
    '`audit.<action>` by its one owning service, through `AuditEventWriter` on the business transaction. Anything not listed here is',
    'refused (`unknown_action`) by the producer helper and by audit-service. A new action is a reviewed catalog change justified against',
    'the ADR-0049 A7 selection rule.',
    '',
    'Columns: **actors** allowed (user kinds; `service` = the calling service\'s name; `system` = the listed process codes), **organization**',
    'rule, **resource** type, **subject** (at most one), **outcomes**, allowed **changes** (`?` = optional; `code` values are closed',
    'enumerations). Every resource and subject id is a lowercase UUID. No change carries a name, contact, amount, credential or free text.',
    '',
  ];
  let total = 0;
  for (const producer of CORE_PRODUCERS) {
    const rows = [...AUDIT_CATALOG].filter(([, e]) => e.producer === producer);
    total += rows.length;
    lines.push(`## ${producer} (${rows.length})`, '');
    lines.push('| Action | Category | Actors | Organization | Resource | Subject | Outcomes | Changes | Purpose |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const [action, e] of rows) {
      lines.push(
        `| \`${action}\` | ${e.category} | ${actors(e)} | ${organization(e)} | ${e.resource.join(' \\| ')} | ${subject(e)} | ${e.outcomes.join(', ')} | ${changes(e)} | ${e.purpose} |`,
      );
    }
    lines.push('');
  }
  lines.push('## notification-service (0)', '', 'No action: no privileged Notification capability exists (Stage 18.1 A64). Delivery history stays in');
  lines.push('notification-service.', '', `**Total: ${total} actions.**`, '');
  return lines.join('\n');
}
