import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapOwner, resealTotpSecrets } from '../src/cli/owner-tools.js';
import { PasswordService } from '../src/crypto/password.js';
import { TotpSecretCipher } from '../src/crypto/totp-cipher.js';
import { DbService } from '../src/db/db.service.js';
import { UsersService } from '../src/users/users.service.js';
import { createTestApp, type TestCtx } from './helpers/app.js';

describe('operational tools', () => {
  let t: TestCtx;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());

  it('bootstrap creates ONE owner with no secret key and no factor; a second run changes nothing', async () => {
    const args = [t.app.get(DbService), t.app.get(UsersService), t.app.get(PasswordService)] as const;
    const first = await bootstrapOwner(...args, { companyName: 'Nawara', email: 'Root@Nawara.Test', password: 'bootstrap-pass-123' });
    expect(first.created).toBe(true);
    expect(await bootstrapOwner(...args, { companyName: 'Other', email: 'other@x.test', password: 'bootstrap-pass-123' })).toEqual({ created: false });
    const owners = await t.db.query(`SELECT count(*)::int n FROM owner`);
    const companies = await t.db.query(`SELECT count(*)::int n FROM company`);
    expect(owners.rows[0].n).toBe(1);
    expect(companies.rows[0].n).toBe(1);
    const o = await t.db.query(`SELECT "secretKeyHash" FROM owner`);
    expect(o.rows[0].secretKeyHash).toBeNull();
    // first sign-in is enrollment, never a session
    const login = await t.http.post('/auth/login').send({ email: 'root@nawara.test', password: 'bootstrap-pass-123' }).expect(200);
    expect(login.body.status).toBe('enrollment_required');
    await expect(bootstrapOwner(...args, { companyName: 'x', email: 'a@b.c', password: 'short' })).rejects.toThrow();
  });

  it('TOTP key rotation: reseal moves every secret to the new key and logins keep working', async () => {
    const o = await t.readyOwner(await t.newCompany(), 'rot@a.test');
    const oldKey = t.cfg.secrets.totpKeys.get('k1')!;
    const newKey = randomBytes(32);
    const ring = new TotpSecretCipher(new Map([['k1', oldKey], ['k2', newKey]]), 'k2');
    const r = await resealTotpSecrets(t.app.get(DbService), ring, 'k2');
    expect(r.resealed).toBeGreaterThan(0);
    expect(r.remaining).toBe(0);
    const row = await t.db.query(`SELECT "secretKeyId", "secretCiphertext", id FROM owner_auth_factor WHERE "ownerId"=$1`, [o.id]);
    expect(row.rows[0].secretKeyId).toBe('k2');
    // with the OLD key gone from the ring, the secret is still readable via the new key
    const onlyNew = new TotpSecretCipher(new Map([['k2', newKey]]), 'k2');
    expect(onlyNew.open(row.rows[0].secretCiphertext, 'k2', o.id, row.rows[0].id)).toBe(o.totpSecret);
    // idempotent
    expect((await resealTotpSecrets(t.app.get(DbService), ring, 'k2')).resealed).toBe(0);
  });
});
