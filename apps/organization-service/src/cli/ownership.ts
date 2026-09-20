#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DbService, JsonLogger } from '@nawara/service-kit';
import { ACTIVATE_CONFIRMATION, OwnershipAdmin, OwnershipError } from '../ownership/ownership-admin.js';

/**
 * Ownership operations (ADR-0040). The ONLY way authority moves. Connects with the OPERATIONS login, never the runtime role:
 *   OWNERSHIP_ADMIN_DATABASE_URL   (required)  the schema-owner / migrator connection string
 *   NODE_ENV                       recorded on every event; "production" adds the activation gate below
 *   OWNERSHIP_PRODUCTION_ACTIVATION=enabled     the deliberate, per-run gate for `activate` in production (after gates G1 to G7)
 *
 *   status
 *   declare-class --class existing|fresh --actor NAME
 *   verify-snapshot --file F --actor NAME          (offline: touches no database)
 *   import --file F --actor NAME                   (existing environments; compare-and-insert; never activates)
 *   verify --expect-digest D --actor NAME          (fresh environments: content digest of what this service holds)
 *   approve --reference REF --actor NAME           (records gate G7; makes ACTIVATABLE; never activates)
 *   activate --confirm ACTIVATE-AUTHORITY --actor NAME
 *   retire --evidence TEXT --actor NAME
 *   rollback --reason TEXT --actor NAME            (before activation only)
 * Never prints a secret. Exit code 0 on success, 1 on refusal or error.
 */
function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--') || argv[i + 1] === undefined) throw new Error(`unexpected argument: ${a}`);
    out[a.slice(2)] = argv[++i]!;
  }
  return out;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) throw new Error('usage: ownership status | declare-class | verify-snapshot | import | verify | approve | activate | retire | rollback');
  const f = flags(rest);
  const actor = f.actor ?? '';
  const needActor = (): string => {
    if (!actor.trim()) throw new Error('--actor NAME is required (who is doing this, recorded in the audit)');
    return actor;
  };
  const url = process.env.OWNERSHIP_ADMIN_DATABASE_URL;
  if (!url && cmd !== 'verify-snapshot') throw new Error('OWNERSHIP_ADMIN_DATABASE_URL is required (the operations login, never the runtime role)');

  const logger = new JsonLogger('organization-service', 'info');
  const correlationId = randomUUID();
  const environment = process.env.NODE_ENV ?? 'development';
  const db = new DbService({ url: url ?? 'postgres://unused', applicationName: 'organization-ownership-cli', max: 2 });
  const admin = new OwnershipAdmin(db, {
    environment,
    correlationId,
    log: (event, fields) => logger.info(event, { ...fields, correlationId, environment }),
    productionActivationEnabled: process.env.OWNERSHIP_PRODUCTION_ACTIVATION === 'enabled',
  });
  try {
    switch (cmd) {
      case 'status':
        console.log(JSON.stringify(await admin.status(), null, 2));
        break;
      case 'declare-class':
        if (f.class !== 'existing' && f.class !== 'fresh') throw new Error('--class existing|fresh is required');
        await admin.declareClass(needActor(), f.class);
        console.log(`environment class declared: ${f.class}`);
        break;
      case 'verify-snapshot': {
        const v = admin.verifySnapshotText(actor || 'offline', readFileSync(required(f, 'file'), 'utf8'));
        console.log(`snapshot verified: whole ${v.snapshot.digests.whole}; content ${v.content}; frozen ${v.snapshot.frozen}`);
        break;
      }
      case 'import': {
        const r = await admin.importSnapshot(needActor(), readFileSync(required(f, 'file'), 'utf8'));
        console.log(`imported; phase ${r.phase}; inserted ${JSON.stringify(r.inserted)}; skipped ${JSON.stringify(r.skipped)}`);
        break;
      }
      case 'verify': {
        const r = await admin.verifyContent(needActor(), required(f, 'expect-digest'));
        console.log(`verified; phase ${r.phase}; content ${r.contentDigest}`);
        break;
      }
      case 'approve':
        await admin.approve(needActor(), required(f, 'reference'));
        console.log('approval recorded; the environment is ACTIVATABLE (authority is NOT active)');
        break;
      case 'activate':
        await admin.activate(needActor(), f.confirm ?? '');
        console.log('authority ACTIVATED');
        break;
      case 'retire':
        await admin.retire(needActor(), required(f, 'evidence'));
        console.log('retirement recorded');
        break;
      case 'rollback':
        await admin.rollback(needActor(), required(f, 'reason'));
        console.log('rolled back to PREPARED');
        break;
      default:
        throw new Error(`unknown command: ${cmd} (activation confirmation is ${ACTIVATE_CONFIRMATION})`);
    }
  } catch (e) {
    console.error(e instanceof OwnershipError ? `refused (${e.code}): ${e.message}` : (e as Error).message);
    process.exitCode = 1;
  } finally {
    await db.onApplicationShutdown().catch(() => undefined);
  }
}

function required(f: Record<string, string>, name: string): string {
  const v = f[name];
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

await main();
