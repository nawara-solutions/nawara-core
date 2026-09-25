import { ConfigError } from '@nawara/service-kit';
import { AUDIT_CATEGORIES, type AuditCategory } from './categories.js';

/**
 * The operations a caller policy can grant (Stage 18.1, A38 / A40). Nothing is granted unless listed. `read_organization`: records of
 * exactly one organization per request; `read_platform`: platform-level and cross-organization records (Stage 19's admin service, a
 * security tool). The routes that consume them arrive in Stage 18.6; ingestion is not an HTTP operation (the bus, Stage 18.5).
 */
export const AUDIT_OPERATIONS = ['read_organization', 'read_platform'] as const;
export type AuditOperation = (typeof AUDIT_OPERATIONS)[number];

export interface CallerPolicy {
  operations: ReadonlySet<AuditOperation>;
  /** The categories this caller may read (A40, A52): explicit and non-empty; never a wildcard. */
  categories: ReadonlySet<AuditCategory>;
  /** Optional: only records emitted by these services. Absent = every source service. */
  sourceServices?: ReadonlySet<string>;
}

const KEYS = new Set(['operations', 'categories', 'sourceServices']);
/** The kit's caller-name grammar (a service name). */
const SERVICE_NAME = /^[a-z][a-z0-9-]{1,62}$/;

/**
 * `AUDIT_SERVICE_POLICY` (ADR-0049, SDD §7; the File / Notification caller-policy pattern, ADR-0042 decision 2), parsed and validated at
 * STARTUP:
 *
 *   { "callers": { "<caller>": { "operations": ["read_organization"], "categories": ["business", "commercial"],
 *                                "sourceServices": ["billing-service", "payment-service"] } } }
 *
 * Deny by default: a caller registered in `SERVICE_TOKENS` with no entry, or an entry for a caller with no token, refuses to boot; an
 * unknown operation, category, property, a wildcard or a repeated value refuses to boot. The policy is authorization only: the caller's
 * identity always comes from its authenticated service token, never from a request, and no request value can widen it (there is no
 * organization list in a policy: organization scope is one organization per request, Stage 18.6).
 */
export class AuditCallerPolicy {
  private constructor(private readonly callers: ReadonlyMap<string, CallerPolicy>) {}

  static parse(raw: string | undefined, registered: readonly string[]): AuditCallerPolicy {
    if (raw === undefined || raw.trim() === '') {
      if (registered.length > 0) throw new ConfigError(`AUDIT_SERVICE_POLICY is required: every registered caller needs an explicit entry (deny by default): ${registered.join(', ')}`);
      return new AuditCallerPolicy(new Map());
    }
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      throw new ConfigError('AUDIT_SERVICE_POLICY must be valid JSON');
    }
    const callers = (doc as { callers?: unknown } | null)?.callers;
    if (typeof callers !== 'object' || callers === null || Array.isArray(callers) || Object.keys(doc as object).length !== 1) {
      throw new ConfigError('AUDIT_SERVICE_POLICY must be {"callers": {...}}');
    }
    const map = new Map<string, CallerPolicy>();
    for (const [name, entry] of Object.entries(callers as Record<string, unknown>)) {
      const at = `AUDIT_SERVICE_POLICY: "${name}"`;
      if (!registered.includes(name)) throw new ConfigError(`AUDIT_SERVICE_POLICY names "${name}", which has no registered service token`);
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new ConfigError(`${at} must be an object`);
      const e = entry as Record<string, unknown>;
      for (const k of Object.keys(e)) if (!KEYS.has(k)) throw new ConfigError(`${at} has an unknown property "${k}"`);
      const operations = distinct<AuditOperation>(e.operations, AUDIT_OPERATIONS, `${at}.operations`);
      const categories = distinct<AuditCategory>(e.categories, AUDIT_CATEGORIES, `${at}.categories`);
      let sourceServices: Set<string> | undefined;
      if (e.sourceServices !== undefined) {
        if (!Array.isArray(e.sourceServices) || e.sourceServices.length === 0) throw new ConfigError(`${at}.sourceServices must be a non-empty list when present`);
        for (const s of e.sourceServices) if (typeof s !== 'string' || !SERVICE_NAME.test(s)) throw new ConfigError(`${at}.sourceServices lists something that is not a service name`);
        sourceServices = new Set(e.sourceServices as string[]);
        if (sourceServices.size !== e.sourceServices.length) throw new ConfigError(`${at}.sourceServices lists a service twice`);
      }
      map.set(name, { operations, categories, sourceServices });
    }
    for (const r of registered) if (!map.has(r)) throw new ConfigError(`registered caller "${r}" has no AUDIT_SERVICE_POLICY entry (deny by default)`);
    return new AuditCallerPolicy(map);
  }

  /** The caller's policy, or undefined (then every request is refused). */
  of(caller: string): CallerPolicy | undefined {
    return this.callers.get(caller);
  }

  /** Deny by default: an unknown caller or an operation it was not granted is false. */
  allows(caller: string, operation: AuditOperation): boolean {
    return this.callers.get(caller)?.operations.has(operation) ?? false;
  }
}

/** An explicit, non-empty list of distinct values from `allowed` (no wildcard: `*` is simply not an allowed value). */
function distinct<T extends string>(value: unknown, allowed: readonly string[], at: string): Set<T> {
  if (!Array.isArray(value) || value.length === 0) throw new ConfigError(`${at} must be an explicit, non-empty list`);
  for (const v of value) if (!allowed.includes(v as string)) throw new ConfigError(`${at} lists a value other than ${allowed.join(' / ')}`);
  const set = new Set(value as T[]);
  if (set.size !== value.length) throw new ConfigError(`${at} lists a value twice`);
  return set;
}
