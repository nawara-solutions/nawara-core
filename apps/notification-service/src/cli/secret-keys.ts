#!/usr/bin/env node
import { DbService } from '@nawara/service-kit';
import { retirementVerdict, secretKeyUsage } from '../delivery/secret-keys.js';

/**
 * `npm run secret-keys -- usage` | `npm run secret-keys -- retire-check <keyId>` (operator tool, Stage 16.9). Connects with
 * DATABASE_URL (the runtime role is enough: it only reads key ids and counts) and prints JSON. Never prints a ciphertext, a key or the
 * connection string.
 *   usage              per key id: live ciphertexts, their latest expiresAt, whether one has no expiry.
 *   retire-check <id>  exit 0 only if <id> is not NOTIFICATION_SECRET_ACTIVE_KEY_ID (when set) and no live ciphertext references it;
 *                      exit 3 otherwise (the key must stay in NOTIFICATION_SECRET_KEYS).
 */
const [command, keyId] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url || !['usage', 'retire-check'].includes(command ?? '') || (command === 'retire-check' && !/^[A-Za-z0-9_-]{1,32}$/.test(keyId ?? ''))) {
  process.stderr.write('usage: DATABASE_URL=… secret-keys usage | secret-keys retire-check <keyId>\n');
  process.exit(2);
}
const db = new DbService({ url, max: 1, applicationName: 'notification-secret-keys' });
try {
  if (command === 'usage') {
    process.stdout.write(`${JSON.stringify(await secretKeyUsage(db), null, 2)}\n`);
  } else {
    const verdict = await retirementVerdict(db, keyId!, process.env.NOTIFICATION_SECRET_ACTIVE_KEY_ID);
    process.stdout.write(`${JSON.stringify({ keyId, ...verdict })}\n`);
    process.exitCode = verdict.safe ? 0 : 3;
  }
} catch {
  process.stderr.write('secret-keys: the database query failed (check DATABASE_URL and the migrations)\n');
  process.exitCode = 1;
} finally {
  await db.onApplicationShutdown();
}
