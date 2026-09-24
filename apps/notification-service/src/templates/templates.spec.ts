import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCatalog, stableUuid, versionChecksum } from './catalog.js';
import { catalogStatements, nextPublishMigration, publishedStatements } from './publish-sql.js';
import { smsSize } from './sms.js';
import { parsePlaceholders } from './syntax.js';
import { validateVariableSchema } from './variables.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TEMPLATES = join(ROOT, 'templates');
const MIGRATIONS = join(ROOT, 'db/migrations');

describe('template syntax: {{variable}} only (SDD §6.3)', () => {
  it('extracts variable names in first-use order without duplicates', () => {
    expect(parsePlaceholders('Code {{code}} until {{expiresAt}}; again {{code}}.')).toEqual({ names: ['code', 'expiresAt'], errors: [] });
  });
  it.each([
    ['{{ code }}'], ['{{#if code}}x{{/if}}'], ['{{code.length}}'], ['{{code | upper}}'], ['{{> partial}}'], ['{{a}}}'], ['{{{code}}}'],
    ['{{code'], ['code}}'], ['{{}}'], ['{{constructor()}}'],
  ])('refuses anything else: %s', (text) => {
    expect(parsePlaceholders(text).errors.length).toBeGreaterThan(0);
  });
});

describe('variable schema: a closed type system (SDD §6.2)', () => {
  it('accepts the five types, with secret as a flag on a code or a string', () => {
    expect(validateVariableSchema({
      code: { type: 'code', required: true, secret: true, maxLength: 12 },
      name: { type: 'string', required: false, maxLength: 80 },
      at: { type: 'datetime', required: true },
      n: { type: 'integer', required: true },
      link: { type: 'url', required: false, maxLength: 500 },
    })).toEqual([]);
  });
  it.each([
    [{ v: { type: 'secret', required: true } }, /type must be one of/],
    [{ v: { type: 'html', required: true } }, /type must be one of/],
    [{ v: { type: 'string', required: true } }, /needs maxLength/],
    [{ v: { type: 'code', required: true, maxLength: 5000 } }, /needs maxLength/],
    [{ v: { type: 'datetime', required: true, maxLength: 10 } }, /takes no maxLength/],
    [{ v: { type: 'datetime', required: true, secret: true } }, /cannot be secret/],
    [{ v: { type: 'url', required: true, secret: true, maxLength: 9 } }, /cannot be secret/],
    [{ v: { type: 'string', maxLength: 5 } }, /required must be/],
    [{ v: { type: 'string', required: true, maxLength: 5, default: 'x' } }, /unknown property/],
    [{ 'bad-name': { type: 'integer', required: true } }, /must match/],
    [[], /must be an object/],
  ])('refuses an invalid schema %#', (schema, message) => {
    expect(validateVariableSchema(schema).join('\n')).toMatch(message);
  });
});

describe('SMS size (SDD §6.6)', () => {
  it('counts GSM-7 septets, two for an extension character, and concatenated segments of 153', () => {
    expect(smsSize('a'.repeat(160))).toEqual({ encoding: 'GSM-7', units: 160, segments: 1 });
    expect(smsSize('a'.repeat(161))).toEqual({ encoding: 'GSM-7', units: 161, segments: 2 });
    expect(smsSize('€'.repeat(80))).toEqual({ encoding: 'GSM-7', units: 160, segments: 1 });
    expect(smsSize('a'.repeat(307))).toEqual({ encoding: 'GSM-7', units: 307, segments: 3 });
  });
  it('switches to UCS-2 for any character outside the GSM alphabet (Arabic, a narrow no-break space), 70 / 67 per segment', () => {
    expect(smsSize('مرحبا'.repeat(14))).toEqual({ encoding: 'UCS-2', units: 70, segments: 1 });
    expect(smsSize(`${'a'.repeat(70)} `)).toEqual({ encoding: 'UCS-2', units: 71, segments: 2 });
  });
});

