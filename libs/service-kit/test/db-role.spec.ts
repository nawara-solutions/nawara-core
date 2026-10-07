import { describe, expect, it } from 'vitest';
import { ConfigError, assertRuntimeDatabaseRole } from '../src/index.js';

const PASSWORD = 'pw-never-echoed-1234';
const url = (user: string) => `postgres://${user}:${PASSWORD}@db.internal:5432/app`;
const prod = { isProduction: true };

const refused = (fn: () => unknown, message: RegExp) => {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toMatch(message);
  expect((error as Error).message).not.toContain(PASSWORD);
  expect((error as Error).message).not.toContain('db.internal');
};

describe('V2 A2.1: assertRuntimeDatabaseRole (ADR-0032, OD-A2-3)', () => {
  it.each(['postgres', 'root', 'audit_migrator', 'organization_admin', 'audit_admin', 'x_admin'])('production refuses %s', (user) => {
    refused(() => assertRuntimeDatabaseRole(url(user), prod), /^DATABASE_URL must use the least-privilege runtime role in production/);
  });

  it('production refuses an extra owner role named by the service, and a percent-encoded forbidden user', () => {
    refused(() => assertRuntimeDatabaseRole(url('auth'), { ...prod, alsoForbidden: ['auth'] }), /least-privilege runtime role/);
    refused(() => assertRuntimeDatabaseRole(url('%70ostgres'), prod), /least-privilege runtime role/);
    refused(() => assertRuntimeDatabaseRole(url('team%5Fadmin'), prod), /least-privilege runtime role/);
  });

  it.each(['billing_app', 'organization_app', 'audit_app', 'auth_app', 'auth', 'Postgres', 'admin', 'migrator', 'my_admin_app'])(
    'production accepts %s (runtime roles; names are case-sensitive; only the suffixes are forbidden)',
    (user) => expect(() => assertRuntimeDatabaseRole(url(user), prod)).not.toThrow(),
  );

  it('checks nothing outside production (local and test stacks may connect as their administrator)', () => {
    for (const user of ['postgres', 'x_admin', 'x_migrator']) expect(() => assertRuntimeDatabaseRole(url(user), { isProduction: false })).not.toThrow();
    expect(() => assertRuntimeDatabaseRole('not a url', { isProduction: false })).not.toThrow();
  });

  it('a malformed URL or user encoding fails closed as a ConfigError without echoing the URL', () => {
    refused(() => assertRuntimeDatabaseRole(`not a url ${PASSWORD}`, prod), /^DATABASE_URL must be a valid URL with a percent-encoded user$/);
    refused(() => assertRuntimeDatabaseRole(url('bad%E0%A4%A'), prod), /percent-encoded user/);
  });
});
