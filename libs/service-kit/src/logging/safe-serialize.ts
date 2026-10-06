import { failureFacts } from './failure.js';

/**
 * V2 A12.4: the safe serializer behind `JsonLogger`. It turns any value into plain, bounded, JSON-safe data and NEVER throws.
 *
 * - It never runs caller code: only own, enumerable DATA properties are read (through property descriptors); an accessor is
 *   `[accessor]` and is not invoked; `toJSON` and inspection hooks are never called (the output is plain data, so `JSON.stringify` has
 *   nothing of the caller's to call). A Proxy or object whose reflection throws becomes `[unserializable]`.
 * - Category A (secrets) and category B (direct PII) are redacted by KEY; free text is scrubbed of a few narrow, deterministic secret
 *   forms (`scrubText`). Free-text PII is not detected: call sites never put it in a message.
 * - An Error is its bounded facts (`errorType`, `errorCode`, `errorKind`, as `describeFailure` classifies it), never its message, cause or
 *   stack.
 * - Bounds: depth 6, strings 2000 characters, arrays 50 items, objects 50 keys.
 *
 * `redact` / `redactString` (`redact.ts`) are unchanged: the outbox relay stores `redactString` output and the outbox-lag CLI prints it.
 */

export const REDACTED = '[redacted]';
export const MAX_DEPTH = 6;
export const MAX_STRING = 2000;
export const MAX_ITEMS = 50;
export const MAX_KEYS = 50;
const MAX_KEY_LENGTH = 128;
/** Text longer than this is cut before scrubbing, so the scrub's cost is bounded; the result is cut to `MAX_STRING` afterwards. */
const MAX_SCRUB_INPUT = 64 * 1024;

// ---- keys --------------------------------------------------------------------------------------------------------------------------

const normalize = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');
/** `userAgent`, `user_agent`, `User-Agent` -> `user agent`; `HTTPHeader` -> `http header`. */
const words = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Category A families matched anywhere in the normalized key (long enough that a match is not an accident). */
const SECRET_PARTS = ['password', 'passwd', 'secret', 'token', 'jwt', 'authorization', 'cookie', 'apikey', 'credential', 'privatekey', 'signature', 'pepper', 'connectionstring', 'challenge', 'sessionid'];
/** Category A families matched as whole words only (short: `otp` would otherwise match `notPublished`). */
const SECRET_WORDS = new Set(['otp', 'totp', 'dsn']);
/**
 * Any key ending in `code` is a secret (bare `code` included: Auth carries a factor code under it) EXCEPT these explicit operational
 * names (owner decision W2). Fail-closed: a new `smsCode` is redacted until it is reviewed into this list.
 */
const OPERATIONAL_CODES = new Set(['statuscode', 'errorcode', 'providercode', 'failurecode', 'reasoncode', 'exitcode', 'taxcode', 'productcode', 'currencycode', 'countrycode']);
/** Identifiers that contain a secret-family word but carry no secret. */
const ALLOWED_KEYS = new Set(['challengeid']);
/** Category B (direct PII), matched anywhere in the normalized key. */
const PII_PARTS = ['email', 'phone', 'msisdn', 'ipaddress', 'clientaddress', 'remoteaddress', 'useragent', 'recipient', 'fullname', 'firstname', 'lastname', 'displayname'];
/** Category B matched as whole words (`clientIp`, `address`, `destination`, `inviteeContact`). */
const PII_WORDS = new Set(['ip', 'address', 'destination', 'contact']);

/** True when a structured key names a category A secret or category B PII, so its value must not be emitted. */
export function isSensitiveKey(key: string): boolean {
  const n = normalize(key);
  if (ALLOWED_KEYS.has(n)) return false;
  if (n.endsWith('code')) return !OPERATIONAL_CODES.has(n);
  if (SECRET_PARTS.some((p) => n.includes(p)) || PII_PARTS.some((p) => n.includes(p))) return true;
  return words(key).some((w) => SECRET_WORDS.has(w) || PII_WORDS.has(w));
}

// ---- free text ---------------------------------------------------------------------------------------------------------------------

