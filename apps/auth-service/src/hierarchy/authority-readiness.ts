import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { ReadinessRegistry } from '@nawara/service-kit';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DbService, type Queryable } from '../db/db.service.js';

/** The readiness check's name in `/ready` and in the kit's log lines (A5.4-A5 design §3; owner ruling R4). */
export const HIERARCHY_AUTHORITY_CHECK = 'hierarchy_authority';

/** The reasons of the design's §5 (ADR-0063 §4 and its clarifications; rulings R1 and R4). */
export type HierarchyAuthorityReason =
  | 'source_ahead_of_marker'
  | 'marker_ahead_of_source'
  | 'marker_frozen'
  | 'marker_missing'
  | 'marker_invalid'
  | 'marker_unreadable';

/** What one read of the marker observed: one of its three values, or why it cannot be trusted. Never a raw value. */
export type MarkerObservation = 'local' | 'frozen' | 'org_authoritative' | 'missing' | 'invalid' | 'unreadable';

export type HierarchySource = AppConfig['hierarchy']['source'];

/**
 * Thrown by the check when Auth is not ready. The kit's registry prints only the class and `code` (`describeFailure`), so its line reads
 * `readiness_check_failed check=hierarchy_authority error=HierarchyAuthorityNotReady code=<reason>`; the `/ready` body names the check only.
 */
export class HierarchyAuthorityNotReady extends Error {
  constructor(readonly code: HierarchyAuthorityReason) {
    super(`the hierarchy authority is not ready: ${code}`);
    this.name = 'HierarchyAuthorityNotReady';
  }
}

/**
 * The marker, read strictly (design §4 rows 7 to 9): a failed statement is `unreadable`, no row `missing`, more than one row or an unknown
 * value `invalid`. One read-only statement; it never writes. It is not `hierarchyMode()`, which assumes the row exists.
 */
export async function readMarker(q: Queryable): Promise<MarkerObservation> {
  let rows: Array<{ mode: unknown }>;
  try {
    ({ rows } = await q.query<{ mode: unknown }>('SELECT mode FROM hierarchy_authority'));
  } catch {
    return 'unreadable';
  }
  if (rows.length === 0) return 'missing';
  if (rows.length !== 1) return 'invalid';
  const mode = rows[0]!.mode;
  return mode === 'local' || mode === 'frozen' || mode === 'org_authoritative' ? mode : 'invalid';
}

/**
 * The design's §4 matrix, in its fixed evaluation order: what cannot be trusted first, then `frozen` with either source (R1), then the
 * direction of a disagreement (ruling 1). `null` is ready: the source and the marker agree.
 */
export function evaluate(source: HierarchySource, marker: MarkerObservation): HierarchyAuthorityReason | null {
  if (marker === 'unreadable') return 'marker_unreadable';
  if (marker === 'missing') return 'marker_missing';
  if (marker === 'invalid') return 'marker_invalid';
  if (marker === 'frozen') return 'marker_frozen';
  if (source === 'organization-service' && marker === 'local') return 'source_ahead_of_marker';
  if (source === 'local' && marker === 'org_authoritative') return 'marker_ahead_of_source';
  return null;
}

/**
 * A5.4-A5: Auth's hierarchy-authority readiness check (ADR-0063 §4 and its clarifications; the A5.4-A5 design; rulings R1 to R4).
 *
 * A monitoring signal only: it changes neither `/auth/health`, routing, serving, the container healthcheck nor the deploy wait. It
 * registers at module init and touches the database only when `/ready` runs it (no start-up dependency). It reads the marker on every
 * run, in both sources, and never writes. It never calls organization-service.
 *
 * Because the registry logs only when a check flips between passing and failing, the check writes its own warning when its REASON
 * changes, with enumerated tokens only; a ready result clears the remembered reason.
 */
@Injectable()
export class HierarchyAuthorityReadiness implements OnModuleInit {
  private readonly log = new Logger('HierarchyAuthorityReadiness');
  private lastReason: HierarchyAuthorityReason | null = null;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Optional() @Inject(ReadinessRegistry) private readonly readiness?: ReadinessRegistry,
  ) {}

  onModuleInit(): void {
    this.readiness?.register(HIERARCHY_AUTHORITY_CHECK, () => this.check());
  }

  async check(): Promise<void> {
    const source = this.cfg.hierarchy.source;
    const marker = await readMarker(this.db);
    const reason = evaluate(source, marker);
    if (reason === null) {
      this.lastReason = null;
      return;
    }
    if (reason !== this.lastReason) {
      this.lastReason = reason;
      this.log.warn(`hierarchy_authority_not_ready reason=${reason} source=${source} marker=${marker}`);
    }
    throw new HierarchyAuthorityNotReady(reason);
  }
}
