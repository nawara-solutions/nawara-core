import { validateAuditPayload } from '../src/index.js';
import { jsonbTextLength } from '../src/validate.js';
import { isSecretShaped, isSensitiveKey } from '../src/sensitive.js';
import { SAMPLE_IDS, sampleAuditPayload } from '../src/testing.js';

/** Stage 18.4 §40: hostile and malformed inputs. Every one is refused with a stable code, and no code ever contains the input. */

type Mutable = Record<string, any>;
const base = (): Mutable => JSON.parse(JSON.stringify(sampleAuditPayload('membership.revoked', 'complete')));
const run = (p: unknown) => () => validateAuditPayload(p, 'auth-service');

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return 'accepted';
}

describe('prototype pollution and non-data objects', () => {
  it('refuses __proto__ and constructor keys at every level, and never pollutes Object.prototype', () => {
    const json = (inner: string) => JSON.parse(inner);
    const top = json(`{"__proto__": {"polluted": true}, "action": "membership.revoked"}`);
    expect(run(top)).toThrow('unknown_field');
    const inActor = base();
    inActor.actor = json(`{"type": "user", "id": "${SAMPLE_IDS.user}", "userKind": "owner", "__proto__": {"x": 1}}`);
    expect(run(inActor)).toThrow('unknown_field');
    const inChanges = base();
    inChanges.changes = json(`{"authority": "owner", "was_admin": true, "constructor": {"prototype": {"x": 1}}}`);
    expect(run(inChanges)).toThrow(/invalid_changes|invalid_payload/);
    expect(({} as Mutable).polluted).toBeUndefined();
    expect(({} as Mutable).x).toBeUndefined();
  });

  it('refuses an object whose prototype was replaced, a class instance, a Map, a null-less array payload', () => {
    // A literal `__proto__:` REPLACES the prototype instead of adding a key.
    expect(run({ __proto__: { action: 'membership.revoked' } })).toThrow('invalid_payload');
    class Payload {
      action = 'membership.revoked';
    }
    expect(run(new Payload())).toThrow('invalid_payload');
    expect(run(new Map([['action', 'membership.revoked']]))).toThrow('invalid_payload');
    expect(run([base()])).toThrow('invalid_payload');
    for (const v of [null, undefined, 'membership.revoked', 42, true]) expect(run(v)).toThrow('invalid_payload');
  });

  it('accepts a null-prototype object (JSON-equivalent data)', () => {
    const p = Object.assign(Object.create(null), base());
    expect(run(p)).not.toThrow();
  });

  it('refuses getters (a value that could change between validation and serialization) and symbol keys', () => {
    const p = base();
    let reads = 0;
    Object.defineProperty(p, 'outcome', { enumerable: true, get: () => (reads++ === 0 ? 'succeeded' : 'denied') });
    expect(run(p)).toThrow('invalid_payload');
    const s = base();
    s[Symbol('x') as unknown as string] = 1;
    expect(run(s)).toThrow('invalid_payload');
  });

  it('returns a canonical copy: mutating the input afterwards cannot change what was validated', () => {
    const p = base();
    const out = validateAuditPayload(p, 'auth-service');
    p.changes.authority = 'operator';
    p.resource.id = 'tampered';
    expect(out.changes!.authority).toBe('owner');
    expect(out.resource.id).toBe(SAMPLE_IDS.resource);
    expect(() => {
      (out as Mutable).outcome = 'denied';
    }).toThrow(TypeError);
  });
});

describe('values JSON cannot carry', () => {
  it.each([
    ['function', () => 1],
    ['bigint', 10n],
    ['symbol', Symbol('s')],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['undefined', undefined],
  ])('%s in a change value is refused', (_label, value) => {
    const p = base();
    p.changes.was_admin = value;
    expect(run(p)).toThrow(/invalid_payload|invalid_changes/);
  });

  it('refuses cycles and deep nesting', () => {
    const p = base();
    p.changes.was_admin = { from: { from: { from: true } } };
    expect(run(p)).toThrow(/invalid_payload|invalid_changes/);
    const c = base();
    c.changes.self = c;
    expect(run(c)).toThrow(/invalid_payload|unknown_field|invalid_changes/);
  });

  it('refuses arrays anywhere', () => {
    const cases: Array<[string, (p: Mutable) => void]> = [
      ['changes', (p) => (p.changes = [['authority', 'owner']])],
      ['change value', (p) => (p.changes.was_admin = [true])],
      ['subject', (p) => (p.subject = [p.subject])],
      ['actor', (p) => (p.actor = [p.actor])],
    ];
    for (const [label, mutate] of cases) {
      const p = base();
      mutate(p);
      expect(codeOf(run(p)), label).not.toBe('accepted');
    }
  });

  it('refuses integers beyond ±(2^53 − 1) and fractions', () => {
    // No integer change is cataloged in V1; the grammar is exercised through a boolean slot receiving numbers.
    for (const n of [2 ** 53, -(2 ** 53), 1.5]) {
      const p = base();
      p.changes.was_admin = n;
      expect(run(p)).toThrow('invalid_changes');
    }
  });
});

