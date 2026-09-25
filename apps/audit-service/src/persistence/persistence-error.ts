/**
 * A refused audit record, as a bounded code only: the database's detail (which contains the offending row) never leaves this layer,
 * because a refused record may be exactly the one that carried something that must not be logged.
 */
export type AuditPersistenceCode = 'invalid_record';

export class AuditPersistenceError extends Error {
  constructor(readonly code: AuditPersistenceCode, readonly constraint?: string) {
    super(code);
    this.name = 'AuditPersistenceError';
  }
}
