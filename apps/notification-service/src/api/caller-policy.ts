import { ConfigError } from '@nawara/service-kit';
import { TEMPLATE_KEY } from '../templates/catalog.js';

/** Channels a caller may request in V1 (SDD §7.2). `IN_APP` exists in the model but no V1 path creates it; `PUSH` does not exist yet. */
export const API_CHANNELS = ['EMAIL', 'SMS'] as const;
export type ApiChannel = (typeof API_CHANNELS)[number];

export interface CallerPolicy {
  /** Template keys this caller may request: an explicit list, no wildcard, no raw content. */
  templates: ReadonlySet<string>;
  /** Channels this caller may request. */
  channels: ReadonlySet<ApiChannel>;
  /** `none`: platform-level only (`organizationId` must be absent or null); `request`: the caller asserts an organization (recorded). */
  organizations: 'none' | 'request';
}

const KEYS = new Set(['templates', 'channels', 'organizations']);

/**
 * `NOTIFICATION_SERVICE_POLICY` (SDD §11.2; the Organization `SERVICE_POLICY` pattern), parsed and validated at STARTUP:
 *
 *   { "callers": { "<caller>": { "templates": ["membership.approved"], "channels": ["EMAIL", "SMS"], "organizations": "request" } } }
 *
 * Deny by default: a caller registered in `SERVICE_TOKENS` with no entry, or an entry for a caller with no token, refuses to boot.
 * The policy is authorization only; the caller's identity always comes from its authenticated service token, never from a request.
 * The event intake is NOT governed by it (its allowlist is the event map).
 */
export class NotificationCallerPolicy {
  private constructor(private readonly callers: ReadonlyMap<string, CallerPolicy>) {}

  static parse(raw: string | undefined, registered: readonly string[]): NotificationCallerPolicy {
    if (raw === undefined || raw.trim() === '') {
      if (registered.length > 0) throw new ConfigError(`NOTIFICATION_SERVICE_POLICY is required: every registered caller needs an explicit entry (deny by default): ${registered.join(', ')}`);
      return new NotificationCallerPolicy(new Map());
    }
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      throw new ConfigError('NOTIFICATION_SERVICE_POLICY must be valid JSON');
    }
    const callers = (doc as { callers?: unknown } | null)?.callers;
    if (typeof callers !== 'object' || callers === null || Array.isArray(callers) || Object.keys(doc as object).length !== 1) {
      throw new ConfigError('NOTIFICATION_SERVICE_POLICY must be {"callers": {...}}');
    }
    const map = new Map<string, CallerPolicy>();
    for (const [name, entry] of Object.entries(callers as Record<string, unknown>)) {
      if (!registered.includes(name)) throw new ConfigError(`NOTIFICATION_SERVICE_POLICY names "${name}", which has no registered service token`);
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new ConfigError(`NOTIFICATION_SERVICE_POLICY: the entry for "${name}" must be an object`);
      const e = entry as Record<string, unknown>;
      for (const k of Object.keys(e)) if (!KEYS.has(k)) throw new ConfigError(`NOTIFICATION_SERVICE_POLICY: "${name}" has an unknown property "${k}"`);
      if (!Array.isArray(e.templates) || e.templates.length === 0) throw new ConfigError(`NOTIFICATION_SERVICE_POLICY: "${name}" needs an explicit, non-empty templates list (no wildcard)`);
      for (const t of e.templates) if (typeof t !== 'string' || !TEMPLATE_KEY.test(t)) throw new ConfigError(`NOTIFICATION_SERVICE_POLICY: "${name}" lists an invalid template key`);
      if (!Array.isArray(e.channels) || e.channels.length === 0) throw new ConfigError(`NOTIFICATION_SERVICE_POLICY: "${name}" needs an explicit, non-empty channels list`);
      for (const c of e.channels) if (!(API_CHANNELS as readonly unknown[]).includes(c)) throw new ConfigError(`NOTIFICATION_SERVICE_POLICY: "${name}" lists a channel other than ${API_CHANNELS.join(' / ')}`);
      if (e.organizations !== 'none' && e.organizations !== 'request') throw new ConfigError(`NOTIFICATION_SERVICE_POLICY: "${name}".organizations must be "none" or "request"`);
      map.set(name, { templates: new Set(e.templates as string[]), channels: new Set(e.channels as ApiChannel[]), organizations: e.organizations });
    }
    for (const r of registered) if (!map.has(r)) throw new ConfigError(`registered caller "${r}" has no NOTIFICATION_SERVICE_POLICY entry (deny by default)`);
    return new NotificationCallerPolicy(map);
  }

  /** The caller's policy, or undefined (then every request is refused). */
  of(caller: string): CallerPolicy | undefined {
    return this.callers.get(caller);
  }
}
