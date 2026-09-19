import { fileURLToPath } from 'node:url';

/** Directory of the kit's own migrations (outbox and inbox). Resolves from both `src/db` and `dist/db`. */
export const kitMigrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));
