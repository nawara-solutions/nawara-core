import { ConfigError } from '@nawara/service-kit';

/**
 * Service authorization policy (ADR-0042 decisions 2, 3 and 4 and Amendment 1). Authentication (ADR-0033) says WHICH service is calling
 * and nothing else; this policy says what it may do, and it is deny by default: a registered caller with no entry is refused at STARTUP.
 *
 *   hierarchy.reference.read   ids and parents of an organization (organization -> platform -> company), nothing else
 *   hierarchy.read             full read (auth-service's first-touch `ensure`)
 *   hierarchy.write            create or update Platform and Organization: NOT ASSIGNABLE (no accepted decision names a holder)
 *   hierarchy.provision        create a Company: the dedicated provisioning identity only, outside Platform scope
 *
 * Platform is the scope (D2, AD-3): a credential that reads carries an EXPLICIT `allowedPlatforms`; there is no wildcard and no
 * implicit all-Platform access. Organization Service resolves organization -> platform and evaluates the set; a client never supplies it.
 */
export const CAPABILITIES = ['hierarchy.reference.read', 'hierarchy.read', 'hierarchy.write', 'hierarchy.provision'] as const;
export type Capability = (typeof CAPABILITIES)[number];
/** Changing a Company's name has no holder (OPEN-4): no caller can ever be granted this, so the route is denied by default. */
export const COMPANY_UPDATE = 'hierarchy.company.update' as const;
export type RequiredCapability = Capability | typeof COMPANY_UPDATE;

export const SERVICE_POLICY = Symbol('SERVICE_POLICY');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ASSIGNABLE: Capability[] = ['hierarchy.reference.read', 'hierarchy.read', 'hierarchy.provision'];

export interface CallerPolicy {
  capabilities: ReadonlySet<RequiredCapability>;
  /** null only for a test fixture (unrestricted). Production callers always carry an explicit, possibly empty, set. */
  allowedPlatforms: ReadonlySet<string> | null;
}

export class ServicePolicy {
  private constructor(private readonly callers: Map<string, CallerPolicy>) {}

  static empty(): ServicePolicy {
    return new ServicePolicy(new Map());
  }

  /**
   * TEST FIXTURE ONLY: every caller may do everything, unrestricted (the behavior before ADR-0042). Refused in production, and the
   * production configuration path can never produce it. The existing suites use it; the policy suites use the real parser.
   */
  static testFixture(callers: string[], isProduction: boolean): ServicePolicy {
    if (isProduction) throw new ConfigError('the unrestricted test-fixture policy is refused in production');
    const all = new Set<RequiredCapability>([...CAPABILITIES, COMPANY_UPDATE]); // the fixture also holds what no real caller can (OPEN-4)
    return new ServicePolicy(new Map(callers.map((c) => [c, { capabilities: all, allowedPlatforms: null }])));
  }

  static parse(raw: string | undefined, registered: string[]): ServicePolicy {
    if (raw === undefined || raw.trim() === '') {
      if (registered.length > 0) throw new ConfigError(`SERVICE_POLICY is required: every registered caller needs an explicit policy entry (deny by default): ${registered.join(', ')}`);
      return ServicePolicy.empty();
    }
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      throw new ConfigError('SERVICE_POLICY must be valid JSON');
    }
    const callers = (doc as { callers?: Record<string, { capabilities?: unknown; allowedPlatforms?: unknown }> } | null)?.callers;
    if (typeof callers !== 'object' || callers === null || Array.isArray(callers)) throw new ConfigError('SERVICE_POLICY must be {"callers": {...}}');
    const map = new Map<string, CallerPolicy>();
    for (const [name, entry] of Object.entries(callers)) {
      if (!registered.includes(name)) throw new ConfigError(`SERVICE_POLICY names "${name}", which has no registered token`);
      if (typeof entry !== 'object' || entry === null) throw new ConfigError(`SERVICE_POLICY entry for "${name}" is not an object`);
      const caps = entry.capabilities;
      if (!Array.isArray(caps) || caps.length === 0) throw new ConfigError(`"${name}" needs at least one capability`);
      for (const c of caps) {
        if (!(CAPABILITIES as readonly string[]).includes(c as string)) throw new ConfigError(`"${name}": unknown capability ${JSON.stringify(c)}`);
        if (!ASSIGNABLE.includes(c as Capability)) throw new ConfigError(`"${name}": ${String(c)} cannot be assigned (no accepted decision names a holder)`);
      }
      const set = new Set(caps as Capability[]);
      const provisioning = set.has('hierarchy.provision');
      if (provisioning && set.size > 1) throw new ConfigError(`"${name}": the provisioning capability is held by a dedicated identity alone`);
      let platforms: Set<string> | null = null;
      if (provisioning) {
        if (entry.allowedPlatforms !== undefined) throw new ConfigError(`"${name}": provisioning is outside Platform scope and takes no allowedPlatforms`);
      } else {
        const ap = entry.allowedPlatforms;
        if (!Array.isArray(ap)) throw new ConfigError(`"${name}": allowedPlatforms is required (an explicit list, possibly empty; there is no wildcard)`);
        for (const p of ap) if (typeof p !== 'string' || !UUID.test(p)) throw new ConfigError(`"${name}": allowedPlatforms must list platform ids (no wildcard): ${JSON.stringify(p)}`);
        platforms = new Set(ap as string[]);
      }
      map.set(name, { capabilities: set as ReadonlySet<RequiredCapability>, allowedPlatforms: platforms });
    }
    for (const r of registered) if (!map.has(r)) throw new ConfigError(`registered caller "${r}" has no SERVICE_POLICY entry (deny by default)`);
    return new ServicePolicy(map);
  }

  has(caller: string, capability: RequiredCapability): boolean {
    return this.callers.get(caller)?.capabilities.has(capability) === true;
  }

  /** null = unrestricted (a fixture); otherwise the explicit set. A caller with no entry has NO platform. */
  platforms(caller: string): ReadonlySet<string> | null {
    const p = this.callers.get(caller);
    if (!p) return new Set();
    return p.allowedPlatforms;
  }
}

/** Is `platformId` inside a caller's scope? Fails closed for anything unknown. */
export function inScope(allowed: ReadonlySet<string> | null, platformId: string | null | undefined): boolean {
  if (allowed === null) return true;
  return typeof platformId === 'string' && allowed.has(platformId);
}
