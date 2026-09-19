const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential|private|signature|otp|pepper|dsn|connection[-_]?string|code$/i;
const REDACTED = '[redacted]';
const MAX_DEPTH = 6;
const MAX_STRING = 2000;

/** Scrubs credential-shaped substrings from free text. */
export function redactString(s: string): string {
  return s
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, '$1$2:[redacted]@')
    .slice(0, MAX_STRING);
}

/** Deep-copies a value for logging with credential-shaped keys and substrings removed. Never throws, bounded depth. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return typeof value === 'function' ? '[function]' : value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}
