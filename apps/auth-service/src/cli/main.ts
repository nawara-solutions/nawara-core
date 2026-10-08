import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { APP_CONFIG, ConfigError, loadConfig, type AppConfig } from '../config/app-config.js';
import { EnvReader, describeCliFailure } from '@nawara/service-kit';
import { PasswordService } from '../crypto/password.js';
import { TotpSecretCipher } from '../crypto/totp-cipher.js';
import { DbService } from '../db/db.service.js';
import { UsersService } from '../users/users.service.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { HierarchyAuthorityError, contentDigestNow, exportHierarchy, freeze, retireWrites, status as hierarchyStatus, unfreeze } from '../hierarchy/hierarchy-authority.js';
import { serializeSnapshot } from '../hierarchy/snapshot.js';
import { bootstrapOwner, checkTotpKeys, resealTotpSecrets } from './owner-tools.js';
import { HierarchyReference } from '../hierarchy/hierarchy-reference.js';
import { CliRefusal } from './refusal.js';

/**
 *   node dist/cli/main.js bootstrap-owner     env: BOOTSTRAP_COMPANY_NAME, BOOTSTRAP_OWNER_EMAIL, BOOTSTRAP_OWNER_PASSWORD [BOOTSTRAP_COMPANY_ID]
 *   node dist/cli/main.js reseal-totp-keys
 *   node dist/cli/main.js check-totp-keys      exit 1 if any TOTP factor is sealed under a key missing from the ring
 *   node dist/cli/main.js hierarchy-status | hierarchy-verify
 *   node dist/cli/main.js hierarchy-freeze --actor NAME | hierarchy-unfreeze --actor NAME
 *   node dist/cli/main.js hierarchy-export --out FILE --actor NAME [--final]   (--final only under the freeze)
 *   node dist/cli/main.js hierarchy-retire --actor NAME --evidence TEXT [--fresh]   (the mirror; there is NO way back)
 *   (ADR-0040: the ownership transition; none of it runs by itself.)
 * Runs the same config/secret loading as the service (so it fails closed identically). Never prints
 * a secret. Exit code 0 on success, 1 on a refusal or an error, and 1 when a command reports that it changed nothing although asked to
 * (bootstrap-owner when an owner already exists) or found a problem (check-totp-keys with an unreadable factor).
 *
 * V2 A4.3 (A4 record §7): `BOOTSTRAP_COMPANY_NAME`, `BOOTSTRAP_OWNER_EMAIL` and `BOOTSTRAP_COMPANY_ID` are read through the kit's `EnvReader`
 * (`NAME` or `NAME_FILE`, never both; trimmed; blank is unset). The owner password is read by `bootstrapPassword` below, byte for byte.
 * A configuration error is one value-free line and exit 1, like any other refusal.
 */

/**
 * V2 A4.3 (OD-A4.3-1): the bootstrap owner password, exactly as supplied. `EnvReader` trims every value, and a password's surrounding
 * whitespace is part of it, so this one variable keeps its own reader with the kit's other rules: `BOOTSTRAP_OWNER_PASSWORD` (taken
 * verbatim) or `BOOTSTRAP_OWNER_PASSWORD_FILE` (its content, minus the one line terminator a secret file ends with), never both; an
 * unreadable file names the variable only. The password policy is checked by `bootstrapOwner`, unchanged. Nothing here prints a value.
 */
function bootstrapPassword(env: NodeJS.ProcessEnv): string | undefined {
  const direct = env.BOOTSTRAP_OWNER_PASSWORD;
  const path = env.BOOTSTRAP_OWNER_PASSWORD_FILE?.trim();
  const hasDirect = direct !== undefined && direct !== '';
  const hasFile = path !== undefined && path !== '';
  if (hasDirect && hasFile) throw new ConfigError('set BOOTSTRAP_OWNER_PASSWORD or BOOTSTRAP_OWNER_PASSWORD_FILE, not both');
  if (!hasFile) return hasDirect ? direct : undefined;
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError('BOOTSTRAP_OWNER_PASSWORD_FILE is set but the file cannot be read');
  }
  const password = content.replace(/\r?\n$/, '');
  return password === '' ? undefined : password;
}

