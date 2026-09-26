import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';

/**
 * Stage 19.5: process-local counters of the owner's member suspension / restoration, for monitoring (P-S5's application-side signal).
 * Closed labels only: the operation and the outcome. Never a member, owner, organization or Company id, never a reason (the immutable
 * evidence of each operation is in `auth_audit_event` and the central audit trail, not here).
 *
 *   changed        : the account state changed (and every session was revoked, on suspend)
 *   unchanged      : already in that state; nothing written
 *   step_up_denied : no valid factor step-up for this purpose and session
 *   target_refused : the collapsed 404 (not a member of this Company only)
 *   failed         : the transaction failed (database, outbox, local evidence, session revocation): nothing committed
 *
 * Guard refusals (401, and 403 for operators and members) happen before this capability and are not counted here.
 */
export const MEMBER_SECURITY_OPERATIONS = ['suspend', 'restore'] as const;
export const MEMBER_SECURITY_OUTCOMES = ['changed', 'unchanged', 'step_up_denied', 'target_refused', 'failed'] as const;
export type MemberSecurityOperation = (typeof MEMBER_SECURITY_OPERATIONS)[number];
export type MemberSecurityOutcome = (typeof MEMBER_SECURITY_OUTCOMES)[number];

@Injectable()
export class MemberSecurityCounters {
  private counts = new Map<string, number>();

  count(operation: MemberSecurityOperation, outcome: MemberSecurityOutcome): void {
    const k = `${operation}_${outcome}`;
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }

  drain(): Record<string, number> {
    const out = Object.fromEntries(MEMBER_SECURITY_OPERATIONS.flatMap((o) => MEMBER_SECURITY_OUTCOMES.map((r) => [`${o}_${r}`, this.counts.get(`${o}_${r}`) ?? 0])));
    this.counts.clear();
    return out;
  }
}

/** The `auth_member_security_snapshot` line: every 60 s and once at shutdown (the audit-service snapshot pattern). Not run by the CLI. */
@Injectable()
export class MemberSecurityReporter implements OnApplicationBootstrap, OnApplicationShutdown {
  static readonly INTERVAL_MS = 60_000;
  private readonly log = new Logger('MemberSecurity');
  private timer?: NodeJS.Timeout;

  constructor(@Inject(MemberSecurityCounters) private readonly counters: MemberSecurityCounters) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.snapshot(), MemberSecurityReporter.INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.snapshot();
  }

  snapshot(): void {
    this.log.log(`auth_member_security_snapshot ${Object.entries(this.counters.drain()).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
}
