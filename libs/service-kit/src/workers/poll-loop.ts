/** Default bound on how long `stop()` waits for a pass already running (Stage 14.6). Under Docker's 10 s stop grace period. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

export type DrainOutcome = 'idle' | 'drained' | 'timeout';

/**
 * Runs `pass` repeatedly, `intervalMs` after the previous pass ENDED (never two passes at once, never a backlog of ticks), and
 * stops gracefully: `stop()` schedules no new pass and waits, at most `drainTimeoutMs`, for the one already running. Callers stop
 * their loops in `beforeApplicationShutdown`, which Nest runs for every module BEFORE any `onApplicationShutdown` closes the
 * database pool or the broker, so a pass still in flight keeps its dependencies until it ends or the deadline passes.
 * A pass that throws is reported through `onError` and the next one runs as scheduled. A `stop()` whose deadline passes is
 * reported through `onDrainTimeout` (Stage 14.7), so every worker signals an interrupted pass the same way.
 */
export class PollLoop {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private stopped = true;

  constructor(
    private readonly pass: () => Promise<unknown>,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly onDrainTimeout: (drainTimeoutMs: number) => void = () => undefined,
  ) {}

  get running(): boolean {
    return !this.stopped;
  }

  /** The first pass runs after `firstDelayMs` (default: one interval; 0 runs it right away), then every `intervalMs` after the previous one ends. */
  start(intervalMs: number, firstDelayMs = intervalMs): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(firstDelayMs, intervalMs);
  }

  private schedule(delayMs: number, intervalMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped) return;
      this.inFlight = this.pass()
        .then(
          () => undefined,
          (e: unknown) => this.onError(e),
        )
        .finally(() => {
          this.inFlight = undefined;
          this.schedule(intervalMs, intervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }

  /** Stops scheduling, then waits for the running pass, bounded. Never throws: the outcome says what happened (and a timeout is reported). */
  async stop(drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<DrainOutcome> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const current = this.inFlight;
    if (!current) return 'idle';
    let deadline: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      current.then(() => 'drained' as const),
      new Promise<'timeout'>((resolve) => {
        deadline = setTimeout(() => resolve('timeout'), drainTimeoutMs);
      }),
    ]);
    if (deadline) clearTimeout(deadline);
    if (outcome === 'timeout') this.onDrainTimeout(drainTimeoutMs);
    return outcome;
  }
}
