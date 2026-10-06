import { ConfigError } from '../config/config.js';
import { MigrationError } from '../db/migrations.js';
import { describeFailure, failureFacts, type FailureKind } from './failure.js';
import { scrubText } from './safe-serialize.js';

/**
 * V2 A12.4.3: the one line an operator CLI prints when it fails. An error's own message is never printed (it can carry a connection
 * string, SQL, a row value or provider text): only its facts (`describeFailure`: class, code, kind) behind a fixed category phrase.
 *
 * The exceptions are Core-authored refusals whose text is a reviewed template that never echoes a value: `ConfigError` (it names the
 * variable, never its value) and `MigrationError` (its templates name migration files; the failed-migration one carries facts, not
 * PostgreSQL's message), plus any class a CLI passes as `safeMessage` (a domain refusal of its own). Their text is still scrubbed.
 *
 * The category phrases keep the restore drill's classification of a migration runner's failure (`infra/backup/restore-drill.sh`
 * matches `password authentication failed`, `the database system is`, `Connection terminated` and the network codes).
 */
const PHRASE: Partial<Record<FailureKind, string>> = {
  db_auth_failed: 'database: password authentication failed',
  db_unavailable: 'database: the database system is unavailable',
  db_connection_lost: 'database: Connection terminated',
  db_connect_timeout: 'database: Connection terminated (connection timeout)',
  db_statement_timeout: 'database: statement timeout',
  db_query_timeout: 'database: query timeout',
  network_unreachable: 'network: unreachable',
  broker_connection_lost: 'broker: connection lost',
  broker_confirm_timeout: 'broker: confirm timeout',
};

export function describeCliFailure(error: unknown, safeMessage: (e: unknown) => boolean = () => false): string {
  try {
    if (error instanceof ConfigError || error instanceof MigrationError || safeMessage(error)) return scrubText((error as Error).message);
    const kind = failureFacts(error).kind;
    const phrase = kind ? PHRASE[kind] : undefined;
    return `${phrase ?? 'failed'} (${describeFailure(error)})`;
  } catch {
    return 'failed (error=unknown)';
  }
}
