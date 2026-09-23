/**
 * Stage 14.7: a failure described for an operational log line WITHOUT its message. Messages can carry hosts, SQL values or
 * provider text, so background jobs log only these facts, which are enough to tell the failing layer apart:
 *  - `error`: the error class (`pg` names every server error `error`; its class `DatabaseError` is what an operator needs);
 *  - `code`: a PostgreSQL SQLSTATE (`57014`) or a Node system code (`ECONNREFUSED`) when the error carries one;
 *  - `kind`: a stable classification for the failures Stage 14.4/14.6 bound, when recognised.
 */
export interface FailureFacts {
  error: string;
  code?: string;
  kind?: FailureKind;
}

export type FailureKind =
  | 'db_statement_timeout'
  | 'db_idle_in_transaction_timeout'
  | 'db_connect_timeout'
  | 'db_connection_lost'
  | 'db_unavailable'
  | 'db_auth_failed'
  | 'db_serialization_failure'
  | 'db_deadlock'
  | 'broker_confirm_timeout'
  | 'network_unreachable';

const TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
const token = (v: unknown): string | undefined => (typeof v === 'string' && TOKEN.test(v) ? v : undefined);

const BY_SQLSTATE: Record<string, FailureKind> = {
  '57014': 'db_statement_timeout', // query_canceled: statement_timeout
  '25P03': 'db_idle_in_transaction_timeout', // idle_in_transaction_session_timeout
  '57P01': 'db_connection_lost', // admin_shutdown (server restart, pg_terminate_backend)
  '57P02': 'db_connection_lost', // crash_shutdown
  '57P03': 'db_unavailable', // cannot_connect_now (starting up, recovery)
  '53300': 'db_unavailable', // too_many_connections
  '28P01': 'db_auth_failed',
  '28000': 'db_auth_failed',
  '40001': 'db_serialization_failure',
  '40P01': 'db_deadlock',
};

const BY_SYSTEM_CODE: Record<string, FailureKind> = {
  ECONNREFUSED: 'network_unreachable',
  ENOTFOUND: 'network_unreachable',
  EAI_AGAIN: 'network_unreachable',
  EHOSTUNREACH: 'network_unreachable',
  ENETUNREACH: 'network_unreachable',
  ETIMEDOUT: 'network_unreachable',
  ECONNRESET: 'network_unreachable',
};

// `pg` / `pg-pool` raise these without a code. The exact texts are pinned by `failure.spec.ts` against the installed `pg`.
const BY_PG_MESSAGE: Array<[string, FailureKind]> = [
  ['timeout exceeded when trying to connect', 'db_connect_timeout'], // pool acquisition or connection establishment past DB_CONNECTION_TIMEOUT_MS
  ['Connection terminated due to connection timeout', 'db_connect_timeout'],
  ['Client has encountered a connection error and is not queryable', 'db_connection_lost'],
  ['Connection terminated unexpectedly', 'db_connection_lost'],
];

export function failureFacts(e: unknown): FailureFacts {
  if (!(e instanceof Error)) return { error: 'unknown' }; // the workers' established classification for a non-Error throw
  const cls = token(e.constructor?.name) ?? token(e.name) ?? 'Error';
  const error = cls === 'Error' && token(e.name) && e.name !== 'error' ? e.name : cls;
  const code = token((e as { code?: unknown }).code);
  let kind: FailureKind | undefined;
  if (code) kind = BY_SQLSTATE[code] ?? BY_SYSTEM_CODE[code];
  else if (error === 'PublisherConfirmTimeoutError') kind = 'broker_confirm_timeout';
  else kind = BY_PG_MESSAGE.find(([m]) => e.message === m)?.[1];
  return { error, ...(code ? { code } : {}), ...(kind ? { kind } : {}) };
}

/** `error=<class> [code=<code>] [kind=<kind>]`, for the kit's `event_name key=value` operational log lines. */
export function describeFailure(e: unknown): string {
  const f = failureFacts(e);
  return `error=${f.error}${f.code ? ` code=${f.code}` : ''}${f.kind ? ` kind=${f.kind}` : ''}`;
}
