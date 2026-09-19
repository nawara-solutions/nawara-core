import { Injectable } from '@nestjs/common';

export type ReadinessCheck = () => Promise<void>;

export interface ReadinessResult {
  ok: boolean;
  /** Names of failing checks. Never their error text: /ready answers operators and load balancers, not clients. */
  failed: string[];
}

/** Dependencies (database, broker, ...) register a named check; `/ready` runs them all with a per-check timeout. */
@Injectable()
export class ReadinessRegistry {
  private readonly checks = new Map<string, ReadinessCheck>();

  constructor(private readonly timeoutMs = 2000) {}

  register(name: string, check: ReadinessCheck): void {
    this.checks.set(name, check);
  }

  async run(): Promise<ReadinessResult> {
    const failed: string[] = [];
    await Promise.all(
      [...this.checks].map(async ([name, check]) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            check(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('timeout')), this.timeoutMs);
            }),
          ]);
        } catch {
          failed.push(name);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
    return { ok: failed.length === 0, failed: failed.sort() };
  }
}
