import { ConfigError } from '@nawara/service-kit';
import { REGISTRY_KEY } from '../domain/model.js';

/**
 * The capabilities a caller policy can grant (ADR-0051 §8: "an ADR-0042 policy with the `release.register` / `release.publish`
 * capabilities, per product"). Nothing is granted unless listed; the two are independent (a caller may hold one without the other).
 * Withdrawal and minimum-version changes are NOT service capabilities: they belong to the verified owner (Stage 20.4).
 */
export const RELEASE_CAPABILITIES = ['release.register', 'release.publish'] as const;
export type ReleaseCapability = (typeof RELEASE_CAPABILITIES)[number];

export interface CallerPolicy {
  /** Product key → the capabilities this caller holds for THAT product only. Explicit and non-empty; never a wildcard. */
  products: ReadonlyMap<string, ReadonlySet<ReleaseCapability>>;
}

/**
 * `RELEASE_SERVICE_POLICY` (ADR-0042 decision 2: identity token + server-side policy in the target, deny by default; the File / Audit /
 * Notification caller-policy pattern), parsed and validated at STARTUP:
 *
 *   { "callers": { "<caller>": { "products": { "<product key>": ["release.register", "release.publish"] } } } }
 *
 * - Deny by default: a caller registered in `SERVICE_TOKENS` with no entry, or an entry for a caller with no token, refuses to boot.
 * - Product is the scope dimension (ADR-0051: Product exists partly to scope authority): a credential for product A has no authority on
 *   product B. A product key must be a registry key (`^[a-z][a-z0-9-]{0,62}$`), so `*` or any other wildcard cannot be expressed.
 * - An unknown capability, property, an empty or repeated list refuses to boot.
 *
 * The policy is authorization only: the caller's identity always comes from its authenticated service token, never from a request
 * value, and no request value (a header, a body field) can widen it.
 */
export class ReleaseCallerPolicy {
  private constructor(private readonly callers: ReadonlyMap<string, CallerPolicy>) {}

  static parse(raw: string | undefined, registered: readonly string[]): ReleaseCallerPolicy {
    if (raw === undefined || raw.trim() === '') {
      if (registered.length > 0) throw new ConfigError(`RELEASE_SERVICE_POLICY is required: every registered caller needs an explicit entry (deny by default): ${registered.join(', ')}`);
      return new ReleaseCallerPolicy(new Map());
    }
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      throw new ConfigError('RELEASE_SERVICE_POLICY must be valid JSON');
    }
    const callers = (doc as { callers?: unknown } | null)?.callers;
    if (typeof callers !== 'object' || callers === null || Array.isArray(callers) || Object.keys(doc as object).length !== 1) {
      throw new ConfigError('RELEASE_SERVICE_POLICY must be {"callers": {...}}');
    }
    const map = new Map<string, CallerPolicy>();
    for (const [name, entry] of Object.entries(callers as Record<string, unknown>)) {
      const at = `RELEASE_SERVICE_POLICY: "${name}"`;
      if (!registered.includes(name)) throw new ConfigError(`RELEASE_SERVICE_POLICY names "${name}", which has no registered service token`);
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new ConfigError(`${at} must be an object`);
      const e = entry as Record<string, unknown>;
      for (const k of Object.keys(e)) if (k !== 'products') throw new ConfigError(`${at} has an unknown property "${k}"`);
      const products = e.products;
      if (typeof products !== 'object' || products === null || Array.isArray(products) || Object.keys(products).length === 0) {
        throw new ConfigError(`${at}.products must be an explicit, non-empty object of product key → capabilities`);
      }
      const scoped = new Map<string, ReadonlySet<ReleaseCapability>>();
      for (const [product, caps] of Object.entries(products as Record<string, unknown>)) {
        if (!REGISTRY_KEY.test(product)) throw new ConfigError(`${at}.products has a key that is not a product registry key`);
        if (!Array.isArray(caps) || caps.length === 0) throw new ConfigError(`${at}.products.${product} must be an explicit, non-empty list`);
        for (const c of caps) if (!(RELEASE_CAPABILITIES as readonly unknown[]).includes(c)) throw new ConfigError(`${at}.products.${product} lists a value other than ${RELEASE_CAPABILITIES.join(' / ')}`);
        const set = new Set(caps as ReleaseCapability[]);
        if (set.size !== caps.length) throw new ConfigError(`${at}.products.${product} lists a capability twice`);
        scoped.set(product, set);
      }
      map.set(name, { products: scoped });
    }
    for (const r of registered) if (!map.has(r)) throw new ConfigError(`registered caller "${r}" has no RELEASE_SERVICE_POLICY entry (deny by default)`);
    return new ReleaseCallerPolicy(map);
  }

  /** Deny by default: an unknown caller, a capability it holds for no product, is false. */
  holds(caller: string, capability: ReleaseCapability): boolean {
    for (const caps of this.callers.get(caller)?.products.values() ?? []) if (caps.has(capability)) return true;
    return false;
  }

  /** Deny by default: true only when the caller holds `capability` for exactly this product. */
  allows(caller: string, product: string, capability: ReleaseCapability): boolean {
    return this.callers.get(caller)?.products.get(product)?.has(capability) ?? false;
  }
}