const cmd = process.argv[2];
// A CLI never writes domain events: AUTH_EVENTS is forced off in the copy handed to the loader (V2 A4.3: the caller's environment is
// not changed, and an AUTH_EVENTS_FILE cannot override it). Stage 18.7.6: no audit relay in a CLI process (the service's relay
// publishes the outbox); the CLI never connects to the broker.
const cliEnv: NodeJS.ProcessEnv = { ...process.env, AUTH_EVENTS: 'off', AUTH_EVENTS_FILE: undefined };
let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
try {
  app = await NestFactory.createApplicationContext(AppModule.register(loadConfig(cliEnv), undefined, { auditRelay: false }), { logger: ['error'] });
  if (cmd === 'bootstrap-owner') {
    const reader = new EnvReader(process.env);
    const company = reader.get('BOOTSTRAP_COMPANY_NAME');
    const email = reader.get('BOOTSTRAP_OWNER_EMAIL');
    const companyId = reader.get('BOOTSTRAP_COMPANY_ID');
    const password = bootstrapPassword(process.env);
    if (!company || !email || !password) throw new CliRefusal('BOOTSTRAP_COMPANY_NAME, BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD are required');
    // Stage 21.C.2: with an authoritative Company id, the reference-cache protocol places it (never an Auth Company insert).
    const r = await bootstrapOwner(app.get(DbService), app.get(UsersService), app.get(PasswordService), { companyName: company, email, password, companyId }, app.get(HierarchyReference));
    console.log(r.created ? 'owner created' : 'an owner already exists: nothing changed');
    process.exitCode = r.created ? 0 : 1;
  } else if (cmd === 'reseal-totp-keys') {
    const cfg = app.get<AppConfig>(APP_CONFIG);
    const r = await resealTotpSecrets(app.get(DbService), app.get(TotpSecretCipher), cfg.secrets.totpActiveKeyId);
    console.log(`resealed ${r.resealed}; still under an old key: ${r.remaining}`);
  } else if (cmd === 'check-totp-keys') {
    const r = await checkTotpKeys(app.get(DbService), app.get(TotpSecretCipher));
    console.log(`totp factors: ${r.total}; unreadable with the current key ring: ${r.unreadable}; by key id: ${JSON.stringify(r.byKeyId)}`);
    process.exitCode = r.unreadable === 0 ? 0 : 1;
  } else if (cmd?.startsWith('hierarchy-')) {
    const f: Record<string, string> = {};
    const rest = process.argv.slice(3);
    for (let i = 0; i < rest.length; i++) {
      const k = rest[i]!;
      if (!k.startsWith('--')) throw new CliRefusal(`unexpected argument: ${k}`);
      f[k.slice(2)] = k === '--final' || k === '--fresh' ? 'true' : (rest[++i] ?? '');
    }
    const db = app.get(DbService);
    const actor = f.actor ?? '';
    const needActor = () => { if (!actor.trim()) throw new CliRefusal('--actor NAME is required'); return actor; };
    try {
      if (cmd === 'hierarchy-status') console.log(JSON.stringify(await hierarchyStatus(db), null, 2));
      else if (cmd === 'hierarchy-verify') console.log(`content digest: ${await contentDigestNow(db)}`);
      else if (cmd === 'hierarchy-freeze') { await freeze(db, needActor()); console.log('hierarchy FROZEN'); }
      else if (cmd === 'hierarchy-unfreeze') { await unfreeze(db, needActor()); console.log('hierarchy unfrozen'); }
      else if (cmd === 'hierarchy-export') {
        if (!f.out) throw new CliRefusal('--out FILE is required');
        const s = await exportHierarchy(db, needActor(), { final: f.final === 'true' });
        writeFileSync(f.out, serializeSnapshot(s), { mode: 0o600 });
        console.log(`snapshot written: whole ${s.digests.whole}; frozen ${s.frozen}; counts ${JSON.stringify(s.counts)}`);
      } else if (cmd === 'hierarchy-retire') { await retireWrites(db, needActor(), f.evidence ?? '', { fresh: f.fresh === 'true' }); console.log('hierarchy writes RETIRED (organization-service is the authority)'); }
      else throw new CliRefusal(`unknown command: ${cmd}`);
    } catch (e) {
      if (e instanceof HierarchyAuthorityError) { console.error(`refused (${e.code}): ${e.message}`); process.exitCode = 1; } else throw e;
    }
  } else {
    throw new CliRefusal('usage: main.js bootstrap-owner | reseal-totp-keys | check-totp-keys | hierarchy-status|verify|freeze|unfreeze|export|retire');
  }
} catch (e) {
  // V2 A12.4.3: a Core-authored refusal or configuration error is printed as written; anything else as its facts, never its message.
  console.error(describeCliFailure(e, (x) => x instanceof CliRefusal || x instanceof ConfigError));
  process.exitCode = 1;
} finally {
  await app?.close();
}
