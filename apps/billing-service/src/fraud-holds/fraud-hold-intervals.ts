/**
 * Core V2 S6e-H (BIL-27; the Owner's H-1, H-4, H-5, H-6 and compensation option C-1, 2026-10-29): the pure interval algebra of fraud holds,
 * in exact milliseconds (every instant involved is millisecond-precise: hold times are truncated by the database, paid spans come from
 * millisecond settlement instants and calendar arithmetic). Half-open intervals `[start, end)`.
 *
 * Inputs: the CURRENT paid spans of one Personal Subscription (`billing_personal_spans`: K-3 Option D, reversed purchases already removed)
 * and its holds, each restricting `[placedAt, min(releasedAt, placedAt + 14 days))`.
 *
 * C-1, as approved:
 *   - a RUN is a maximal uninterrupted stretch of paid spans; the time a run lost to holds is its intersection with the UNION of the holds
 *     (overlapping holds never count twice; time outside paid entitlement never counts);
 *   - that time is appended after the run, starting at the later of the run's end and the end of the last hold that touched it (so the
 *     compensation is never itself swallowed by the hold that caused it), up to the next run's start; whatever does not fit carries over
 *     after the next run, and so on. Paid spans keep their dates exactly; compensation never overlaps paid time and is never lost;
 *   - effective entitlement = (paid spans ∪ compensation) minus the holds (a hold restricts compensation time too; that time is not paid,
 *     so it earns nothing).
 * Everything is a function of the current rows: a reversal (refund or final lost chargeback) removes its span, and with it the compensation
 * that span earned; nothing can be resurrected by an earlier computation.
 */
export interface Interval {
  start: number;
  end: number;
}

export interface HoldWindow {
  id: string;
  /** placedAt, ms */
  start: number;
  /** the effective end: min(releasedAt, placedAt + 14 days), ms */
  end: number;
}

export const HOLD_REVIEW_MS = 14 * 24 * 3600 * 1000;

/** Sorted, disjoint, with touching intervals merged; empty intervals dropped. */
export function merge(list: readonly Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).map((i) => ({ ...i })).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push(i);
  }
  return out;
}

export function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const x = merge(a);
  const y = merge(b);
  const out: Interval[] = [];
  for (let i = 0, j = 0; i < x.length && j < y.length;) {
    const start = Math.max(x[i]!.start, y[j]!.start);
    const end = Math.min(x[i]!.end, y[j]!.end);
    if (end > start) out.push({ start, end });
    if (x[i]!.end < y[j]!.end) i++;
    else j++;
  }
  return out;
}

export function subtract(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  const cut = merge(b);
  for (const i of merge(a)) {
    let s = i.start;
    for (const c of cut) {
      if (c.end <= s || c.start >= i.end) continue;
      if (c.start > s) out.push({ start: s, end: c.start });
      s = Math.max(s, c.end);
      if (s >= i.end) break;
    }
    if (s < i.end) out.push({ start: s, end: i.end });
  }
  return out;
}

export const length = (list: readonly Interval[]) => merge(list).reduce((n, i) => n + (i.end - i.start), 0);

/** C-1: the compensation intervals earned by the holds over these paid spans. */
export function compensation(paid: readonly Interval[], holds: readonly HoldWindow[]): Interval[] {
  const runs = merge(paid);
  const held = merge(holds);
  const out: Interval[] = [];
  let carry = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    const denied = length(intersect([run], held));
    const total = carry + denied;
    if (total === 0) continue;
    const touching = holds.filter((h) => h.start < run.end && h.end > run.start && h.end > h.start);
    const start = Math.max(run.end, ...touching.map((h) => h.end));
    const limit = runs[i + 1]?.start ?? Number.POSITIVE_INFINITY;
    if (start >= limit) {
      carry = total; // nothing fits before the next run: after it
      continue;
    }
    const n = Math.min(total, limit - start);
    out.push({ start, end: start + n });
    carry = total - n;
  }
  return out;
}

/** The effective entitlement intervals: paid spans and their compensation, minus every hold's restriction. */
export function effective(paid: readonly Interval[], holds: readonly HoldWindow[]): Interval[] {
  return subtract(merge([...paid, ...compensation(paid, holds)]), holds);
}

/** Valid while `now` lies in an effective interval; `expiresAt` is the end of the uninterrupted effective stretch containing it. */
export function entitlementAt(paid: readonly Interval[], holds: readonly HoldWindow[], now: number): { valid: boolean; expiresAt: number | null } {
  const e = merge(effective(paid, holds));
  const i = e.find((x) => x.start <= now && now < x.end);
  return i ? { valid: true, expiresAt: i.end } : { valid: false, expiresAt: null };
}

/**
 * Compensation evidence: the paid time each hold denied that no EARLIER-placed hold had already denied (so the evidence of overlapping
 * holds sums to the union, never more). Ordered by placement, then id.
 */
export function deniedByHold(paid: readonly Interval[], holds: readonly HoldWindow[]): Map<string, number> {
  const ordered = [...holds].sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  const out = new Map<string, number>();
  const seen: Interval[] = [];
  for (const h of ordered) {
    out.set(h.id, length(subtract(intersect(paid, [h]), seen)));
    seen.push({ start: h.start, end: h.end });
  }
  return out;
}
