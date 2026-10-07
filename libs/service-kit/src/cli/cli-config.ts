import { ConfigError, type EnvReader } from '../config/config.js';

/**
 * V2 A15.1: how the kit's operator CLIs resolve their connection settings, through the same `EnvReader` the services use (surrounding
 * whitespace removed, whitespace-only = unset, `NAME` or `NAME_FILE`, both together refused, value-free errors). Internal to the CLIs:
 * not part of the kit's public API.
 */

/**
 * The migrator's connection: `MIGRATION_DATABASE_URL` (the schema-owner role), falling back to `DATABASE_URL` (OD-A15-7). The fallback
 * is LAZY (OD-A15.1-2): when the first setting resolves, the second is not read at all, so only the setting actually used can be
 * refused as ambiguous.
 */
export function migrationDatabaseUrl(reader: EnvReader): string {
  const url = reader.get('MIGRATION_DATABASE_URL') ?? reader.get('DATABASE_URL');
  if (url === undefined) throw new ConfigError('MIGRATION_DATABASE_URL (or DATABASE_URL) is required');
  return url;
}

/** The broker of the dead-letter tools: `RABBITMQ_URL` (or `RABBITMQ_URL_FILE`), never an argument. */
export function brokerUrl(reader: EnvReader): string {
  return reader.required('RABBITMQ_URL');
}

/** Printed once, on stderr, when `--database-url` is used (OD-A15.1-1). Fixed text: it never carries the URL. */
export const DATABASE_URL_FLAG_DEPRECATION =
  '--database-url is deprecated: pass DATABASE_URL or DATABASE_URL_FILE (a credential on the command line is visible to other processes)';

/**
 * The database of the outbox-lag check: `DATABASE_URL` (or `DATABASE_URL_FILE`). The deprecated `--database-url` value still wins when
 * given (OD-A15-1), and then the environment is not read at all, so an existing command keeps working whatever the environment holds.
 */
export function outboxDatabaseUrl(reader: EnvReader, flag: string | undefined): string {
  if (flag !== undefined) return flag;
  const url = reader.get('DATABASE_URL');
  if (url === undefined) throw new ConfigError('DATABASE_URL (or DATABASE_URL_FILE) is required');
  return url;
}
