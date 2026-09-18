import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DbService, type Queryable } from '../db/db.service.js';

export type AvailabilityReason =
  | 'NO_SCHEDULE_CONFIGURED' // intentional fail-open: "no restriction", NOT "misconfigured"
  | 'WITHIN_SCHEDULE'
  | 'DAY_OFF'
  | 'TIME_OFF'
  | 'OUTSIDE_WORKING_HOURS';

export interface Availability {
  available: boolean;
  reason: AvailabilityReason;
}

interface Local { date: string; dow: number; minutes: number; y: number; m: number; d: number }

function localParts(at: Date, timeZone: string): Local {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
      .formatToParts(at).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`, dow, minutes: Number(parts.hour) * 60 + Number(parts.minute),
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
  };
}

/** Offset (ms) of `timeZone` from UTC at instant `at`. */
function offsetMs(at: Date, timeZone: string): number {
  const l = localParts(at, timeZone);
  return Date.UTC(l.y, l.m - 1, l.d, Math.floor(l.minutes / 60), l.minutes % 60) - Math.floor(at.getTime() / 60000) * 60000;
}

/** Wall-clock (y-m-d hh:mm) in `timeZone` -> UTC instant (handles DST by re-checking the offset). */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - offsetMs(new Date(guess), timeZone);
  return new Date(guess - offsetMs(new Date(first), timeZone));
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Operator availability from the operator's OWN schedule and time off only. It deliberately does not
 * look at PlatformNonWorkingDay (business calendar, not authentication — ADR-0023) nor at any
 * PlatformAssignment (platform access is decided per request, not at login).
 *
 * Documented semantics, preserved: ZERO schedule rows means "no schedule restriction" (available
 * every day and hour, session ceiling falls back to a flat duration). It is NOT a configuration
 * failure and is never treated as a denial. If the business ever wants fail-closed, change this file
 * and the SDD together.
 */
@Injectable()
export class OperatorAvailabilityService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async check(operatorId: string, now: Date, q: Queryable = this.db): Promise<Availability> {
    const local = localParts(now, this.cfg.operator.timezone);
    const off = await q.query(`SELECT 1 FROM operator_time_off WHERE "userId"=$1 AND date=$2::date`, [operatorId, local.date]);
    if (off.rowCount) return { available: false, reason: 'TIME_OFF' };
    const { rows } = await q.query(`SELECT "dayOfWeek", "startTime", "endTime" FROM operator_schedule WHERE "userId"=$1`, [operatorId]);
    if (rows.length === 0) return { available: true, reason: 'NO_SCHEDULE_CONFIGURED' };
    const today = rows.find((r) => r.dayOfWeek === local.dow);
    if (!today) return { available: false, reason: 'DAY_OFF' };
    const inside = local.minutes >= toMinutes(today.startTime) && local.minutes < toMinutes(today.endTime);
    return inside ? { available: true, reason: 'WITHIN_SCHEDULE' } : { available: false, reason: 'OUTSIDE_WORKING_HOURS' };
  }

  /**
   * End of today's shift (login-code expiry and session ceiling), or a flat fallback when the
   * operator has no schedule. Only meaningful right after `check()` returned available for the same
   * `now`, and always recomputed independently at each call site.
   */
  async shiftEndOrFallback(operatorId: string, now: Date, q: Queryable = this.db): Promise<Date> {
    const local = localParts(now, this.cfg.operator.timezone);
    const { rows } = await q.query(`SELECT "dayOfWeek", "endTime" FROM operator_schedule WHERE "userId"=$1`, [operatorId]);
    if (rows.length === 0) return new Date(now.getTime() + this.cfg.operator.fallbackSessionSec * 1000);
    const today = rows.find((r) => r.dayOfWeek === local.dow);
    if (!today) return now; // not available today: callers treat a ceiling <= now as "no session"
    return zonedToUtc(local.y, local.m, local.d, Number(today.endTime.slice(0, 2)), Number(today.endTime.slice(3, 5)), this.cfg.operator.timezone);
  }
}
