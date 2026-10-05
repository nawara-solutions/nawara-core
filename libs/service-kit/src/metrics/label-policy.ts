/**
 * V2 A12.2: the metric label policy. A label is a dimension every series is multiplied by, and a series lives as long as the metrics
 * store keeps it: a label that can carry an identity, a secret or free text leaks it permanently and makes the series count unbounded.
 * So a label NAME must come from this catalog, and every label VALUE is resolved through a set fixed by code (a closed list, the
 * router's declared templates, the registered readiness checks). Anything else folds into a sentinel; nothing a request carries can
 * create a series.
 */

/** Every label name a Core metric may use. Adding one is a reviewed change to this file. */
export const LABEL_NAMES = ['service', 'method', 'route', 'status_class', 'outcome', 'kind', 'event', 'queue', 'check', 'pool', 'caller', 'metric'] as const;
export type LabelName = (typeof LABEL_NAMES)[number];

/** The value of a label whose input is outside its set. */
export const OTHER = 'other';
/** The `route` value of a request Express matched to no declared route (404, an unknown path). */
export const UNMATCHED = '__unmatched__';

const SENTINELS: ReadonlySet<string> = new Set([OTHER, UNMATCHED]);

/**
 * Words a label name must never contain (after splitting on `_` and camelCase): an identity, a credential, contact data, a raw
 * request part or free text. The catalog above is checked against this list when the module loads, so a reviewed addition to the
 * catalog cannot slip one in either.
 */
const FORBIDDEN_WORDS: ReadonlySet<string> = new Set([
  'id', 'ids', 'uuid', 'user', 'users', 'account', 'org', 'organization', 'organisation', 'tenant', 'company', 'platform', 'membership',
  'member', 'email', 'mail', 'phone', 'msisdn', 'ip', 'address', 'agent', 'token', 'ticket', 'secret', 'password', 'key', 'session',
  'cookie', 'url', 'uri', 'path', 'query', 'header', 'headers', 'body', 'message', 'msg', 'text', 'reason', 'detail', 'sql', 'statement',
  'request', 'correlation', 'trace', 'span', 'name', 'invoice', 'payment', 'file', 'resource',
]);

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** True when a label name could carry an identity, a secret or free text (`userId`, `org_id`, `email`, `raw_path`, ...). */
export function isForbiddenLabelName(name: string): boolean {
  const ws = words(name);
  return ws.length === 0 || ws.some((w) => FORBIDDEN_WORDS.has(w) || (w.length > 2 && w.endsWith('id')));
}

for (const n of LABEL_NAMES) {
  if (isForbiddenLabelName(n)) throw new Error(`metrics label catalog: "${n}" is a forbidden label name`);
}

/** A declared label value: short, printable, no whitespace or quote (a route template uses `/` and `:`). */
const VALUE = /^[A-Za-z0-9_.:/-]{1,128}$/;

/** Where one label's values come from. `resolve` never throws: a value outside the set becomes `fallback`. */
export interface LabelSet {
  readonly name: LabelName;
  readonly fallback: string;
  resolve(value: unknown): string;
}

/**
 * V2 A12.2a: label sets are AUTHENTIC only when one of this module's factories made them. `BoundedMetrics` refuses any other object,
 * so a structurally identical literal (`{ name: 'route', resolve: (v) => String(v) }`) cannot smuggle raw values into a label. Each
 * authentic set is frozen (its `resolve` cannot be swapped afterwards) and recorded in a module-private WeakSet that is never exported.
 */
const AUTHENTIC = new WeakSet<object>();

function seal(set: LabelSet): LabelSet {
  AUTHENTIC.add(Object.freeze(set));
  return set;
}

/** True only for a label set this module's factories created (never for a copy, a proxy or a look-alike). */
export function isAuthenticLabelSet(set: unknown): set is LabelSet {
  return typeof set === 'object' && set !== null && AUTHENTIC.has(set);
}

/** True when `name` is in the label catalog. */
export function isCatalogLabelName(name: unknown): name is LabelName {
  return typeof name === 'string' && (LABEL_NAMES as readonly string[]).includes(name);
}

function checkName(name: LabelName): void {
  if (!isCatalogLabelName(name)) throw new Error(`metrics: "${String(name)}" is not a catalogued label name`);
}

function checkValue(name: LabelName, v: string): void {
  if (!VALUE.test(v)) throw new Error(`metrics: label "${name}" has a malformed declared value`);
  if (SENTINELS.has(v)) throw new Error(`metrics: label "${name}" cannot declare the reserved value "${v}"`);
}

/** A label whose values are listed once, by code. */
export function closedSet(name: LabelName, values: readonly string[], fallback: string = OTHER): LabelSet {
  checkName(name);
  for (const v of values) checkValue(name, v);
  const set: ReadonlySet<string> = new Set(values);
  return seal({ name, fallback, resolve: (v) => (typeof v === 'string' && set.has(v) ? v : fallback) });
}

/**
 * A closed set computed by code once, on first use (the router's declared route templates exist only after the application has
 * initialised). A supplied value that is malformed or reserved is dropped from the set rather than failing the request path.
 */
export function lazyClosedSet(name: LabelName, supplier: () => readonly string[], fallback: string = OTHER): LabelSet {
  checkName(name);
  let set: ReadonlySet<string> | undefined;
  return seal({
    name,
    fallback,
    resolve: (v) => {
      set ??= new Set(supplier().filter((s) => VALUE.test(s) && !SENTINELS.has(s)));
      return typeof v === 'string' && set.has(v) ? v : fallback;
    },
  });
}

/**
 * A set that grows with names CODE registers after start-up (a readiness check registered in `main.ts`), never with request input:
 * a value is admitted only if it matches `pattern`, and at most `max` values ever; anything else is `fallback`.
 *
 * V2 A12.2a: INTERNAL to the metrics module (not exported by the kit): a permissive pattern fed request values would admit
 * identifiers up to `max`. Its only use is the readiness `check` label, whose values are the names code registers.
 */
export function growingSet(name: LabelName, pattern: RegExp, max: number, fallback: string = OTHER): LabelSet {
  checkName(name);
  if (!Number.isInteger(max) || max < 1 || max > 1000) throw new Error(`metrics: label "${name}" needs a bound between 1 and 1000`);
  const seen = new Set<string>();
  return seal({
    name,
    fallback,
    resolve: (v) => {
      if (typeof v !== 'string' || !VALUE.test(v) || SENTINELS.has(v) || !pattern.test(v)) return fallback;
      if (seen.has(v)) return v;
      if (seen.size >= max) return fallback;
      seen.add(v);
      return v;
    },
  });
}
