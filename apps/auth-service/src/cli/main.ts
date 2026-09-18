import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PasswordService } from '../crypto/password.js';
import { TotpSecretCipher } from '../crypto/totp-cipher.js';
import { DbService } from '../db/db.service.js';
import { UsersService } from '../users/users.service.js';
import { bootstrapOwner, checkTotpKeys, resealTotpSecrets } from './owner-tools.js';

/**
 *   node dist/cli/main.js bootstrap-owner     env: BOOTSTRAP_COMPANY_NAME, BOOTSTRAP_OWNER_EMAIL, BOOTSTRAP_OWNER_PASSWORD
 *   node dist/cli/main.js reseal-totp-keys
 *   node dist/cli/main.js check-totp-keys      exit 1 if any TOTP factor is sealed under a key missing from the ring
 * Runs the same config/secret loading as the service (so it fails closed identically). Never prints
 * a secret. Exit code 0 on success/no-op, 1 on refusal or error.
 */
const cmd = process.argv[2];
process.env.AUTH_EVENTS = 'off';
const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
try {
  if (cmd === 'bootstrap-owner') {
    const { BOOTSTRAP_COMPANY_NAME: company, BOOTSTRAP_OWNER_EMAIL: email, BOOTSTRAP_OWNER_PASSWORD: password } = process.env;
    if (!company || !email || !password) throw new Error('BOOTSTRAP_COMPANY_NAME, BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD are required');
    const r = await bootstrapOwner(app.get(DbService), app.get(UsersService), app.get(PasswordService), { companyName: company, email, password });
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
  } else {
    throw new Error('usage: main.js bootstrap-owner | reseal-totp-keys | check-totp-keys');
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await app.close();
}
