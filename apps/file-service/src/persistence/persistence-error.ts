/**
 * A persistence outcome the API stages translate into a stable machine code (17.5 / 17.6). It carries the code only: never SQL, a
 * constraint name, a row value (PostgreSQL's `detail` holds the failing row: names and storage keys) or connection details.
 */
export type FilePersistenceCode =
  /** A live file already holds this owner's Idempotency-Key (17.5 replays it or answers `idempotency_key_reused`). */
  | 'idempotency_key_in_use'
  /** Two tickets drew the same digest (2^-256): the issuer draws a new token. */
  | 'ticket_digest_collision';

export class FilePersistenceError extends Error {
  constructor(readonly code: FilePersistenceCode) {
    super(code);
    this.name = 'FilePersistenceError';
  }
}
