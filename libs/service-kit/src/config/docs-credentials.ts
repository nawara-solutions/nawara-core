import type { EnvReader } from './config.js';

/** The OpenAPI documentation credentials (ADR-0056 §10). */
export interface DocsCredentials {
  /** `SWAGGER_USERNAME`, default `docs`. */
  username: string;
  /** `SWAGGER_PASSWORD` (or `SWAGGER_PASSWORD_FILE`), at least 16 characters. Undefined: the service does not mount its documentation. */
  password?: string;
}

/**
 * V2 A2.1 (OD-A2-3): the rule every service repeated. An unset (or whitespace-only) password means no documentation; a set one must be at
 * least 16 characters. The password is never echoed.
 */
export function readDocsCredentials(reader: EnvReader): DocsCredentials {
  return {
    username: reader.optional('SWAGGER_USERNAME', 'docs') as string,
    password: reader.get('SWAGGER_PASSWORD') === undefined ? undefined : reader.secret('SWAGGER_PASSWORD', 16),
  };
}
