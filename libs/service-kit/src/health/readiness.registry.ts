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

  constructor(
    private readonly timeoutMs = 2000,
    private readonly log: ReadinessLog = nestLog(),
    /** Stage 15.5: true once shutdown has started. The instance is then not ready, whatever its dependencies say. */
    private readonly draining: () => boolean = () => false,
  ) {}

  register(name: string, check: ReadinessCheck): void {
    this.checks.set(name, check);
  }

  async run(): Promise<ReadinessResult> {
    if (this.draining()) return { ok: false, failed: ['shutting_down'] };
    const failed: string[] = [];
    await Promise.all(
      [...this.checks].map(async ([name, check]) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            check(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new ReadinessCheckTimeout(this.timeoutMs)), this.timeoutMs);
            }),
          ]);
          if (this.lastOk.get(name) === false) this.log('info', `readiness_check_recovered check=${name}`);
          this.lastOk.set(name, true);
        } catch (e) {
          failed.push(name);
          if (this.lastOk.get(name) !== false) this.log('warn', `readiness_check_failed check=${name} ${describeFailure(e)} — /ready answers 503 until it recovers`);
          this.lastOk.set(name, false);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
    return { ok: failed.length === 0, failed: failed.sort() };
  }
}
