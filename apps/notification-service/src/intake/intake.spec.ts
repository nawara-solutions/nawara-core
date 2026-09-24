import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NotificationSecretCipher } from '../secrets/secret-cipher.js';
import { loadCatalog } from '../templates/catalog.js';
import { validateVariableValues, type VariableSchema } from '../templates/variables.js';
import { E164, isValidEmail } from './destination.js';
import { EVENT_MAP, INTAKE_BINDINGS, INTAKE_QUEUE, mappingFor, payloadProblems } from './event-map.js';
import { resolveLocale } from './locale.js';

describe('D20: SMS destinations must be canonical E.164; nothing is normalized and no country is assumed', () => {
  it.each(['+21620000003', '+14155552671', '+442071838750', '+12345678', '+123456789012345'])('accepts %s', (v) => {
    expect(E164.test(v)).toBe(true);
  });
  it.each([
    ['21620000003'], ['20000003'], ['+021620000003'], ['++21620000003'], ['+216 20 000 003'], [''], ['+1234567'], ['+1234567890123456'],
    ['+2162000000a'], ['+216-20-000-003'], ['(+216)20000003'], ['0021620000003'], [' +21620000003'], ['+21620000003\n'],
  ])('refuses %j', (v) => {
    expect(E164.test(v)).toBe(false);
  });
});

describe('email destinations: a bounded, conservative check; the address is kept exactly as given', () => {
  it.each(['person@example.test', 'First.Last+tag@Sub.Example.COM', "o'neil@example.test", 'a@b.co', `${'l'.repeat(64)}@example.test`, 'x@xn--bcher-kva.example'])('accepts %s', (v) => {
    expect(isValidEmail(v)).toBe(true);
  });
  it.each([
    ['no at sign', 'person.example.test'], ['empty local part', '@example.test'], ['empty domain', 'person@'], ['two at signs', 'a@b@example.test'],
    ['a single-label domain', 'person@localhost'], ['whitespace', 'per son@example.test'], ['surrounding whitespace', ' person@example.test'],
    ['a leading dot', '.person@example.test'], ['a doubled dot', 'per..son@example.test'], ['a hyphen-edged label', 'p@-example.test'],
    ['a local part over 64', `${'l'.repeat(65)}@example.test`], ['over 254 characters', `p@${'d'.repeat(62)}.${'d'.repeat(62)}.${'d'.repeat(62)}.${'d'.repeat(62)}.test`],
    ['a non-ASCII domain (must arrive as xn--)', 'p@bücher.example'], ['a line break', 'p@example.test\r\nBcc: x@y.z'],
  ])('refuses %s', (_label, v) => {
    expect(isValidEmail(v)).toBe(false);
  });
});

describe('locale resolution (SDD §6.4): requested → base language → platform default', () => {
  const published = new Set(['en', 'fr', 'ar-TN']);
  it.each([
    ['exact', 'ar-TN', 'ar-TN'], ['base language', 'fr-TN', 'fr'], ['unsupported → default', 'de-DE', 'en'], ['missing → default', null, 'en'],
    ['malformed → default', 'FR_fr', 'en'], ['exact base', 'fr', 'fr'],
  ])('%s: %s → %s', (_label, requested, expected) => {
    expect(resolveLocale(requested, published, 'en')).toBe(expected);
  });
  it('is undefined only when the default itself is not published (a deployment defect the intake refuses to start with)', () => {
    expect(resolveLocale('fr', new Set(['ar']), 'en')).toBeUndefined();
  });
});

describe('template variable values (SDD §6.2): validated before anything is stored, never coerced', () => {
  const schema: VariableSchema = {
    code: { type: 'code', required: true, secret: true, maxLength: 8 },
    at: { type: 'datetime', required: true },
    n: { type: 'integer', required: false },
    link: { type: 'url', required: false, maxLength: 40 },
    note: { type: 'string', required: false, maxLength: 5 },
  };
  it('accepts valid values', () => {
    expect(validateVariableValues(schema, { code: 'A1b2', at: '2026-09-24T10:05:00.000Z', n: 3, link: 'https://x.example/a', note: 'hi' })).toEqual([]);
  });
  it.each([
    [{ at: '2026-09-24T10:05:00Z' }, /code: is required/],
    [{ code: 'A1', at: '2026-09-24T10:05:00Z', extra: 1 }, /extra: is not a variable/],
    [{ code: '12-34', at: '2026-09-24T10:05:00Z' }, /code: must be/],
    [{ code: '123456789', at: '2026-09-24T10:05:00Z' }, /code: must be/],
    [{ code: 123456, at: '2026-09-24T10:05:00Z' }, /code: must be a string/],
    [{ code: 'A1', at: '2026-09-24 10:05' }, /at: must be an ISO 8601/],
    [{ code: 'A1', at: '2026-02-30T10:05:00Z' }, /at: must be an ISO 8601/],
    [{ code: 'A1', at: '2026-09-24T10:05:00+01:00' }, /at: must be an ISO 8601/],
    [{ code: 'A1', at: '2026-09-24T10:05:00Z', n: 1.5 }, /n: must be an integer/],
    [{ code: 'A1', at: '2026-09-24T10:05:00Z', n: '3' }, /n: must be an integer/],
    [{ code: 'A1', at: '2026-09-24T10:05:00Z', link: 'http://x.example' }, /link: must be an https URL/],
    [{ code: 'A1', at: '2026-09-24T10:05:00Z', link: 'javascript:alert(1)' }, /link: must be an https URL/],
    [{ code: 'A1', at: '2026-09-24T10:05:00Z', note: 'toolong' }, /note: must be 1-5/],
    [{ code: 'A1', at: '2026-09-24T10:05:00Z', note: 'a\nb' }, /note: must not contain control/],
  ])('refuses %j', (values, message) => {
    expect(validateVariableValues(schema, values).join('\n')).toMatch(message);
  });
  it('never echoes a value in a problem (a value can be a one-time code)', () => {
    expect(validateVariableValues(schema, { code: 'SECRET-99', at: 'x' }).join(' ')).not.toContain('SECRET-99');
  });
});