describe('hostile strings', () => {
  const hostile = [
    'owner\n',
    'owner\r\nx',
    'own\u0000er',
    'owner\u202e',
    '\u200fowner',
    'оwner', // Cyrillic о: a confusable
    "owner'; DROP TABLE audit_record; --",
    '<script>alert(1)</script>',
    'OWNER',
    ' owner',
    'owner ',
  ];

  it.each(hostile.map((h) => [JSON.stringify(h), h]))('code value %s is refused (no trimming, no case folding)', (_label, value) => {
    const p = base();
    p.changes.authority = value;
    expect(run(p)).toThrow(/invalid_changes|sensitive_value/);
  });

  it.each(hostile.map((h) => [JSON.stringify(h), h]))('identifier %s is refused in every id slot', (_label, value) => {
    for (const mutate of [
      (p: Mutable) => (p.actor.id = value),
      (p: Mutable) => (p.resource.id = value),
      (p: Mutable) => (p.subject.id = value),
      (p: Mutable) => (p.organizationId = value),
      (p: Mutable) => (p.causationId = value),
      (p: Mutable) => (p.resource.type = value),
      (p: Mutable) => (p.action = value),
    ]) {
      const p = base();
      mutate(p);
      expect(codeOf(run(p))).not.toBe('accepted');
    }
  });

  it('refuses a huge string and a huge key count quickly, before any per-key work', () => {
    const p = base();
    p.changes.authority = 'a'.repeat(1_000_000);
    expect(run(p)).toThrow(/invalid_changes|sensitive_value/);
    const wide = base();
    for (let i = 0; i < 100_000; i++) wide[`k${i}`] = i;
    const t0 = performance.now();
    expect(run(wide)).toThrow('unknown_field');
    expect(performance.now() - t0).toBeLessThan(1000);
    const wideChanges = base();
    for (let i = 0; i < 20; i++) wideChanges.changes[`k${i}`] = true;
    expect(run(wideChanges)).toThrow(/unknown_field|invalid_changes/);
  });
});

describe('sensitive fields and values (layer 2)', () => {
  const secretKeys = [
    'password', 'password_hash', 'passwordHash', 'otp', 'otp_code', 'token', 'access_token', 'refreshToken', 'authorization', 'Authorization',
    'cookie', 'set_cookie', 'api_key', 'apiKey', 'API-KEY', 'secret', 'client_secret', 'service_token', 'reset_token', 'file_ticket',
    'ticket', 'storage_key', 'storageKey', 'signed_url', 'card_number', 'cvv', 'pin', 'private_key', 'credentials', 'bearer',
    'webauthn_assertion', 'session_id', 'sid', 'jwt',
  ];
  const piiKeys = ['email', 'phone', 'phone_number', 'ip', 'ip_address', 'ipAddress', 'user_agent', 'userAgent', 'full_name', 'first_name', 'name', 'address', 'date_of_birth'];

  it.each([...secretKeys, ...piiKeys])('key %s is refused as sensitive_field at the top level, in changes, actor, resource and subject', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
    for (const mutate of [
      (p: Mutable) => (p[key] = 'x'),
      (p: Mutable) => (p.changes[key] = 'x'),
      (p: Mutable) => (p.actor[key] = 'x'),
      (p: Mutable) => (p.resource[key] = 'x'),
      (p: Mutable) => (p.subject[key] = 'x'),
    ]) {
      const p = base();
      mutate(p);
      expect(run(p)).toThrow('sensitive_field');
    }
  });

  it('a sensitive key is refused BEFORE its value is looked at, and the error never contains the key or the value', () => {
    const p = base();
    p.changes.password = 'hunter2-super-secret';
    let caught: unknown;
    try {
      validateAuditPayload(p, 'auth-service');
    } catch (e) {
      caught = e;
    }
    const err = caught as Error & { code: string };
    expect(err.code).toBe('sensitive_field');
    expect(err.message).toBe('sensitive_field');
    expect(JSON.stringify({ code: err.code, message: err.message, name: err.name, own: Object.entries(err) })).not.toMatch(/password|hunter2/);
  });

  it('secret-shaped values are refused (JWT, long hex, base64), UUIDs and cataloged codes are not', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const shaped = [jwt, 'a'.repeat(8) + '0123456789abcdef0123456789abcdef', 'dGhpcyBpcyBhIHNlY3JldCBrZXkgbWF0ZXJpYWwxMjM0', 'AKIAIOSFODNN7EXAMPLEKEY1234567890ab'];
    for (const s of shaped) expect(isSecretShaped(s), s).toBe(true);
    for (const s of [SAMPLE_IDS.user, 'org_admin', 'file_download_integrity_check', '2026-09-25T10:00:00.000Z', 'hierarchy.admin_operation_denied']) {
      expect(isSecretShaped(s), s).toBe(false);
    }
    for (const s of shaped) {
      const p = base();
      p.changes.authority = s;
      expect(run(p)).toThrow('sensitive_value');
      const q = base();
      q.unknown_note = s;
      expect(run(q)).toThrow('sensitive_value');
    }
  });

  it('an unknown, innocuous-looking field is still refused (the allow-list is the primary defense)', () => {
    for (const key of ['note', 'debug', 'context', 'extra', 'metadata', 'details', 'reasonText']) {
      const p = base();
      p[key] = 'x';
      expect(run(p), key).toThrow('unknown_field');
    }
  });
});

describe('the jsonb size model', () => {
  it('computes the length PostgreSQL prints for jsonb (spaces after : and ,)', () => {
    expect(jsonbTextLength({ a: 1 })).toBe('{"a": 1}'.length);
    expect(jsonbTextLength({ a: 'x', b: true })).toBe('{"a": "x", "b": true}'.length);
    expect(jsonbTextLength({ r: { from: 'a', to: 'b' } })).toBe('{"r": {"from": "a", "to": "b"}}'.length);
  });
});