const SECRET_QUERY_KEYS = 'token|access_token|refresh_token|id_token|api_key|apikey|key|secret|password|code|signature|sig|x-amz-signature|x-amz-credential';
const TEXT_RULES: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+["']?[A-Za-z0-9._~+/=-]+["']?/gi, '$1 [redacted]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, '$1$2:[redacted]@'],
  [new RegExp(`([?&;](?:${SECRET_QUERY_KEYS})=)[^&#\\s"'<>]*`, 'gi'), '$1[redacted]'],
  // `password=…` in free text (no `?`/`&`): only the unambiguous names; `code=` and `key=` are ordinary operational words in log lines.
  [/\b((?:password|passwd|secret|client_secret|token|access_token|refresh_token|id_token|api_key|apikey)=)["']?[^&#\s"'<>]*["']?/gi, '$1[redacted]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[redacted-jwt]'],
  [/(\/file\/t\/)[^\s/?#"'<>]+/g, '$1[redacted]'],
];

/** Scrubs bearer/basic credentials, URL passwords, secret query values, JWT-shaped values and file-ticket paths; bounded. Never throws. */
export function scrubText(text: string, max = MAX_STRING): string {
  try {
    let s = text.length > MAX_SCRUB_INPUT ? text.slice(0, MAX_SCRUB_INPUT) : text;
    for (const [pattern, replacement] of TEXT_RULES) s = s.replace(pattern, replacement);
    return s.length > max ? s.slice(0, max) : s;
  } catch {
    return '[unserializable]';
  }
}

// ---- values ------------------------------------------------------------------------------------------------------------------------

type Plain = string | number | boolean | null | Plain[] | { [key: string]: Plain };

// eslint-disable-next-line @typescript-eslint/unbound-method -- intentional: a built-in getter, called only with `.call` on a genuine instance
const getter = (proto: object, name: string): ((this: unknown) => unknown) | undefined => Object.getOwnPropertyDescriptor(proto, name)?.get;
const MAP_SIZE = getter(Map.prototype, 'size');
const SET_SIZE = getter(Set.prototype, 'size');
const ARRAY_BUFFER_LENGTH = getter(ArrayBuffer.prototype, 'byteLength');
const VIEW_LENGTH = getter(Object.getPrototypeOf(Uint8Array.prototype) as object, 'byteLength');
const DATA_VIEW_LENGTH = getter(DataView.prototype, 'byteLength');

/** An own DATA property (never a getter call); `undefined` for an accessor or an absent key. */
function dataOf(owner: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** The class name of an error from data descriptors only (the prototype chain's `constructor`, then that function's own `name`). */
function className(e: object): unknown {
  for (let proto = Object.getPrototypeOf(e) as object | null, hops = 0; proto && hops < 10; proto = Object.getPrototypeOf(proto) as object | null, hops++) {
    const ctor = dataOf(proto, 'constructor');
    if (typeof ctor === 'function') return dataOf(ctor, 'name');
  }
  return undefined;
}

/**
 * A data-only stand-in for an error, so `failureFacts` classifies it WITHOUT running the caller's code: the class name, `name`, `code`,
 * `message` (read for classification only, never emitted) and, for an aggregate, its nested errors (two levels at most).
 */
function standIn(e: Error, level = 0): Error {
  const nested = dataOf(e, 'errors');
  const s: Error =
    e instanceof AggregateError && level < 2 && Array.isArray(nested)
      ? new AggregateError(nested.slice(0, 10).map((n: unknown) => (n instanceof Error ? standIn(n, level + 1) : n)))
      : new Error();
  const cls = className(e);
  Object.defineProperty(s, 'constructor', { value: { name: typeof cls === 'string' ? cls : 'Error' } });
  for (const key of ['name', 'code', 'message']) {
    const v = dataOf(e, key);
    if (typeof v === 'string' || typeof v === 'number') Object.defineProperty(s, key, { value: v });
  }
  return s;
}

/** Facts of an Error, as `describeFailure` classifies it: never its message, cause or stack. */
function errorFacts(e: Error): Plain {
  const f = failureFacts(standIn(e));
  return { errorType: f.error, ...(f.code ? { errorCode: f.code } : {}), ...(f.kind ? { errorKind: f.kind } : {}) };
}

/** A null-prototype record: a `__proto__` key is an ordinary key here. */
const record = (): Record<string, Plain> => Object.create(null) as Record<string, Plain>;

function serializeObject(value: object, depth: number, path: WeakSet<object>): Plain {
  if (value instanceof Error) return errorFacts(value);
  if (value instanceof Date) {
    // a prototype check, never `Object.prototype.toString` (it would read a caller-defined `Symbol.toStringTag` getter)
    const t = Date.prototype.getTime.call(value as Date);
    return Number.isNaN(t) ? '[invalid date]' : new Date(t).toISOString();
  }
  if (ArrayBuffer.isView(value)) return `[binary ${Number((value instanceof DataView ? DATA_VIEW_LENGTH : VIEW_LENGTH)?.call(value))} bytes]`;
  if (value instanceof ArrayBuffer) return `[binary ${Number(ARRAY_BUFFER_LENGTH?.call(value))} bytes]`;
  if (value instanceof Map) return `[Map ${Number(MAP_SIZE?.call(value))}]`;
  if (value instanceof Set) return `[Set ${Number(SET_SIZE?.call(value))}]`;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (path.has(value)) return '[circular]';
  path.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      const length = typeof lengthDescriptor?.value === 'number' ? lengthDescriptor.value : 0;
      const out: Plain[] = [];
      for (let i = 0; i < Math.min(length, MAX_ITEMS); i++) out.push(member(value, String(i), depth, path) ?? null);
      if (length > MAX_ITEMS) out.push(`[+${length - MAX_ITEMS} items]`);
      return out;
    }
    const keys = Object.keys(value);
    const out = record();
    for (const key of keys.slice(0, MAX_KEYS)) {
      const name = scrubText(key, MAX_KEY_LENGTH);
      if (isSensitiveKey(key)) {
        out[name] = REDACTED;
        continue;
      }
      const v = member(value, key, depth, path);
      if (v !== undefined) out[name] = v;
    }
    if (keys.length > MAX_KEYS) out['[+keys]'] = keys.length - MAX_KEYS;
    return out;
  } finally {
    path.delete(value);
  }
}

