import { ConfigError, parseCallerPolicy } from '@nawara/service-kit';
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
    // V2 A1.3: the document (envelope, registration cross-check both ways, unknown and duplicate keys at any depth) is the kit's
    // shared parser (ADR-0052, ADR-0056 §11); the templates / channels / organizations dimensions below are unchanged.
    const map = parseCallerPolicy<CallerPolicy>(raw, registered, {
      variable: 'NOTIFICATION_SERVICE_POLICY',
      keys: [...KEYS],
      entry: (at, e) => {
        if (!Array.isArray(e.templates) || e.templates.length === 0) throw new ConfigError(`${at} needs an explicit, non-empty templates list (no wildcard)`);
        for (const t of e.templates) if (typeof t !== 'string' || !TEMPLATE_KEY.test(t)) throw new ConfigError(`${at} lists an invalid template key`);
        if (!Array.isArray(e.channels) || e.channels.length === 0) throw new ConfigError(`${at} needs an explicit, non-empty channels list`);
        for (const c of e.channels) if (!(API_CHANNELS as readonly unknown[]).includes(c)) throw new ConfigError(`${at} lists a channel other than ${API_CHANNELS.join(' / ')}`);
        if (e.organizations !== 'none' && e.organizations !== 'request') throw new ConfigError(`${at}.organizations must be "none" or "request"`);
        return { templates: new Set(e.templates as string[]), channels: new Set(e.channels as ApiChannel[]), organizations: e.organizations };
      },
    });
    return new NotificationCallerPolicy(new Map(map.callers().map((c) => [c, map.of(c)!])));
  }

  /** The caller's policy, or undefined (then every request is refused). */
  of(caller: string): CallerPolicy | undefined {
    return this.callers.get(caller);
  }
}
