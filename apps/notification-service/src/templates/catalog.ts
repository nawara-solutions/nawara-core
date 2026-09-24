import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from '@nawara/service-kit';
import { smsSize } from './sms.js';
import { VARIABLE_NAME, parsePlaceholders, substitute } from './syntax.js';
import { validateVariableSchema, type VariableSchema, type VariableSpec } from './variables.js';

/**
 * The platform template catalog (SDD §3.4, §6.1): data files in the repository, published to the database by generated,
 * checksummed migrations (see publish-sql.ts). Layout:
 *
 *   templates/catalog.json                          { "requiredLocales": ["en"] }
 *   templates/<key>/template.json                   { "category": "SECURITY", "description": "…" }
 *   templates/<key>/<CHANNEL>.<locale>.v<N>.json    { "variables": {…}, "subject"?, "bodyText", "bodyHtml"?, "smsMaxSegments"? }
 *
 * A version file is immutable once published: a change is a new file with the next version number and a new migration.
 */
export const TEMPLATE_KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
export const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
export const CATEGORIES = ['SECURITY', 'TRANSACTIONAL', 'OPTIONAL'] as const;
/** Channels a V1 template may publish. `IN_APP` exists in the schema, but no V1 path creates it (SDD §3.2). */
export const PUBLISHABLE_CHANNELS = ['EMAIL', 'SMS'] as const;
export type Channel = (typeof PUBLISHABLE_CHANNELS)[number];

/**
 * Worst-case rendered length of a variable without a `maxLength`, for the SMS size check. A datetime is formatted with `Intl` for
 * the locale (Stage 16.7 renderer); 40 characters bounds every medium-length format, and the renderer must stay within it.
 */
export const DATETIME_RENDERED_MAX = 40;
export const INTEGER_RENDERED_MAX = 20;

export interface CatalogTemplate {
  id: string;
  key: string;
  category: (typeof CATEGORIES)[number];
  description: string;
}
export interface CatalogVersion {
  id: string;
  templateId: string;
  key: string;
  channel: Channel;
  locale: string;
  version: number;
  variables: VariableSchema;
  subject: string | null;
  bodyText: string;
  bodyHtml: string | null;
  smsMaxSegments: number | null;
  checksum: string;
}
export interface Catalog {
  requiredLocales: string[];
  templates: CatalogTemplate[];
  versions: CatalogVersion[];
}

