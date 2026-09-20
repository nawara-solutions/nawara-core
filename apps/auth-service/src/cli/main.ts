import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PasswordService } from '../crypto/password.js';
import { TotpSecretCipher } from '../crypto/totp-cipher.js';
import { DbService } from '../db/db.service.js';
import { UsersService } from '../users/users.service.js';
import { writeFileSync } from 'node:fs';
import { HierarchyAuthorityError, contentDigestNow, exportHierarchy, freeze, retireWrites, status as hierarchyStatus, unfreeze } from '../hierarchy/hierarchy-authority.js';
import { serializeSnapshot } from '../hierarchy/snapshot.js';
import { bootstrapOwner, checkTotpKeys, resealTotpSecrets } from './owner-tools.js';

/**
 *   node dist/cli/main.js bootstrap-owner     env: BOOTSTRAP_COMPANY_NAME, BOOTSTRAP_OWNER_EMAIL, BOOTSTRAP_OWNER_PASSWORD
 *   node dist/cli/main.js reseal-totp-keys
 *   node dist/cli/main.js check-totp-keys      exit 1 if any TOTP factor is sealed under a key missing from the ring
 *   node dist/cli/main.js hierarchy-status | hierarchy-verify
 *   node dist/cli/main.js hierarchy-freeze --actor NAME | hierarchy-unfreeze --actor NAME
 *   node dist/cli/main.js hierarchy-export --out FILE --actor NAME [--final]   (--final only under the freeze)
 *   node dist/cli/main.js hierarchy-retire --actor NAME --evidence TEXT [--fresh]   (the mirror; there is NO way back)
 *   (ADR-0040: the ownership transition; none of it runs by itself.)
 * Runs the same config/secret loading as the service (so it fails closed identically). Never prints
 * a secret. Exit code 0 on success/no-op, 1 on refusal or error.
 */
const cmd = process.argv[2];
process.env.AUTH_EVENTS = 'off';
const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
try {
  if (cmd === 'bootstrap-owner') {
    const { BOOTSTRAP_COMPANY_NAME: company, BOOTSTRAP_OWNER_EMAIL: email, BOOTSTRAP_OWNER_PASSWORD: password, BOOTSTRAP_COMPANY_ID: companyId } = process.env;
    if (!company || !email || !password) throw new Error('BOOTSTRAP_COMPANY_NAME, BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD are required');
    const r = await bootstrapOwner(app.get(DbService), app.get(UsersService), app.get(PasswordService), { companyName: company, email, password, companyId });
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
      if (!k.startsWith('--')) throw new Error(`unexpected argument: ${k}`);
      f[k.slice(2)] = k === '--final' || k === '--fresh' ? 'true' : (rest[++i] ?? '');
    }
    const db = app.get(DbService);
    const actor = f.actor ?? '';
    const needActor = () => { if (!actor.trim()) throw new Error('--actor NAME is required'); return actor; };
    try {
      if (cmd === 'hierarchy-status') console.log(JSON.stringify(await hierarchyStatus(db), null, 2));
      else if (cmd === 'hierarchy-verify') console.log(`content digest: ${await contentDigestNow(db)}`);
      else if (cmd === 'hierarchy-freeze') { await freeze(db, needActor()); console.log('hierarchy FROZEN'); }
      else if (cmd === 'hierarchy-unfreeze') { await unfreeze(db, needActor()); console.log('hierarchy unfrozen'); }
      else if (cmd === 'hierarchy-export') {
        if (!f.out) throw new Error('--out FILE is required');
        const s = await exportHierarchy(db, needActor(), { final: f.final === 'true' });
        writeFileSync(f.out, serializeSnapshot(s), { mode: 0o600 });
        console.log(`snapshot written: whole ${s.digests.whole}; frozen ${s.frozen}; counts ${JSON.stringify(s.counts)}`);
      } else if (cmd === 'hierarchy-retire') { await retireWrites(db, needActor(), f.evidence ?? '', { fresh: f.fresh === 'true' }); console.log('hierarchy writes RETIRED (organization-service is the authority)'); }
      else throw new Error(`unknown command: ${cmd}`);
    } catch (e) {
      if (e instanceof HierarchyAuthorityError) { console.error(`refused (${e.code}): ${e.message}`); process.exitCode = 1; } else throw e;
    }
  } else {
    throw new Error('usage: main.js bootstrap-owner | reseal-totp-keys | check-totp-keys | hierarchy-status|verify|freeze|unfreeze|export|retire');
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await app.close();
}