describe('secret sealing (SDD §12.1): AES-256-GCM, a key ring, bound to its notification', () => {
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);
  const cipher = new NotificationSecretCipher(new Map([['k1', k1], ['k2', k2]]), 'k2');
  it('round-trips, with the active key id recorded, a fresh nonce per seal, and no plaintext in the ciphertext', () => {
    const a = cipher.seal({ code: '482913' }, 'n-1');
    const b = cipher.seal({ code: '482913' }, 'n-1');
    expect(a.keyId).toBe('k2');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.ciphertext.toString('latin1')).not.toContain('482913');
    expect(cipher.open(a.ciphertext, 'k2', 'n-1')).toEqual({ code: '482913' });
  });
  it('refuses a ciphertext moved to another notification, a tampered byte, and an unknown key id', () => {
    const s = cipher.seal({ code: '482913' }, 'n-1');
    expect(() => cipher.open(s.ciphertext, 'k2', 'n-2')).toThrow();
    const t = Buffer.from(s.ciphertext);
    t[t.length - 1] ^= 1;
    expect(() => cipher.open(t, 'k2', 'n-1')).toThrow();
    expect(() => cipher.open(s.ciphertext, 'k9', 'n-1')).toThrow(/not in the key ring/);
  });
  it('an old key still opens its rows after rotation', () => {
    const old = new NotificationSecretCipher(new Map([['k1', k1]]), 'k1').seal({ code: '1' }, 'n-1');
    expect(cipher.open(old.ciphertext, 'k1', 'n-1')).toEqual({ code: '1' });
  });
});

describe('the event map (SDD §7.1): data, exactly the nine mapped Auth events', () => {
  const { catalog } = loadCatalog(fileURLToPath(new URL('../../templates', import.meta.url)));

  it('binds the durable queue notification.events to exactly the nine events, nothing else', () => {
    expect(INTAKE_QUEUE).toBe('notification.events');
    expect([...INTAKE_BINDINGS].sort()).toEqual([
      'admin.operator_code_issued', 'admin.operator_confirmation_code_issued', 'admin.owner_login_from_new_device', 'admin.owner_recovery_completed',
      'admin.owner_recovery_requested', 'member.contact_verification_requested', 'membership.approved', 'membership.rejected', 'membership.revoked',
    ]);
    for (const notConsumed of ['user.registered', 'membership.requested', 'membership.admin_provisioned']) {
      expect(INTAKE_BINDINGS).not.toContain(notConsumed);
      expect(mappingFor('auth-service', notConsumed)).toBeUndefined();
    }
    expect(mappingFor('another-service', 'membership.approved')).toBeUndefined(); // (source, name), not the name alone
  });

  it.each(EVENT_MAP.map((m) => [m.name, m] as const))('%s: its template exists in the catalog with the same category, and its variables are exactly the template\'s', (_n, m) => {
    const t = catalog.templates.find((x) => x.key === m.template);
    expect(t?.category).toBe(m.category);
    for (const v of catalog.versions.filter((x) => x.key === m.template)) expect(Object.keys(m.variables).sort()).toEqual(Object.keys(v.variables).sort());
    for (const field of Object.values(m.variables)) expect(m.payload).toHaveProperty(field);
    if (m.expiresAtFrom) expect(m.payload[m.expiresAtFrom]).toBe('datetime');
  });

  it('payload validation names the missing or mistyped fields only', () => {
    const m = mappingFor('auth-service', 'admin.operator_code_issued')!;
    const good = { userId: 'u-1', channel: 'email', destination: 'p@example.test', code: 'X1', expiresAt: '2026-09-24T10:05:00.000Z', timestamp: '2026-09-24T10:00:00.000Z' };
    expect(payloadProblems(m, good)).toEqual([]);
    expect(payloadProblems(m, { ...good, extraField: 'ignored' })).toEqual([]);
    expect(payloadProblems(m, { ...good, channel: 'fax', expiresAt: 'soon', userId: undefined })).toEqual(['userId', 'channel', 'expiresAt']);
    expect(payloadProblems(m, { ...good, destination: null })).toEqual([]); // valid shape; the intake refuses it as no_destination
    expect(payloadProblems(mappingFor('auth-service', 'membership.approved')!, { ...good, organizationId: 'not-a-uuid' })).toEqual(['organizationId']);
  });
});
