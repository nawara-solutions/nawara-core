import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, EnvReader, assertDistinctKeys, decodeKey, readKey, readKeyRing, readOptionalKey, readOptionalKeyEntries } from '../src/index.js';

const reader = (env: Record<string, string | undefined>) => new EnvReader(env as NodeJS.ProcessEnv, () => { throw new Error('ENOENT'); });
const b64 = (bytes: Buffer) => bytes.toString('base64');
const key32 = () => randomBytes(32);
const local = { isProduction: false };
const prod = { isProduction: true };

/** Asserts a ConfigError matching `message` whose text contains none of `secrets`. */
const refused = (fn: () => unknown, message: RegExp, ...secrets: string[]) => {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toMatch(message);
  for (const s of secrets) expect((error as Error).message).not.toContain(s);
};

/** A value of the tracked root `.env.example` (a published development secret); never printed. */
const templateValue = (name: string): string => {
  const line = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`template variable missing: ${name}`);
  return line.slice(name.length + 1).trim();
};

describe('V2 A2.1: decodeKey (strict canonical base64, size, production refusals)', () => {
  it('accepts padded and unpadded canonical standard base64 and returns the bytes', () => {
    const k = key32();
    expect(decodeKey('K', b64(k), local).equals(k)).toBe(true);
    expect(decodeKey('K', b64(k).replace(/=+$/, ''), local).equals(k)).toBe(true);
    const k33 = randomBytes(33); // no padding at all
    expect(decodeKey('K', b64(k33), local).equals(k33)).toBe(true);
  });

  it.each([
    ['the URL-safe alphabet', (s: string) => `${s.slice(0, 10)}-_${s.slice(12)}`],
    ['an embedded space', (s: string) => `${s.slice(0, 10)} ${s.slice(10)}`],
    ['an embedded newline', (s: string) => `${s.slice(0, 10)}\n${s.slice(10)}`],
    ['an invalid character', (s: string) => `${s.slice(0, 20)}*${s.slice(20)}`],
    ['a trailing invalid character', (s: string) => `${s}!`],
    ['too much padding', (s: string) => `${s}=`],
    ['padding in the middle', (s: string) => `${s.slice(0, 8)}=${s.slice(9)}`],
    ['a length that cannot be base64 (4n+1)', (s: string) => `${s.replace(/=+$/, '')}AA`],
    ['a non-canonical final character', (s: string) => s.replace(/(.)=$/, (_, c: string) => `${String.fromCharCode(c.charCodeAt(0) ^ 1)}=`)],
    ['the empty string', () => ''],
  ])('refuses %s, without echoing it', (_label, mutate) => {
    const raw = mutate(b64(key32()));
    refused(() => decodeKey('K', raw, local), /^K must be standard base64/, ...(raw === '' ? [] : [raw]));
  });

  it('enforces the decoded size: at least 32 by default, a chosen minimum, or an exact size', () => {
    refused(() => decodeKey('K', b64(randomBytes(31)), local), /^K must decode to at least 32 bytes$/);
    expect(decodeKey('K', b64(randomBytes(16)), { ...local, minBytes: 16 }).length).toBe(16);
    refused(() => decodeKey('K', b64(randomBytes(33)), { ...local, exactBytes: 32 }), /^K must decode to exactly 32 bytes$/);
    refused(() => decodeKey('K', b64(randomBytes(31)), { ...local, exactBytes: 32 }), /exactly 32 bytes/);
    expect(decodeKey('K', b64(key32()), { ...local, exactBytes: 32 }).length).toBe(32);
  });

  it('production refuses a key that does not look random (fewer than 12 distinct bytes in its first 32); development accepts it', () => {
    const weak = b64(Buffer.alloc(32, 7));
    const elevenValues = b64(Buffer.from(Array.from({ length: 32 }, (_, i) => i % 11)));
    const twelveValues = b64(Buffer.from(Array.from({ length: 32 }, (_, i) => i % 12)));
    refused(() => decodeKey('K', weak, prod), /^K does not look random and is refused in production$/, weak);
    refused(() => decodeKey('K', elevenValues, prod), /does not look random/);
    expect(decodeKey('K', twelveValues, prod).length).toBe(32);
    expect(decodeKey('K', weak, local).length).toBe(32);
    expect(decodeKey('K', b64(key32()), prod).length).toBe(32);
  });

  it('production refuses a published development key (padded or unpadded); development accepts it', () => {
    for (const name of ['AUTH_JWT_SECRET', 'FILE_REQUEST_HASH_KEY', 'NOTIFICATION_REQUEST_HASH_KEY']) {
      const published = templateValue(name);
      refused(() => decodeKey('K', published, prod), /^K is a published development key and is refused in production$/, published);
      refused(() => decodeKey('K', published.replace(/=+$/, ''), prod), /published development key/, published);
      expect(decodeKey('K', published, local).length).toBeGreaterThanOrEqual(32);
    }
  });
});

