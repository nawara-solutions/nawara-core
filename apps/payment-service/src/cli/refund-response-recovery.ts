import { fileURLToPath } from 'node:url';
import { ConfigError, DbService, EnvReader } from '@nawara/service-kit';
import { RefundResponseRecovery } from '../refunds/refund-dispatch-decision.js';

/**
 * `npm run refund-recovery -w payment-service [-- --once]` (Core V2 D-R1E; the A1 correction of D-R1D): the recovery of stored refund dispatch answers no
 * decision applied, as a SEPARATE process under the SEPARATE recovery role. DEVELOPMENT AND SIMULATION ONLY (refused when NODE_ENV=production).
 *   * It connects ONLY through `REFUND_RECOVERY_DATABASE_URL` (the `payment_refund_recovery` role; never the service's `DATABASE_URL`), and to nothing
 *     else: no provider, no broker, no Auth. It never calls a provider and never records a send or an answer.
 *   * Before every pass it asks the database what the role can do and REFUSES to run as a role that can record refund failure finality, a send or
 *     an answer, is a superuser, or is a member of another role. The database refuses such a role finality in any case (0040).
 *   * `PAYMENT_REFUND_RESPONSE_RECOVERY_AFTER_MS` (default 30 s; 1 s to 1 h; the Owner's Q2): only answers stored longer ago are applied. A technical
 *     window: it establishes no provider finality and authorizes no dispatch.
 * Exit codes (Core V2 D-R1E F5; every message is fixed text: never a connection string, credential, role or database name):
 *   0  `--once` completed (whatever it applied)
 *   2  configuration refused (missing or malformed variable, production, an out-of-range window, an unknown argument)
 *   3  the recovery database cannot be reached or refuses the credentials
 *   4  authority refused: the connected role is not a proper, registered recovery role
 *   1  any other failure (its error name only)
 * Prints one JSON line per pass (counts only).
 */
class UsageError extends Error {}
class ConnectionError extends Error {}
class AuthorityError extends Error {}

/** Connection and authentication failures by their stable codes (PostgreSQL SQLSTATE class 08 and 28, and socket errors). */
const isConnectionFailure = (e: unknown): boolean => {
  const raw = (e as { code?: unknown })?.code;
  const code = typeof raw === 'string' ? raw : '';
  return /^(08|28)/.test(code) || ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(code);
};

export function parseRecoveryArgs(args: readonly string[]): { once: boolean } {
  if (args.length === 0) return { once: false };
  if (args.length === 1 && args[0] === '--once') return { once: true };
  throw new UsageError('only --once is accepted'); // fixed text: the argument itself is never echoed
}

const PASS_INTERVAL_MS = 5_000;

async function main(): Promise<void> {
  const { once } = parseRecoveryArgs(process.argv.slice(2));
  const env = new EnvReader(process.env);
  if (env.get('NODE_ENV') === 'production') throw new UsageError('refund recovery is development and simulation only (NODE_ENV=production)');
  const url = env.get('REFUND_RECOVERY_DATABASE_URL');
  if (!url || !/^postgres(ql)?:\/\//.test(url)) throw new UsageError('REFUND_RECOVERY_DATABASE_URL (the separate recovery role) is required');
  const afterMs = env.int('PAYMENT_REFUND_RESPONSE_RECOVERY_AFTER_MS', { default: 30_000, min: 1_000, max: 3_600_000 });
  const db = new DbService({ url, applicationName: 'payment-service-refund-recovery', max: 2 });
  const recovery = new RefundResponseRecovery(db, afterMs);
  let stopping = false;
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  try {
    try {
      await recovery.assertAuthority();
    } catch (e) {
      if (isConnectionFailure(e)) throw new ConnectionError('the recovery database cannot be reached or refused the credentials');
      if (e instanceof Error && e.message.startsWith('refund_recovery_refused: ')) throw new AuthorityError(e.message); // our own fixed text
      throw e;
    }
    do {
      const applied = await recovery.recoverOnce();
      process.stdout.write(`${JSON.stringify({ pass: 'refund_response_recovery', applied })}\n`);
      if (once || stopping) break;
      await new Promise((r) => setTimeout(r, PASS_INTERVAL_MS));
    } while (!stopping);
  } finally {
    await db.onApplicationShutdown();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: unknown) => {
    // Fixed text of ours (a ConfigError names the variable, never its value) or an error name: never a connection string, role or value.
    const known = e instanceof UsageError || e instanceof ConfigError || e instanceof ConnectionError || e instanceof AuthorityError;
    const failure = isConnectionFailure(e) ? new ConnectionError('the recovery database cannot be reached or refused the credentials')
      : e instanceof Error && !(e instanceof AuthorityError) && e.message.startsWith('refund_recovery_refused: ') ? new AuthorityError(e.message) : e; // a later pass's refusal
    const code = failure instanceof UsageError || failure instanceof ConfigError ? 2 : failure instanceof ConnectionError ? 3 : failure instanceof AuthorityError ? 4 : 1;
    const fixedText = known || failure instanceof ConnectionError || failure instanceof AuthorityError;
    process.stderr.write(`refund recovery failed: ${fixedText ? (failure as Error).message : failure instanceof Error ? failure.name : 'error'}\n`);
    process.exit(code);
  });
}