/** A stable uuid derived from a name (the same on every machine), so a regenerated migration is byte-identical. */
export function stableUuid(name: string): string {
  const h = sha256Hex(`nawara.notification.template|${name}`);
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** SHA-256 of the canonical content of one version: what the database stores in `checksum`. */
export function versionChecksum(v: Omit<CatalogVersion, 'id' | 'templateId' | 'checksum'>): string {
  return sha256Hex(
    canonicalJson({
      key: v.key, channel: v.channel, locale: v.locale, version: v.version, variables: v.variables,
      subject: v.subject, bodyText: v.bodyText, bodyHtml: v.bodyHtml, smsMaxSegments: v.smsMaxSegments,
    }),
  );
}

const VERSION_FILE = /^(EMAIL|SMS|IN_APP|[A-Z_]+)\.([^.]+)\.v([1-9][0-9]*)\.json$/;
const HTML_FORBIDDEN: Array<[RegExp, string]> = [
  [/<\s*script\b/i, 'a script'],
  [/<\s*(iframe|object|embed|link|meta|base|form|style)\b/i, 'an active or remote-loading element'],
  [/\son[a-z]+\s*=/i, 'an event-handler attribute'],
  [/javascript\s*:/i, 'a javascript: URL'],
  [/\b(src|background|srcset)\s*=\s*["']?\s*(https?:)?\/\//i, 'a remote resource'],
];

function readJson(path: string, errors: string[]): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
    errors.push(`${path}: must be a JSON object`);
  } catch {
    errors.push(`${path}: invalid JSON`);
  }
  return undefined;
}

/** A value of maximum length, of the worst characters for SMS size, for a variable (see DATETIME_RENDERED_MAX). */
function worstCase(spec: VariableSpec): string {
  switch (spec.type) {
    case 'code':
      return 'X'.repeat(spec.maxLength ?? 0); // letters and digits: GSM-7
    case 'integer':
      return '9'.repeat(INTEGER_RENDERED_MAX);
    case 'url':
      return '~'.repeat(spec.maxLength ?? 0); // ASCII, but a GSM extension character costs two septets
    case 'datetime':
      return 'ع'.repeat(DATETIME_RENDERED_MAX); // Intl output can leave GSM-7 (a narrow no-break space, a non-Latin script)
    case 'string':
      return 'ع'.repeat(spec.maxLength ?? 0);
  }
}

/**
 * Loads the catalog and runs the publish-time check (SDD §3.4, §6). Returns every problem found; a catalog with any problem is
 * never published (the migration generator refuses it, and a unit test runs the same check).
 */
export function loadCatalog(dir: string): { catalog: Catalog; errors: string[] } {
  const errors: string[] = [];
  const templates: CatalogTemplate[] = [];
  const versions: CatalogVersion[] = [];
  const manifest = readJson(join(dir, 'catalog.json'), errors);
  const requiredLocales = Array.isArray(manifest?.requiredLocales) ? (manifest.requiredLocales as unknown[]).map(String) : [];
  if (requiredLocales.length === 0) errors.push('catalog.json: requiredLocales must list at least one locale');
  for (const l of requiredLocales) if (!LOCALE.test(l)) errors.push(`catalog.json: "${l}" is not a BCP 47 locale`);

  for (const key of readdirSync(dir).sort()) {
    const tdir = join(dir, key);
    if (!statSync(tdir).isDirectory()) continue;
    if (!TEMPLATE_KEY.test(key) || key.length > 128) {
      errors.push(`${key}: template key must match ${TEMPLATE_KEY}`);
      continue;
    }
    const meta = readJson(join(tdir, 'template.json'), errors);
    if (!meta) continue;
    const category = meta.category as CatalogTemplate['category'];
    if (!CATEGORIES.includes(category)) errors.push(`${key}: category must be one of ${CATEGORIES.join(', ')}`);
    const description = typeof meta.description === 'string' ? meta.description : '';
    if (description.length < 1 || description.length > 500) errors.push(`${key}: description must be 1-500 characters`);
    for (const k of Object.keys(meta)) if (!['category', 'description'].includes(k)) errors.push(`${key}/template.json: unknown property "${k}"`);
    const templateId = stableUuid(key);
    templates.push({ id: templateId, key, category, description });

    const own: CatalogVersion[] = [];
    for (const file of readdirSync(tdir).sort()) {
      if (file === 'template.json') continue;
      const where = `${key}/${file}`;
      const m = VERSION_FILE.exec(file);
      if (!m) {
        errors.push(`${where}: expected <CHANNEL>.<locale>.v<N>.json`);
        continue;
      }
      const [, channel, locale, versionText] = m;
      if (!PUBLISHABLE_CHANNELS.includes(channel as Channel)) {
        errors.push(`${where}: channel must be one of ${PUBLISHABLE_CHANNELS.join(', ')} in V1`);
        continue;
      }
      if (!LOCALE.test(locale)) errors.push(`${where}: "${locale}" is not a BCP 47 locale`);
      const body = readJson(join(tdir, file), errors);
      if (!body) continue;
      for (const k of Object.keys(body)) if (!['variables', 'subject', 'bodyText', 'bodyHtml', 'smsMaxSegments'].includes(k)) errors.push(`${where}: unknown property "${k}"`);
      const schemaErrors = validateVariableSchema(body.variables);
      errors.push(...schemaErrors.map((e) => `${where}: ${e}`));
      const variables = (schemaErrors.length === 0 ? body.variables : {}) as VariableSchema;
      const str = (v: unknown) => (typeof v === 'string' ? v : null);
      const version: Omit<CatalogVersion, 'id' | 'templateId' | 'checksum'> = {
        key, channel: channel as Channel, locale, version: Number(versionText), variables,
        subject: str(body.subject), bodyText: str(body.bodyText) ?? '', bodyHtml: str(body.bodyHtml),
        smsMaxSegments: typeof body.smsMaxSegments === 'number' ? body.smsMaxSegments : null,
      };
      errors.push(...checkContent(version).map((e) => `${where}: ${e}`));
      own.push({ ...version, id: stableUuid(`${key}|${channel}|${locale}|v${version.version}`), templateId, checksum: versionChecksum(version) });
    }
    if (own.length === 0) errors.push(`${key}: has no version file`);

    // Versions of one (channel, locale) are numbered 1..n without gaps; the highest is the active one.
    const series = new Map<string, CatalogVersion[]>();
    for (const v of own) series.set(`${v.channel}.${v.locale}`, [...(series.get(`${v.channel}.${v.locale}`) ?? []), v]);
    const active: CatalogVersion[] = [];
    for (const [s, vs] of series) {
      const numbers = vs.map((v) => v.version).sort((a, b) => a - b);
      if (numbers.some((n, i) => n !== i + 1)) errors.push(`${key}: versions of ${s} must be numbered 1..n without gaps`);
      active.push(vs.reduce((a, b) => (b.version > a.version ? b : a)));
    }
    // Every channel the template declares has every required locale, so locale resolution always ends on a published version.
    for (const channel of new Set(own.map((v) => v.channel))) {
      for (const l of requiredLocales) if (!series.has(`${channel}.${l}`)) errors.push(`${key}: ${channel} has no version in the required locale "${l}"`);
    }
    // The intent's data is validated once, for all its deliveries: the active versions of a template share one variable schema.
    const schemas = new Set(active.map((v) => canonicalJson(v.variables)));
    if (schemas.size > 1) errors.push(`${key}: the active versions of every channel and locale must declare the same variables`);
    versions.push(...own);
  }
  return { catalog: { requiredLocales, templates, versions }, errors };
}

function checkContent(v: Omit<CatalogVersion, 'id' | 'templateId' | 'checksum'>): string[] {
  const errors: string[] = [];
  const parts: Array<[string, string | null]> = [['subject', v.subject], ['bodyText', v.bodyText], ['bodyHtml', v.bodyHtml]];
  if (v.bodyText.length < 1 || v.bodyText.length > 16_384) errors.push('bodyText is required (1-16384 characters)');
  if (v.channel === 'EMAIL') {
    if (!v.subject || v.subject.length > 255 || /[\r\n]/.test(v.subject)) errors.push('an email needs a one-line subject of 1-255 characters');
    if (v.bodyHtml !== null) {
      if (v.bodyHtml.length < 1 || v.bodyHtml.length > 65_536) errors.push('bodyHtml must be 1-65536 characters');
      for (const [re, what] of HTML_FORBIDDEN) if (re.test(v.bodyHtml)) errors.push(`bodyHtml contains ${what}`);
    }
    if (v.smsMaxSegments !== null) errors.push('smsMaxSegments is for SMS only');
  } else {
    if (v.subject !== null || v.bodyHtml !== null) errors.push('an SMS has a body only (no subject, no HTML)');
    if (!Number.isInteger(v.smsMaxSegments) || (v.smsMaxSegments as number) < 1 || (v.smsMaxSegments as number) > 10) {
      errors.push('an SMS needs smsMaxSegments between 1 and 10');
    }
  }
  // The variables used in the content equal the schema's variables: no undeclared placeholder, no unused declaration.
  const used = new Set<string>();
  for (const [name, text] of parts) {
    if (text === null) continue;
    const p = parsePlaceholders(text);
    errors.push(...p.errors.map((e) => `${name}: ${e}`));
    for (const n of p.names) used.add(n);
  }
  const declared = new Set(Object.keys(v.variables));
  for (const n of used) if (!declared.has(n)) errors.push(`{{${n}}} is not declared in variables`);
  for (const n of declared) if (!used.has(n) && VARIABLE_NAME.test(n)) errors.push(`variable "${n}" is declared but never used`);
  // SMS: the static text with every variable at its worst case must fit smsMaxSegments (the provider is never sent more).
  if (v.channel === 'SMS' && Number.isInteger(v.smsMaxSegments) && errors.length === 0) {
    const size = smsSize(substitute(v.bodyText, (n) => worstCase(v.variables[n])));
    if (size.segments > (v.smsMaxSegments as number)) {
      errors.push(`the worst case is ${size.segments} ${size.encoding} segments (${size.units} units), over smsMaxSegments ${v.smsMaxSegments}`);
    }
  }
  return errors;
}