/** One own property, read through its descriptor: never a getter call. */
function member(owner: object, key: string, depth: number, path: WeakSet<object>): Plain | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(owner, key);
  } catch {
    return '[unserializable]';
  }
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) return '[accessor]';
  return serialize(descriptor.value, depth + 1, path);
}

function serialize(value: unknown, depth: number, path: WeakSet<object>): Plain | undefined {
  try {
    switch (typeof value) {
      case 'string':
        return scrubText(value);
      case 'number':
        return Number.isFinite(value) ? value : null;
      case 'boolean':
        return value;
      case 'bigint':
        return `${value.toString().slice(0, 63)}n`;
      case 'undefined':
        return undefined;
      case 'symbol':
        return '[symbol]';
      case 'function':
        return '[function]';
      default:
        return value === null ? null : serializeObject(value as object, depth, path);
    }
  } catch {
    return '[unserializable]';
  }
}

/**
 * Any value as plain, bounded, redacted JSON data. Never throws; never invokes a getter, `toJSON` or a proxy trap's result as code.
 * `undefined` stays `undefined` (omitted by `JSON.stringify` in an object).
 */
export function safeSerialize(value: unknown): Plain | undefined {
  return serialize(value, 0, new WeakSet());
}

// ---- stacks ------------------------------------------------------------------------------------------------------------------------

export const MAX_STACK_FRAMES = 20;
const MAX_FRAME_LENGTH = 300;
const FRAME = /^\s*at\s/;

/**
 * Owner decision W1: a stack is kept as its `at ...` frames only (at most 20). The header line(s), which hold `Error.message` (and any
 * `[cause]` text), are dropped. Each frame is scrubbed and bounded. Returns `undefined` when nothing safe remains. Never throws.
 */
export function stackFrames(stack: unknown): string | undefined {
  try {
    if (typeof stack !== 'string') return undefined;
    const frames = stack
      .slice(0, MAX_SCRUB_INPUT)
      .split('\n')
      .filter((line) => FRAME.test(line))
      .slice(0, MAX_STACK_FRAMES)
      .map((line) => scrubText(line.trim(), MAX_FRAME_LENGTH));
    return frames.length > 0 ? frames.join('\n') : undefined;
  } catch {
    return undefined;
  }
}

// ---- tokens ------------------------------------------------------------------------------------------------------------------------

/** What `safeToken` returns for a value that is absent, too long or malformed. */
export const INVALID_TOKEN = '[invalid]';

/**
 * A value from outside (a broker header, an event field) for a log line: returned as is only when it is a string of at most `maxLength`
 * characters matching `pattern` (for example `SAFE_ID`, `EVENT_NAME`); otherwise `INVALID_TOKEN`. The input is never echoed. Never throws.
 */
export function safeToken(value: unknown, pattern: RegExp, maxLength = 128): string {
  try {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return INVALID_TOKEN;
    pattern.lastIndex = 0;
    return pattern.test(value) ? value : INVALID_TOKEN;
  } catch {
    return INVALID_TOKEN;
  }
}
