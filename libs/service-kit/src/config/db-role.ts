import { ConfigError } from './config.js';

/**
 * Database users that must never run a service in production (ADR-0032: the runtime role is DML-only): the default superuser names, any
 * schema-owner role (`*_migrator`) and any bootstrap superuser of a service database (`*_admin`, what the deploy scripts create as the
 * database container's `POSTGRES_USER`). Role names are case-sensitive, as PostgreSQL compares them.
 */
const FORBIDDEN_RUNTIME_DB_USER = /^(postgres|root|.+_migrator|.+_admin)$/;

/**
 * V2 A2.1 (OD-A2-3): in production, refuses a `DATABASE_URL` whose user is a superuser or schema owner. `alsoForbidden` names a service's
 * own owner role when it has no suffix (Auth's `auth`). Outside production nothing is checked: local and test stacks may connect as their
 * administrator. Errors never echo the URL, which carries the password.
 */
export function assertRuntimeDatabaseRole(databaseUrl: string, opts: { isProduction: boolean; alsoForbidden?: readonly string[] }): void {
  if (!opts.isProduction) return;
  let user: string;
  try {
    user = decodeURIComponent(new URL(databaseUrl).username);
  } catch {
    throw new ConfigError('DATABASE_URL must be a valid URL with a percent-encoded user');
  }
  if (FORBIDDEN_RUNTIME_DB_USER.test(user) || (opts.alsoForbidden ?? []).includes(user)) {
    throw new ConfigError('DATABASE_URL must use the least-privilege runtime role in production, not a superuser or migrator role');
  }
}
