import type { StorageObservation } from '../storage/observed-storage.js';

/**
 * The event counters of the operational snapshot (Stage 17.9, F27). A closed set of names: nothing a request carries can add a label,
 * so the signal stays low-cardinality by construction (never a file, organization, caller, ticket, key, address or request id).
 */
export const OPS_COUNTERS = [
  'upload_busy', // 503: the process's upload bound was full (not a policy decision)
  'download_busy', // 503: the process's download bound was full
  'rate_limited_upload', // 429: a caller / organization budget (F32)
  'rate_limited_ticket',
  'rate_limited_download',
  'redemption_blocked', // 429: a client over its failed-redemption budget
  'ticket_invalid', // 404 ticket_invalid answered (probing shows here)
  'integrity_digest_mismatch', // a download whose bytes did not match the recorded SHA-256 (an incident, never repaired)
  'integrity_size_mismatch', // the stored object's size contradicts the record
  'integrity_object_missing', // the record is AVAILABLE, the object is gone
  'download_deadline', // a download cut by its whole-transfer bound (a client too slow)
] as const;
export type OpsCounter = (typeof OPS_COUNTERS)[number];

/** Outcomes the storage wrapper reports; anything else is folded into `other` (bounded, whatever an adapter ever returns). */
const STORAGE_OUTCOME = /^(ok|aborted|source_error|error|storage_[a-z_]{1,40})$/;

export interface StorageStat {
  count: number;
  sumMs: number;
  maxMs: number;
}

/**
 * Process-local counters and gauges. Counters are drained by each snapshot (per-interval counts); the in-flight gauges are live. The
 * bounds of in-flight work live here so the gauges can never disagree with the gates that enforce them.
 */
export class OpsCounters {
  private counts = new Map<OpsCounter, number>();
  private storage = new Map<string, StorageStat>();
  private inFlight = { upload: 0, download: 0 };

  bump(name: OpsCounter): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }

  /** The storage observer (every `StoragePort` call): count, total and max duration per operation and outcome. */
  readonly observeStorage = (o: StorageObservation): void => {
    const key = `${o.operation}.${STORAGE_OUTCOME.test(o.outcome) ? o.outcome : 'other'}`;
    const s = this.storage.get(key) ?? { count: 0, sumMs: 0, maxMs: 0 };
    s.count += 1;
    s.sumMs += o.durationMs;
    s.maxMs = Math.max(s.maxMs, o.durationMs);
    this.storage.set(key, s);
  };

  /**
   * Takes one slot of `kind` if fewer than `max` are in use: the release (idempotent), or `undefined` when full. Synchronous, so two
   * requests can never both take the last slot.
   */
  tryEnter(kind: 'upload' | 'download', max: number): (() => void) | undefined {
    if (this.inFlight[kind] >= max) return undefined;
    this.inFlight[kind] += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight[kind] -= 1;
    };
  }

  gauges(): { uploadsInFlight: number; downloadsInFlight: number } {
    return { uploadsInFlight: this.inFlight.upload, downloadsInFlight: this.inFlight.download };
  }

  /** The counts since the previous drain (every name, zeros included: a stable line shape), and the storage statistics. */
  drain(): { counts: Record<OpsCounter, number>; storage: [string, StorageStat][] } {
    const counts = Object.fromEntries(OPS_COUNTERS.map((n) => [n, this.counts.get(n) ?? 0])) as Record<OpsCounter, number>;
    const storage = [...this.storage.entries()].sort(([a], [b]) => a.localeCompare(b));
    this.counts = new Map();
    this.storage = new Map();
    return { counts, storage };
  }
}

/** DI token of the one `OpsCounters` of the process. */
export const OPS_COUNTERS_TOKEN = Symbol('OPS_COUNTERS');
