import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

/**
 * Runs every flow that touches a credential, then proves none of them was logged, audited, published
 * on the bus (other than the deliberate operator-code delivery event) or stored in the database.
 */
describe('secrets are never logged, audited or stored in plaintext', () => {
  let t: TestCtx;
  const secrets: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestApp();
    const w = await t.world();

    // member: password + refresh token
    const jc = await t.joinCode(w.orgSchool1, { audience: 'student' });
    secrets.joinCode = jc.code;
    secrets.joinCodeNormalized = jc.normalized;
    const member = await t.http.post('/auth/register').send({ email: 'sec-member@a.test', password: 'member-secret-pass-77', joinCode: jc.code }).expect(201);
    secrets.memberPassword = 'member-secret-pass-77';
    secrets.memberRefresh = member.body.refreshToken;
    secrets.memberAccess = member.body.accessToken;
    await t.http.post('/auth/login').send({ email: 'sec-member@a.test', password: 'wrong-guess-secret-88' });
    secrets.wrongPassword = 'wrong-guess-secret-88';

    // owner: password, enrollment token, TOTP secret, challenge token, step-up, secret key, recovery
    const o = await t.owner(w.companyA, 'sec-owner@a.test', 'owner-secret-pass-99');
    secrets.ownerPassword = 'owner-secret-pass-99';
    const login = await t.http.post('/auth/login').send({ email: o.email, password: o.password });
    secrets.enrollmentToken = login.body.enrollmentToken;
    const begin = await t.http.post('/auth/admin/enroll/totp').send({ enrollmentToken: login.body.enrollmentToken });
    secrets.totpSecret = begin.body.secret;
    const conf = await t.http.post('/auth/admin/enroll/totp/confirm').send({ enrollmentToken: login.body.enrollmentToken, factorId: begin.body.factorId, code: t.nextCode(begin.body.secret) });
    secrets.ownerRefresh = conf.body.refreshToken;
    const c = await t.http.post('/auth/login').send({ email: o.email, password: o.password });
    secrets.challengeToken = c.body.challengeToken;
    const code = t.nextCode(begin.body.secret);
    secrets.totpCode = code;
    await t.http.post('/auth/admin/login/owner/verify').send({ challengeToken: c.body.challengeToken, method: 'totp', code });
    const tokens = await t.ownerLogin(o, begin.body.secret);
    const su = await t.stepUpToken(tokens, 'owner.secret_key.rotate', begin.body.secret);
    const key = await t.http.post('/auth/admin/secret-key/rotate').set(bearer(tokens)).set('X-Step-Up-Token', su);
    secrets.secretKey = key.body.secretKey;
    secrets.secretKeyNoDashes = key.body.secretKey.replace(/-/g, '');
    const rec = await t.http.post('/auth/admin/recovery/start').send({ email: o.email, password: o.password, secretKey: key.body.secretKey });
    secrets.recoveryToken = rec.body.recoveryToken;
    await t.http.post('/auth/admin/recovery/start').send({ email: o.email, password: o.password, secretKey: 'WRONG-KEY-VALUE' });

    // operator: working code + tokens
    const op = await t.operator(w.companyA, 'sec-op@a.test');
    const opCode = (await t.operatorCode(op.email))!;
    secrets.operatorCode = opCode;
    const opTokens = await t.http.post('/auth/admin/login/operator/verify-code').send({ email: op.email, code: opCode });
    secrets.operatorRefresh = opTokens.body.refreshToken;
    await t.http.post('/auth/admin/login/operator/verify-code').send({ email: op.email, code: '654321' });
  });
  afterAll(() => t.close());

  const rawSecrets = () => Object.entries(secrets).filter(([k]) => k !== 'totpCode' && k !== 'operatorCode' && k !== 'memberAccess');

  it('nothing is written to the application log', () => {
    const log = t.logger.lines.join('\n');
    for (const [name, value] of Object.entries(secrets)) expect(log, `log contains ${name}`).not.toContain(value);
  });

  it('nothing sensitive is in the audit trail, and it is populated', async () => {
    const audit = await t.db.query(`SELECT count(*)::int n, string_agg(row_to_json(a)::text, '\n') AS dump FROM auth_audit_event a`);
    expect(audit.rows[0].n).toBeGreaterThan(8);
    for (const [name, value] of Object.entries(secrets)) expect(audit.rows[0].dump, `audit contains ${name}`).not.toContain(value);
  });

  it('nothing sensitive is stored in plaintext in ANY security table', async () => {
    const tables = ['user', 'owner', 'owner_auth_factor', 'owner_auth_challenge', 'owner_step_up', 'owner_recovery_request', 'refresh_token', 'admin_operator_code', 'auth_throttle', 'admin_device'];
    let dump = '';
    for (const tb of tables) dump += (await t.db.query(`SELECT COALESCE(string_agg(row_to_json(x)::text, '\n'), '') AS d FROM "${tb}" x`)).rows[0].d;
    for (const [name, value] of rawSecrets()) expect(dump, `database contains ${name}`).not.toContain(value);
    // binary TOTP ciphertext must not contain the plaintext secret either
    const ct = (await t.db.query(`SELECT encode("secretCiphertext",'escape') AS c FROM owner_auth_factor WHERE type='totp'`)).rows.map((r) => r.c).join('');
    expect(ct).not.toContain(secrets.totpSecret);
    // operator code and TOTP code appear only as digests / not at all
    expect(dump).not.toContain(`"codeHash":"${secrets.operatorCode}"`);
  });

  it('rate-limit keys hold no raw identifiers or IPs', async () => {
    const keys = (await t.db.query(`SELECT key FROM auth_throttle`)).rows.map((r) => r.key);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it('events on the broker carry secrets only where delivery requires it: the operator code, nowhere else', () => {
    for (const { key, payload } of t.bus.events) {
      const text = JSON.stringify(payload);
      for (const [name, value] of rawSecrets()) expect(text, `${key} contains ${name}`).not.toContain(value);
      if (key !== 'admin.operator_code_issued' && key !== 'admin.operator_confirmation_code_issued') expect(payload).not.toHaveProperty('code');
    }
  });
});
