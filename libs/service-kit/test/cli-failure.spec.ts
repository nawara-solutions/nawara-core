import { describe, expect, it } from 'vitest';
import { ConfigError, MigrationError, describeCliFailure } from '../src/index.js';

/**
 * V2 A12.4.3: an operator CLI's failure line never carries an error's own message, keeps Core-authored refusal text, and keeps the
 * restore drill's classification phrases (infra/backup/restore-drill.sh `migration_failure`).
 */
const SECRET = 's3cr3t-cli-marker';
const VALUE = 'person@example.test';
const pgError = (code: string, message: string) => Object.assign(new (class DatabaseError extends Error {})(message), { code });

describe('describeCliFailure', () => {
  it('never prints an arbitrary error message, a connection string, SQL or a value', () => {
    for (const e of [
      new Error(`connect postgres://svc:${SECRET}@db:5432/x failed`),
      pgError('22P02', `invalid input syntax for type uuid: "${VALUE}" in INSERT INTO "user" VALUES ('${SECRET}')`),
      pgError('23505', `duplicate key value violates unique constraint "user_email_key": (email)=(${VALUE})`),
      Object.assign(new Error(`token=${SECRET}`), { code: 'ERR_X' }),
      `a thrown string ${SECRET}`,
      { message: SECRET },
    ]) {
      const line = describeCliFailure(e);
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(VALUE);
      expect(line).not.toContain('INSERT');
    }
    expect(describeCliFailure(pgError('23505', VALUE))).toBe('failed (error=DatabaseError code=23505)');
  });

  it('keeps Core-authored ConfigError and MigrationError text (scrubbed), and a refusal class the CLI names', () => {
    expect(describeCliFailure(new ConfigError('MIGRATION_DATABASE_URL (or DATABASE_URL) is required'))).toBe('MIGRATION_DATABASE_URL (or DATABASE_URL) is required');
    expect(describeCliFailure(new MigrationError('0003_x.sql was modified after it was applied'))).toBe('0003_x.sql was modified after it was applied');
    expect(describeCliFailure(new ConfigError(`bad --database-url postgres://u:${SECRET}@h/db`))).not.toContain(SECRET);
    class Refusal extends Error {}
    expect(describeCliFailure(new Refusal('--actor NAME is required'), (e) => e instanceof Refusal)).toBe('--actor NAME is required');
    expect(describeCliFailure(new Error('--actor NAME is required'))).toBe('failed (error=Error)');
  });

  it('keeps the restore drill categories: login, unavailable, terminated and network failures (facts only)', () => {
    const cases: Array<[unknown, RegExp]> = [
      [pgError('28P01', `password authentication failed for user "auth" ${SECRET}`), /password authentication failed/],
      [pgError('57P03', 'the database system is starting up'), /the database system is/],
      [new Error('Connection terminated unexpectedly'), /Connection terminated/],
      [Object.assign(new Error(`connect ECONNREFUSED 10.0.0.1:5432 ${SECRET}`), { code: 'ECONNREFUSED' }), /ECONNREFUSED/],
      [Object.assign(new Error('getaddrinfo ENOTFOUND db'), { code: 'ENOTFOUND' }), /ENOTFOUND/],
      [Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }), /ETIMEDOUT/],
    ];
    for (const [e, drillPattern] of cases) {
      const line = describeCliFailure(e);
      expect(line, line).toMatch(drillPattern);
      expect(line).not.toContain(SECRET);
    }
  });

  it('a failed migration names its file and the database facts, never PostgreSQL text', () => {
    // migrations.ts builds the message with describeFailure; the drill's `<file> failed and was rolled back: ` template still matches.
    const line = describeCliFailure(new MigrationError('0009_later.sql failed and was rolled back: error=DatabaseError code=23505'));
    expect(line).toMatch(/^0009_later\.sql failed and was rolled back: /);
  });
});
