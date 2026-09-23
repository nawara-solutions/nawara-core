import { fileURLToPath } from 'node:url';
import type { MigrationOptions } from '@nawara/service-kit';

/** Auth's schema of record. Resolves the same from `src/db` (tests) and `dist/db` (the image). */
export const AUTH_MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

/**
 * How Auth's migrations run through the service-kit runner (Stage 14.5). Auth's files predate the runner and each carries its own
 * `BEGIN; ... COMMIT;`: the runner executes the body inside ITS transaction together with the bookkeeping row. The history must be
 * explainable by this release's files (no unknown applied migration, nothing inserted into the past), and rows recorded before
 * checksums were kept get their checksum recorded once, then enforced.
 */
export const AUTH_MIGRATION_OPTIONS: MigrationOptions = { fileTransaction: 'strip', strictHistory: true, adoptLegacyChecksums: true };
