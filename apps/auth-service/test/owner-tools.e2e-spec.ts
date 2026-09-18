import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapOwner, checkTotpKeys, resealTotpSecrets } from '../src/cli/owner-tools.js';
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

  it('retire-a-key preflight: reports factors a reduced key ring could no longer open, and is clean when the ring covers them', async () => {
    const r = await createTestApp(); // its own database: the shared one already holds resealed rows
    try {
      const o = await r.readyOwner(await r.newCompany(), 'pre@a.test');
      const covered = new TotpSecretCipher(new Map([['k1', r.cfg.secrets.totpKeys.get('k1')!]]), 'k1');
      const cleanRing = await checkTotpKeys(r.app.get(DbService), covered);
      expect(cleanRing.unreadable).toBe(0);
      expect(cleanRing.byKeyId.k1).toBeGreaterThan(0);
      // a ring that dropped k1 (the retirement mistake) is detected BEFORE anyone is locked out
      const dropped = new TotpSecretCipher(new Map([['k2', randomBytes(32)]]), 'k2');
      const report = await checkTotpKeys(r.app.get(DbService), dropped);
      expect(report.unreadable).toBe(report.total);
      expect(report.unreadable).toBeGreaterThan(0);
      expect(JSON.stringify(report)).not.toContain(o.totpSecret); // ids and counts only
    } finally {
      await r.close();
    }
  });

  it('newly enrolled factors are sealed under the ACTIVE key, and old factors keep opening under theirs', async () => {
    const k = () => randomBytes(32).toString('base64');
    const k1 = k(), k2 = k();
    const r = await createTestApp({ TOTP_ENCRYPTION_KEYS: `k1:${k1},k2:${k2}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k2' });
    try {
      const o = await r.readyOwner(await r.newCompany(), 'active@a.test');
      const row = await r.db.query(`SELECT "secretKeyId" FROM owner_auth_factor WHERE "ownerId"=$1`, [o.id]);
      expect(row.rows[0].secretKeyId).toBe('k2');
      // seal one factor under the OLD key (as if enrolled before the rotation): login must still work
      const cipher = new TotpSecretCipher(new Map([['k1', Buffer.from(k1, 'base64')], ['k2', Buffer.from(k2, 'base64')]]), 'k1');
      const f = await r.db.query(`SELECT id FROM owner_auth_factor WHERE "ownerId"=$1`, [o.id]);
      const sealed = cipher.seal(o.totpSecret, o.id, f.rows[0].id);
      await r.db.query(`UPDATE owner_auth_factor SET "secretCiphertext"=$2, "secretKeyId"='k1' WHERE id=$1`, [f.rows[0].id, sealed.ciphertext]);
      await r.ownerLogin(o, o.totpSecret);
    } finally {
      await r.close();
    }
  });
});
