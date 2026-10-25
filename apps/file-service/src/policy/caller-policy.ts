import { ConfigError, parseCallerPolicy } from '@nawara/service-kit';
import { EVIDENCE_PURPOSES, type EvidencePurpose } from '../grants/evidence-purposes.js';
import { FILE_MEDIA_TYPES, type FileMediaType } from './media-types.js';

/** The operations a caller policy can grant (SDD §11). Nothing is granted unless listed. */
export const FILE_OPERATIONS = ['upload', 'read', 'attach', 'delete', 'issue_ticket', 'grant', 'read_granted', 'hold'] as const;
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
  /** Present exactly when the caller may `grant` (S2-File.1, OD-FILE F8): the evidence purposes it may grant its own files for. */
  grantPurposes?: ReadonlySet<EvidencePurpose>;
  /** Present exactly when the caller may `read_granted` (S2-File.2): the evidence purposes it may read granted files for. */
  readPurposes?: ReadonlySet<EvidencePurpose>;
}

const KEYS = new Set(['operations', 'organizations', 'mediaTypes', 'maxBytes', 'grantPurposes', 'readPurposes']);

/**
 * `FILE_SERVICE_POLICY` (ADR-0048 §7, SDD §11; the Notification / Organization `SERVICE_POLICY` pattern), parsed and validated at
 * STARTUP:
 *
 *   { "callers": { "<caller>": { "operations": ["upload", "read", "attach", "delete", "issue_ticket"], "organizations": "request",
 *                                "mediaTypes": ["application/pdf", "image/jpeg"], "maxBytes": 10485760 } } }
 *
 * S2-File.1: `grant` (issue and revoke evidence grants on the caller's own files) needs an explicit, non-empty `grantPurposes` list from
 * the closed evidence vocabulary (no wildcard); the grantee is fixed by the purpose, never chosen by the caller or the request.
 * S2-File.2: `read_granted` (read, and issue download tickets for, files granted TO the caller) needs an explicit, non-empty
 * `readPurposes` list from the same vocabulary; it opens nothing but the caller's own active grants.
 * S2-File.3: `hold` (place and release evidence holds on the caller's own files) has no further dimension.
 *
 * Deny by default: a caller registered in `SERVICE_TOKENS` with no entry, or an entry for a caller with no token, refuses to boot; an
 * unknown operation, property, media type or an over-ceiling `maxBytes` refuses to boot. The policy is authorization only: the
 * caller's identity always comes from its authenticated service token, never from a request. Ticket holders (Stage 17.5 / 17.6) are
 * not callers and are not governed by it.
 */
export class FileCallerPolicy {
  private constructor(private readonly callers: ReadonlyMap<string, CallerPolicy>) {}

  static parse(raw: string | undefined, registered: readonly string[], maxBytesCeiling: number): FileCallerPolicy {
    // V2 A1.3: the document (envelope, registration cross-check both ways, unknown and duplicate keys at any depth) is the kit's
    // shared parser (ADR-0052, ADR-0056 §11); the operations / organizations / mediaTypes / maxBytes dimensions below are unchanged,
    // including the FILE_MAX_BYTES ceiling.
    const map = parseCallerPolicy<CallerPolicy>(raw, registered, {
      variable: 'FILE_SERVICE_POLICY',
      keys: [...KEYS],
      entry: (at, e) => {
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
        let grantPurposes: Set<EvidencePurpose> | undefined;
        if (operations.has('grant')) {
          if (!Array.isArray(e.grantPurposes) || e.grantPurposes.length === 0) throw new ConfigError(`${at} may grant, so it needs an explicit, non-empty grantPurposes list`);
          for (const p of e.grantPurposes) if (!(EVIDENCE_PURPOSES as readonly unknown[]).includes(p)) throw new ConfigError(`${at} lists a grant purpose other than ${EVIDENCE_PURPOSES.join(' / ')}`);
          grantPurposes = new Set(e.grantPurposes as EvidencePurpose[]);
          if (grantPurposes.size !== e.grantPurposes.length) throw new ConfigError(`${at} lists a grant purpose twice`);
        } else if (e.grantPurposes !== undefined) {
          throw new ConfigError(`${at}: grantPurposes applies only to a caller that may grant`);
        }
        const readPurposes = purposes(at, operations.has('read_granted'), e.readPurposes, 'read_granted', 'readPurposes');
        return { operations, organizations: e.organizations, mediaTypes, maxBytes, grantPurposes, readPurposes };
      },
    });
    return new FileCallerPolicy(new Map(map.callers().map((c) => [c, map.of(c)!])));
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

/** A purpose list required exactly when `enabled` (the operation is granted): non-empty, from the closed vocabulary, no repeat. */
function purposes(at: string, enabled: boolean, raw: unknown, operation: string, key: string): Set<EvidencePurpose> | undefined {
  if (!enabled) {
    if (raw !== undefined) throw new ConfigError(`${at}: ${key} applies only to a caller that may ${operation}`);
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length === 0) throw new ConfigError(`${at} may ${operation}, so it needs an explicit, non-empty ${key} list`);
  for (const p of raw) if (!(EVIDENCE_PURPOSES as readonly unknown[]).includes(p)) throw new ConfigError(`${at} lists a ${key} entry other than ${EVIDENCE_PURPOSES.join(' / ')}`);
  const set = new Set(raw as EvidencePurpose[]);
  if (set.size !== raw.length) throw new ConfigError(`${at} lists a ${key} entry twice`);
  return set;
}
