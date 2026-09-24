import { ConfigError } from '@nawara/service-kit';
import { FILE_MEDIA_TYPES, type FileMediaType } from './media-types.js';

/** The operations a caller policy can grant (SDD §11). Nothing is granted unless listed. */
export const FILE_OPERATIONS = ['upload', 'read', 'attach', 'delete', 'issue_ticket'] as const;
export type FileOperation = (typeof FILE_OPERATIONS)[number];

/** Operations that create bytes, so they need the caller's own media types and size ceiling. */
const CREATES_BYTES: ReadonlySet<FileOperation> = new Set(['upload', 'issue_ticket']);

export interface CallerPolicy {
  operations: ReadonlySet<FileOperation>;
  /** `none`: platform files only (no organization); `request`: the caller asserts an organization, recorded on the file. */
  organizations: 'none' | 'request';
  /** Present exactly when the caller may create bytes (`upload` or `issue_ticket`): a subset of the V1 allow-list. */
  mediaTypes?: ReadonlySet<FileMediaType>;
  /** Present exactly when the caller may create bytes: at most FILE_MAX_BYTES; a caller can never raise its own ceiling. */
  maxBytes?: number;
}

const KEYS = new Set(['operations', 'organizations', 'mediaTypes', 'maxBytes']);

/**
 * `FILE_SERVICE_POLICY` (ADR-0048 §7, SDD §11; the Notification / Organization `SERVICE_POLICY` pattern), parsed and validated at
 * STARTUP:
 *
 *   { "callers": { "<caller>": { "operations": ["upload", "read", "attach", "delete", "issue_ticket"], "organizations": "request",
 *                                "mediaTypes": ["application/pdf", "image/jpeg"], "maxBytes": 10485760 } } }
 *
 * Deny by default: a caller registered in `SERVICE_TOKENS` with no entry, or an entry for a caller with no token, refuses to boot; an
 * unknown operation, property, media type or an over-ceiling `maxBytes` refuses to boot. The policy is authorization only: the
 * caller's identity always comes from its authenticated service token, never from a request. Ticket holders (Stage 17.5 / 17.6) are
 * not callers and are not governed by it.
 */
export class FileCallerPolicy {
  private constructor(private readonly callers: ReadonlyMap<string, CallerPolicy>) {}

  static parse(raw: string | undefined, registered: readonly string[], maxBytesCeiling: number): FileCallerPolicy {
    if (raw === undefined || raw.trim() === '') {
      if (registered.length > 0) throw new ConfigError(`FILE_SERVICE_POLICY is required: every registered caller needs an explicit entry (deny by default): ${registered.join(', ')}`);
      return new FileCallerPolicy(new Map());
    }
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      throw new ConfigError('FILE_SERVICE_POLICY must be valid JSON');
    }
    const callers = (doc as { callers?: unknown } | null)?.callers;
    if (typeof callers !== 'object' || callers === null || Array.isArray(callers) || Object.keys(doc as object).length !== 1) {
      throw new ConfigError('FILE_SERVICE_POLICY must be {"callers": {...}}');
    }
    const map = new Map<string, CallerPolicy>();
    for (const [name, entry] of Object.entries(callers as Record<string, unknown>)) {
      const at = `FILE_SERVICE_POLICY: "${name}"`;
      if (!registered.includes(name)) throw new ConfigError(`FILE_SERVICE_POLICY names "${name}", which has no registered service token`);
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new ConfigError(`${at} must be an object`);
      const e = entry as Record<string, unknown>;
      for (const k of Object.keys(e)) if (!KEYS.has(k)) throw new ConfigError(`${at} has an unknown property "${k}"`);

      if (!Array.isArray(e.operations) || e.operations.length === 0) throw new ConfigError(`${at} needs an explicit, non-empty operations list`);
      for (const op of e.operations) if (!(FILE_OPERATIONS as readonly unknown[]).includes(op)) throw new ConfigError(`${at} lists an operation other than ${FILE_OPERATIONS.join(' / ')}`);
      const operations = new Set(e.operations as FileOperation[]);
      if (operations.size !== e.operations.length) throw new ConfigError(`${at} lists an operation twice`);

      if (e.organizations !== 'none' && e.organizations !== 'request') throw new ConfigError(`${at}.organizations must be "none" or "request"`);

      const createsBytes = [...operations].some((op) => CREATES_BYTES.has(op));
      let mediaTypes: Set<FileMediaType> | undefined;
      let maxBytes: number | undefined;
      if (createsBytes) {
        if (!Array.isArray(e.mediaTypes) || e.mediaTypes.length === 0) throw new ConfigError(`${at} may upload or issue tickets, so it needs an explicit, non-empty mediaTypes list`);
        for (const t of e.mediaTypes) if (!(FILE_MEDIA_TYPES as readonly unknown[]).includes(t)) throw new ConfigError(`${at} lists a media type outside the V1 allow-list (${FILE_MEDIA_TYPES.join(', ')})`);
        mediaTypes = new Set(e.mediaTypes as FileMediaType[]);
        if (!Number.isSafeInteger(e.maxBytes) || (e.maxBytes as number) < 1 || (e.maxBytes as number) > maxBytesCeiling) {
          throw new ConfigError(`${at}.maxBytes must be an integer between 1 and FILE_MAX_BYTES (${maxBytesCeiling})`);
        }
        maxBytes = e.maxBytes as number;
      } else if (e.mediaTypes !== undefined || e.maxBytes !== undefined) {
        throw new ConfigError(`${at}: mediaTypes and maxBytes apply only to a caller that may upload or issue tickets`);
      }
      map.set(name, { operations, organizations: e.organizations, mediaTypes, maxBytes });
    }
    for (const r of registered) if (!map.has(r)) throw new ConfigError(`registered caller "${r}" has no FILE_SERVICE_POLICY entry (deny by default)`);
    return new FileCallerPolicy(map);
  }

  /** The caller's policy, or undefined (then every request is refused). */
  of(caller: string): CallerPolicy | undefined {
    return this.callers.get(caller);
  }

  /** Deny by default: an unknown caller or an operation it was not granted is false. */
  allows(caller: string, operation: FileOperation): boolean {
    return this.callers.get(caller)?.operations.has(operation) ?? false;
  }
}