describe('the platform catalog (templates/) passes the publish check', () => {
  const { catalog, errors } = loadCatalog(TEMPLATES);

  it('has no publish-check error', () => {
    expect(errors).toEqual([]);
  });

  it('holds exactly the nine templates of the Stage 16 Auth mapping (SDD §7.1), EMAIL and SMS each, in the required locale', () => {
    expect(catalog.templates.map((t) => t.key)).toEqual([
      'identity.contact_verification_code', 'identity.operator_confirmation_code', 'identity.operator_login_code', 'identity.owner_new_device_login',
      'identity.owner_recovery_completed', 'identity.owner_recovery_requested', 'membership.approved', 'membership.rejected', 'membership.revoked',
    ]);
    expect(catalog.requiredLocales).toEqual(['en']);
    for (const t of catalog.templates) {
      expect(catalog.versions.filter((v) => v.key === t.key).map((v) => `${v.channel}.${v.locale}.v${v.version}`).sort(), t.key).toEqual(['EMAIL.en.v1', 'SMS.en.v1']);
    }
    expect(catalog.templates.filter((t) => t.category === 'SECURITY')).toHaveLength(6);
    expect(catalog.templates.filter((t) => t.category === 'TRANSACTIONAL')).toHaveLength(3);
  });

  it('marks every one-time code secret and bounded, and never puts an unbounded free string in a template', () => {
    for (const v of catalog.versions) {
      for (const [name, spec] of Object.entries(v.variables)) {
        if (spec.type === 'code') expect(spec.secret, `${v.key}.${name}`).toBe(true);
        if (spec.type === 'string' || spec.type === 'code') expect(spec.maxLength, `${v.key}.${name}`).toBeGreaterThan(0);
      }
    }
  });

  it('checksums and ids are deterministic (the same catalog always generates the same migration)', () => {
    const again = loadCatalog(TEMPLATES).catalog;
    expect(again.versions.map((v) => [v.id, v.checksum])).toEqual(catalog.versions.map((v) => [v.id, v.checksum]));
    const v = catalog.versions[0];
    expect(v.checksum).toBe(versionChecksum(v));
    expect(v.id).toBe(stableUuid(`${v.key}|${v.channel}|${v.locale}|v${v.version}`));
    expect(stableUuid('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('DRIFT GUARD: the committed publishing migrations contain exactly what the catalog generates (no version edited after publication, none missing, none invented)', () => {
    expect([...publishedStatements(MIGRATIONS)].sort()).toEqual([...catalogStatements(catalog)].sort());
    expect(nextPublishMigration(catalog, MIGRATIONS)).toBeUndefined();
  });
});

describe('the publish check refuses a bad catalog', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const write = (files: Record<string, unknown>) => {
    dir = mkdtempSync(join(tmpdir(), 'notif-catalog-'));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), typeof content === 'string' ? content : JSON.stringify(content));
    }
    return loadCatalog(dir).errors.join('\n');
  };
  const good = {
    'catalog.json': { requiredLocales: ['en'] },
    'a.b/template.json': { category: 'SECURITY', description: 'd' },
    'a.b/EMAIL.en.v1.json': { variables: { code: { type: 'code', required: true, secret: true, maxLength: 8 } }, subject: 'S', bodyText: 'Code {{code}}' },
    'a.b/SMS.en.v1.json': { variables: { code: { type: 'code', required: true, secret: true, maxLength: 8 } }, bodyText: 'Code {{code}}', smsMaxSegments: 1 },
  };

  it('a well-formed catalog passes (control)', () => {
    expect(write(good)).toBe('');
  });
  it.each([
    ['an undeclared placeholder', { 'a.b/SMS.en.v1.json': { variables: { code: { type: 'code', required: true, maxLength: 8 } }, bodyText: '{{code}} {{other}}', smsMaxSegments: 1 } }, /\{\{other\}\} is not declared/],
    ['a declared but unused variable', { 'a.b/SMS.en.v1.json': { variables: { code: { type: 'code', required: true, maxLength: 8 }, x: { type: 'integer', required: true } }, bodyText: '{{code}}', smsMaxSegments: 1 } }, /"x" is declared but never used/],
    ['template logic', { 'a.b/EMAIL.en.v1.json': { variables: {}, subject: 'S', bodyText: '{{#if code}}x{{/if}}' } }, /invalid placeholder/],
    ['an email without a subject', { 'a.b/EMAIL.en.v1.json': { variables: {}, bodyText: 'x' } }, /one-line subject/],
    ['a subject with a line break (header injection)', { 'a.b/EMAIL.en.v1.json': { variables: {}, subject: 'a\r\nBcc: x', bodyText: 'x' } }, /one-line subject/],
    ['a script in the HTML part', { 'a.b/EMAIL.en.v1.json': { variables: {}, subject: 'S', bodyText: 'x', bodyHtml: '<p>x</p><script>1</script>' } }, /a script/],
    ['a remote image in the HTML part', { 'a.b/EMAIL.en.v1.json': { variables: {}, subject: 'S', bodyText: 'x', bodyHtml: '<img src="https://t.example/p.gif">' } }, /a remote resource/],
    ['an event handler in the HTML part', { 'a.b/EMAIL.en.v1.json': { variables: {}, subject: 'S', bodyText: 'x', bodyHtml: '<p onclick="x()">x</p>' } }, /event-handler/],
    ['an SMS with a subject', { 'a.b/SMS.en.v1.json': { variables: {}, subject: 'S', bodyText: 'x', smsMaxSegments: 1 } }, /body only/],
    ['an SMS over its segment bound', { 'a.b/SMS.en.v1.json': { variables: {}, bodyText: 'x'.repeat(161), smsMaxSegments: 1 } }, /worst case is 2 GSM-7 segments/],
    ['an SMS whose worst-case variable forces UCS-2 past its bound', { 'a.b/SMS.en.v1.json': { variables: { at: { type: 'datetime', required: true } }, bodyText: `${'x'.repeat(40)} {{at}}`, smsMaxSegments: 1 } }, /UCS-2 segments/],
    ['a missing required locale', { 'catalog.json': { requiredLocales: ['en', 'fr'] } }, /no version in the required locale "fr"/],
    ['a version gap', { 'a.b/SMS.en.v3.json': { variables: { code: { type: 'code', required: true, maxLength: 8 } }, bodyText: '{{code}}', smsMaxSegments: 1 } }, /without gaps/],
    ['channels disagreeing on the variables', { 'a.b/SMS.en.v1.json': { variables: {}, bodyText: 'no code', smsMaxSegments: 1 } }, /same variables/],
    ['an IN_APP version in V1', { 'a.b/IN_APP.en.v1.json': { variables: {}, bodyText: 'x' } }, /channel must be one of EMAIL, SMS/],
    ['an unknown category', { 'a.b/template.json': { category: 'MARKETING', description: 'd' } }, /category must be one of/],
    ['a bad template key', { 'Bad Key/template.json': { category: 'SECURITY', description: 'd' } }, /template key must match/],
    ['an unknown property in a version', { 'a.b/SMS.en.v1.json': { variables: {}, bodyText: 'x', smsMaxSegments: 1, from: 'x' } }, /unknown property "from"/],
  ])('%s', (_label, override, message) => {
    expect(write({ ...good, ...override })).toMatch(message);
  });
});
