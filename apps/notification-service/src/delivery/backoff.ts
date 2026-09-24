/**
 * Retry backoff (SDD §8.3): `base × 2^(attempt-1)`, ±20 % jitter, never above `ceiling`; a provider `Retry-After` hint raises it (never
 * above the ceiling either). The DATABASE holds the result (`nextAttemptAt`): no sleeping in the worker, and a restart keeps the schedule.
 */
export function retryDelayMs(attempt: number, o: { baseMs: number; ceilingMs: number; retryAfterMs?: number; random?: () => number }): number {
  const exp = Math.min(o.ceilingMs, o.baseMs * 2 ** Math.max(0, attempt - 1));
  const jittered = exp * (0.8 + 0.4 * (o.random ?? Math.random)());
  return Math.round(Math.min(o.ceilingMs, Math.max(jittered, o.retryAfterMs ?? 0)));
}
