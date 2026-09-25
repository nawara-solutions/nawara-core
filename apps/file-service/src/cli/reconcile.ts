import { DbService, OutboxService } from '@nawara/service-kit';
import { FileAudit } from '../audit/file-audit.js';
import { loadFileConfig } from '../config/file-config.js';
import { createStorage } from '../storage/storage.module.js';
import { reconcile } from './reconcile-core.js';

/**
 * `npm run reconcile -- [--repair] [--limit N] [--after <fileId>]` (Stage 17.7, SDD §12): the operator reconciliation tool, run with the
 * service's own configuration (runtime database role, configured store). Prints one JSON line per finding and a final summary; exit 0.
 * Stage 18.7.4: each integrity incident also writes its central audit intent into the service's outbox (its own transaction); the
 * running service's relay publishes it. The CLI never talks to the broker.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const limit = Number(value('--limit') ?? 1000);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) throw new Error('--limit must be an integer between 1 and 1000000');
  const after = value('--after');
  if (after !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(after)) throw new Error('--after must be a file id');
  const config = loadFileConfig();
  const storage = createStorage(config.storage, () => undefined);
  const db = new DbService({ url: config.databaseUrl, applicationName: 'file-service-reconcile', max: 1, statementTimeoutMs: config.db.statementTimeoutMs });
  try {
    const audit = new FileAudit(new OutboxService());
    const onIncident = (file: { id: string; organizationId: string | null }, reason: 'object_missing' | 'size_mismatch') =>
      db.tx((q) => audit.integrityIncident(q, file, 'file_reconciliation', reason));
    const summary = await reconcile(db, storage.port, { repair: args.includes('--repair'), limit, after, onIncident }, (line) => process.stdout.write(`${JSON.stringify(line)}\n`));
    process.stdout.write(`${JSON.stringify({ summary })}\n`);
  } finally {
    await db.onApplicationShutdown();
    storage.close();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`reconcile failed: ${e instanceof Error ? e.name : 'error'}\n`); // never a connection string or key
  process.exit(1);
});