describe('V2 A2.1: readKey / readOptionalKey', () => {
  it('reads a required key, an optional key, and fails closed when the required one is unset or blank', () => {
    const k = key32();
    expect(readKey(reader({ K: ` ${b64(k)} ` }), 'K', local).equals(k)).toBe(true);
    refused(() => readKey(reader({ K: '  ' }), 'K', local), /^K is required$/);
    expect(readOptionalKey(reader({}), 'K', local)).toBeUndefined();
    expect(readOptionalKey(reader({ K: ' ' }), 'K', local)).toBeUndefined();
    expect(readOptionalKey(reader({ K: b64(k) }), 'K', local)?.equals(k)).toBe(true);
    refused(() => readOptionalKey(reader({ K: 'not*base64' }), 'K', local), /standard base64/, 'not*base64');
  });
});

describe('V2 A2.1: readKeyRing', () => {
  const ring = (...entries: Array<[string, Buffer]>) => entries.map(([id, k]) => `${id}:${b64(k)}`).join(',');

  it('reads the ring and its active id, tolerating spaces around entries', () => {
    const [a, b] = [key32(), key32()];
    const r = readKeyRing(reader({ R: ` k1:${b64(a)} , k2:${b64(b)} `, R_ACTIVE: 'k2' }), 'R', 'R_ACTIVE', { ...local, exactBytes: 32 });
    expect([...r.keys.keys()]).toEqual(['k1', 'k2']);
    expect(r.keys.get('k1')!.equals(a)).toBe(true);
    expect(r.activeKeyId).toBe('k2');
  });

  it('refuses a malformed entry, a bad id, a repeated id, a repeated key, an unknown or missing active id, and a bad key', () => {
    const [a, b] = [key32(), key32()];
    const rules = { ...local, exactBytes: 32 };
    refused(() => readKeyRing(reader({ R: b64(a), R_ACTIVE: 'k1' }), 'R', 'R_ACTIVE', rules), /^R must be "id:base64\[,id:base64\]"/, b64(a));
    refused(() => readKeyRing(reader({ R: `:${b64(a)}`, R_ACTIVE: 'k1' }), 'R', 'R_ACTIVE', rules), /must be "id:base64/);
    refused(() => readKeyRing(reader({ R: `bad id:${b64(a)}`, R_ACTIVE: 'k1' }), 'R', 'R_ACTIVE', rules), /must be "id:base64/);
    refused(() => readKeyRing(reader({ R: `${ring(['k1', a])},`, R_ACTIVE: 'k1' }), 'R', 'R_ACTIVE', rules), /must be "id:base64/);
    refused(() => readKeyRing(reader({ R: ring(['k1', a], ['k1', b]), R_ACTIVE: 'k1' }), 'R', 'R_ACTIVE', rules), /^R must not repeat a key id$/, b64(a), b64(b));
    refused(() => readKeyRing(reader({ R: ring(['k1', a], ['k2', a]), R_ACTIVE: 'k1' }), 'R', 'R_ACTIVE', rules), /^R must not repeat a key$/, b64(a));
    refused(() => readKeyRing(reader({ R: ring(['k1', a]), R_ACTIVE: 'k9' }), 'R', 'R_ACTIVE', rules), /^R_ACTIVE does not name a key in R$/);
    refused(() => readKeyRing(reader({ R: ring(['k1', a]) }), 'R', 'R_ACTIVE', rules), /^R_ACTIVE is required$/);
    refused(() => readKeyRing(reader({ R: `k1:${b64(randomBytes(31))}`, R_ACTIVE: 'k1' }), 'R', 'R_ACTIVE', rules), /^R must decode to exactly 32 bytes$/);
  });

  it('production refuses a published development key inside the ring', () => {
    const published = templateValue('NOTIFICATION_SECRET_KEYS');
    refused(() => readKeyRing(reader({ R: published, R_ACTIVE: published.split(':')[0] }), 'R', 'R_ACTIVE', { ...prod, exactBytes: 32 }), /published development key/, published.split(':')[1]);
  });
});

describe('V2 A4.7: readOptionalKeyEntries (an optional ring without an active id)', () => {
  const ring = (...entries: Array<[string, Buffer]>) => entries.map(([id, k]) => `${id}:${b64(k)}`).join(',');

  it('is undefined when the variable is unset or blank, and reads the entries in order, tolerating spaces', () => {
    expect(readOptionalKeyEntries(reader({}), 'R', local)).toBeUndefined();
    expect(readOptionalKeyEntries(reader({ R: '  ' }), 'R', local)).toBeUndefined();
    const [a, b] = [key32(), key32()];
    const r = readOptionalKeyEntries(reader({ R: ` k1:${b64(a)} , k-2_X:${b64(b)} ` }), 'R', local)!;
    expect([...r.keys()]).toEqual(['k1', 'k-2_X']);
    expect(r.get('k1')!.equals(a) && r.get('k-2_X')!.equals(b)).toBe(true);
  });

  it('reads NAME_FILE through EnvReader, and refuses NAME together with NAME_FILE', () => {
    const a = key32();
    const files: Record<string, string> = { '/run/secrets/r': `k1:${b64(a)}\n` };
    const fileReader = (env: Record<string, string>) => new EnvReader(env as NodeJS.ProcessEnv, (p) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p];
    });
    expect(readOptionalKeyEntries(fileReader({ R_FILE: '/run/secrets/r' }), 'R', local)!.get('k1')!.equals(a)).toBe(true);
    refused(() => readOptionalKeyEntries(fileReader({ R: `k1:${b64(a)}`, R_FILE: '/run/secrets/r' }), 'R', local), /^set R or R_FILE, not both$/, b64(a));
  });

  it('refuses a malformed entry, a bad id, a repeated id or key, and a bad key, with the readKeyRing messages and no value', () => {
    const [a, b] = [key32(), key32()];
    refused(() => readOptionalKeyEntries(reader({ R: b64(a) }), 'R', local), /^R must be "id:base64\[,id:base64\]" with ids of 1 to 32 letters, digits, _ or -$/, b64(a));
    refused(() => readOptionalKeyEntries(reader({ R: `:${b64(a)}` }), 'R', local), /must be "id:base64/, b64(a));
    refused(() => readOptionalKeyEntries(reader({ R: `bad id:${b64(a)}` }), 'R', local), /must be "id:base64/, b64(a));
    refused(() => readOptionalKeyEntries(reader({ R: `${'x'.repeat(33)}:${b64(a)}` }), 'R', local), /must be "id:base64/, b64(a));
    refused(() => readOptionalKeyEntries(reader({ R: `${ring(['k1', a])},` }), 'R', local), /must be "id:base64/, b64(a));
    refused(() => readOptionalKeyEntries(reader({ R: ring(['k1', a], ['k1', b]) }), 'R', local), /^R must not repeat a key id$/, b64(a), b64(b));
    refused(() => readOptionalKeyEntries(reader({ R: ring(['k1', a], ['k2', a]) }), 'R', local), /^R must not repeat a key$/, b64(a));
    refused(() => readOptionalKeyEntries(reader({ R: `k1:${b64(randomBytes(31))}` }), 'R', local), /^R must decode to at least 32 bytes$/);
    refused(() => readOptionalKeyEntries(reader({ R: `k1:${b64(a)}!` }), 'R', local), /^R must be standard base64/, b64(a));
    refused(() => readOptionalKeyEntries(reader({ R: `k1:${b64(a).replace(/\+/g, '-').replace(/\//g, '_')}x` }), 'R', local), /^R must be standard base64/);
  });

  it('enforces an entry cap only when one is requested', () => {
    const four = ring(['a', key32()], ['b', key32()], ['c', key32()], ['d', key32()]);
    expect(readOptionalKeyEntries(reader({ R: four }), 'R', local)!.size).toBe(4);
    refused(() => readOptionalKeyEntries(reader({ R: four }), 'R', local, { maxEntries: 3 }), /^R must hold at most 3 keys$/);
    expect(readOptionalKeyEntries(reader({ R: ring(['a', key32()], ['b', key32()], ['c', key32()]) }), 'R', local, { maxEntries: 3 })!.size).toBe(3);
  });

  it('production refuses a published development key and a non-random key; development accepts them', () => {
    const published = templateValue('NOTIFICATION_SECRET_KEYS');
    const [id, value] = published.split(':');
    refused(() => readOptionalKeyEntries(reader({ R: published }), 'R', prod), /^R is a published development key and is refused in production$/, value);
    refused(() => readOptionalKeyEntries(reader({ R: `k1:${b64(Buffer.alloc(32, 7))}` }), 'R', prod), /^R does not look random and is refused in production$/);
    expect(readOptionalKeyEntries(reader({ R: published }), 'R', local)!.has(id)).toBe(true);
  });
});

describe('V2 A2.1: assertDistinctKeys (one key, one purpose)', () => {
  it('accepts distinct material and refuses reuse within or across purposes, naming only the variables', () => {
    const [a, b] = [key32(), key32()];
    expect(() => assertDistinctKeys([['A', a], ['B', b]])).not.toThrow();
    refused(() => assertDistinctKeys([['A', a], ['B', Buffer.from(a)]]), /^B must differ from A \(one key, one purpose\)$/, b64(a), a.toString('hex'));
    refused(() => assertDistinctKeys([['A', a], ['A', Buffer.from(a)]]), /^A must not repeat a key$/);
  });
});
