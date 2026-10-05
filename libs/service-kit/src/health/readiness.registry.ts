import { Injectable, Logger } from '@nestjs/common';
import { describeFailure } from '../logging/failure.js';

export type ReadinessCheck = () => Promise<void>;

export interface ReadinessResult {
  ok: boolean;
  /** Names of failing checks. Never their error text: /ready answers operators and load balancers, not clients. */
  failed: string[];
}

/** A check that did not answer within the registry's per-check timeout. */
export class ReadinessCheckTimeout extends Error {
  constructor(timeoutMs: number) {
    super(`readiness check did not answer within ${timeoutMs} ms`);
    this.name = 'ReadinessCheckTimeout';
  }
}

export type ReadinessLog = (level: 'info' | 'warn', message: string) => void;

/** V2 A12.2: what one readiness run found, handed to an observer (metrics) after the result is decided. */
export interface ReadinessObservation {
  ready: boolean;
  /** True when the run was answered by the drain (no check ran). */
  draining: boolean;
  checks: ReadonlyArray<{ name: string; ok: boolean; durationMs: number }>;
}

export type ReadinessObserver = (observation: ReadinessObservation) => void;

const nestLog = (): ReadinessLog => {
  const logger = new Logger('Readiness');
  return (level, message) => (level === 'info' ? logger.log(message) : logger.warn(message));
};

/**
 * Dependencies (database, broker, ...) register a named check; `/ready` runs them all with a per-check timeout.
 * Stage 14.7: a check's failure CAUSE never reaches the response, so it is logged instead, and only when the check's state CHANGES
 * (`readiness_check_failed` with the failure class, then `readiness_check_recovered`): a probe every few seconds against a database
 * that stays down writes one line, not one per probe.
 */
@Injectable()
export class ReadinessRegistry {
  private readonly checks = new Map<string, ReadinessCheck>();
  private readonly lastOk = new Map<string, boolean>();
  private observer?: ReadinessObserver;

  constructor(
    private readonly timeoutMs = 2000,
    private readonly log: ReadinessLog = nestLog(),
    /** Stage 15.5: true once shutdown has started. The instance is then not ready, whatever its dependencies say. */
    private readonly draining: () => boolean = () => false,
  ) {}

  register(name: string, check: ReadinessCheck): void {
    this.checks.set(name, check);
  }

  /**
   * V2 A12.2: one observer (the metrics) is told what each run found, AFTER the result is decided. It never runs a check, and it
   * cannot change the result, the response, the timing or the log lines: a throwing observer is ignored.
   */
  setObserver(observer: ReadinessObserver): void {
    if (this.observer) throw new Error('a readiness observer is already set');
    this.observer = observer;
  }

  async run(): Promise<ReadinessResult> {
    if (this.draining()) {
      this.notify({ ready: false, draining: true, checks: [] });
      return { ok: false, failed: ['shutting_down'] };
    }
    const failed: string[] = [];
    const observed: Array<{ name: string; ok: boolean; durationMs: number }> = [];
    await Promise.all(
      [...this.checks].map(async ([name, check]) => {
        let timer: NodeJS.Timeout | undefined;
        const started = performance.now();
        let ok = false;
        try {
          await Promise.race([
            check(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new ReadinessCheckTimeout(this.timeoutMs)), this.timeoutMs);
            }),
          ]);
          if (this.lastOk.get(name) === false) this.log('info', `readiness_check_recovered check=${name}`);
          this.lastOk.set(name, true);
          ok = true;
        } catch (e) {
          failed.push(name);
          if (this.lastOk.get(name) !== false) this.log('warn', `readiness_check_failed check=${name} ${describeFailure(e)} — /ready answers 503 until it recovers`);
          this.lastOk.set(name, false);
        } finally {
          if (timer) clearTimeout(timer);
          observed.push({ name, ok, durationMs: performance.now() - started });
        }
      }),
    );
    const result = { ok: failed.length === 0, failed: failed.sort() };
    this.notify({ ready: result.ok, draining: false, checks: observed });
    return result;
  }

  private notify(observation: ReadinessObservation): void {
    if (!this.observer) return;
    try {
      this.observer(observation);
    } catch {
      // An observer never changes readiness.
    }
  }
}
