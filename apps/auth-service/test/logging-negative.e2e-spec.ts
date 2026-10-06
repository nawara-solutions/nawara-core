import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JsonLogger } from '@nawara/service-kit';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

const uniq = () => randomUUID().slice(0, 8);

/**
 * V2 A12.4.5: service-level negative control. The harness's own Nest logger is a plain capture (`ctx.logger`), so the service's
 * Nest-Logger lines are routed here through the production `JsonLogger`, as main.ts does: every operational line of a realistic run of
 * Auth's credential-bearing paths is captured and searched for each secret, code and Category-B value the run handled.
 */
describe('V2 A12.4.5: Auth credential paths never reach an operational log line', () => {
  let t: TestCtx;
  const nest: Record<string, unknown>[] = [];
  const raw: string[] = [];
  beforeAll(async () => {
    t = await createTestApp();
    t.app.useLogger(new JsonLogger('auth-service', 'debug', (l) => { raw.push(l); nest.push(JSON.parse(l)); }));
  });
  afterAll(async () => t?.close());

  it('owner, member, operator, recovery, WebAuthn, invitation and forged-credential flows: no secret, code or contact in any line', async () => {
    const seen: string[] = [];
    const w = await t.world();
    const companyId = await t.newCompany();

    // Owner: password, first TOTP enrolment (secret, code, enrollment token), login with challenge token + code, session tokens.
    const ownerEmail = `owner.${uniq()}@private.example`;
    const ownerPassword = `owner-pw-${uniq()}-${uniq()}`;
    const owner = await t.owner(companyId, ownerEmail, ownerPassword);
    const enrolled = await t.enrollFirstTotp(owner);
    const session = await t.ownerLogin(owner, enrolled.totpSecret);
    seen.push(ownerEmail, ownerPassword, enrolled.totpSecret, enrolled.tokens.accessToken, enrolled.tokens.refreshToken, session.accessToken, session.refreshToken);

    // WebAuthn: a registration challenge is issued to the owner (challenge material in the response only).
    const options = await t.http.post('/auth/admin/factors/webauthn/options').set(bearer(session));
    if (typeof options.body?.challenge === 'string') seen.push(options.body.challenge);

    // A wrong password and a wrong TOTP code; a refresh with a forged token; a forged bearer JWT and session cookie.
    const wrongPassword = `wrong-pw-${uniq()}`;
    await t.http.post('/auth/login').send({ email: ownerEmail, password: wrongPassword }).expect(401);
    const login = await t.http.post('/auth/login').send({ email: ownerEmail, password: ownerPassword }).expect(200);
    await t.http.post('/auth/admin/login/owner/verify').send({ challengeToken: login.body.challengeToken, method: 'totp', code: '000000' });
    seen.push(wrongPassword, login.body.challengeToken);
    const forgedRefresh = `refresh-${uniq()}${uniq()}${uniq()}`;
    await t.http.post('/auth/refresh').send({ refreshToken: forgedRefresh });
    const forgedJwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIke3VuaXEoKX0ifQ.${uniq()}${uniq()}`;
    const cookie = `session=${uniq()}${uniq()}`;
    await t.http.get('/auth/me').set('Authorization', `Bearer ${forgedJwt}`).set('Cookie', cookie);
    seen.push(forgedRefresh, forgedJwt, cookie);

    // Recovery with a wrong secret key (the owner's email and password in the same body).
    const wrongKey = `RKEY-${uniq().toUpperCase()}-${uniq().toUpperCase()}`;
    await t.http.post('/auth/admin/recovery/start').send({ email: ownerEmail, password: ownerPassword, secretKey: wrongKey });
    seen.push(wrongKey);

    // Operator: a one-time code issued and redeemed, then a wrong code.
    const operatorEmail = `operator.${uniq()}@private.example`;
    await t.operator(companyId, operatorEmail);
    const code = await t.operatorCode(operatorEmail);
    expect(code).toBeDefined();
    await t.http.post('/auth/admin/login/operator/verify-code').send({ email: operatorEmail, code }).expect(200);
    await t.http.post('/auth/admin/login/operator/verify-code').send({ email: operatorEmail, code: '999999' });
    seen.push(operatorEmail, code!);

    // Member onboarding with a real join code, then an unknown invitation code and an unknown join code.
    const join = await t.joinCode(w.orgSchool1, { audience: 'student', requiresApproval: false, requiresSubscription: false });
    const memberEmail = `member.${uniq()}@private.example`;
    const memberPassword = `member-pw-${uniq()}`;
    await t.http.post('/auth/register').send({ email: memberEmail, password: memberPassword, joinCode: join.code });
    const bogusInvitation = `INV-${uniq().toUpperCase()}`;
    const bogusJoin = `JOIN-${uniq().toUpperCase()}`;
    await t.http.post('/auth/onboarding/invitations/resolve').send({ invitationCode: bogusInvitation });
    await t.http.post('/auth/onboarding/resolve').send({ joinCode: bogusJoin });
    seen.push(join.code, join.normalized, memberEmail, memberPassword, bogusInvitation, bogusJoin);

    // Hostile request / correlation ids (quotes, backslash, a forged JSON fragment, a secret-looking pair, 300+ chars; HTTP itself refuses
    // CR/LF in a header): never echoed, the request still answers.
    const hostileSecret = `hostile-${uniq()}${uniq()}`;
    const hostile = `"\\ {"level":"error","msg":"forged"} password=${hostileSecret} ${'a'.repeat(300)}`;
    const r = await t.http.post('/auth/login').set('x-request-id', hostile).set('x-correlation-id', hostile).send({ email: memberEmail, password: memberPassword });
    expect(r.status).toBeLessThan(500);
    expect(r.headers['x-request-id']).not.toContain(hostileSecret);
    expect(r.headers['x-correlation-id']).toBe(r.headers['x-request-id']); // the Core fallback
    seen.push(hostileSecret);

    // A low-level pool error whose own message carries a connection string: the line exists, its text does not.
    const dsn = `postgres://auth_runtime:pool-pw-${uniq()}@db.internal:5432/auth`;
    (t.dbs as unknown as { pool: { emit: (event: string, err: unknown) => void } }).pool.emit('error', Object.assign(new Error(`connect failed for ${dsn}`), { code: '08006' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    seen.push(dsn, 'pool-pw-');

    const pool = nest.find((l) => String(l.msg).startsWith('db_pool_idle_client_error'));
    expect(pool).toMatchObject({ level: 'warn', service: 'auth-service' }); // the Nest-routed path is really captured
    expect(String(pool!.msg)).toMatch(/error=Error code=08006/);

    for (const line of raw) {
      expect(() => JSON.parse(line)).not.toThrow(); // one JSON object per line
      expect(line).not.toMatch(/[\r\n]/);
    }
    const everything = JSON.stringify([nest, t.jsonLogs, t.logger.lines]);
    for (const secret of seen) expect(everything, `leaked: ${secret.slice(0, 12)}…`).not.toContain(secret);
    expect(everything).not.toMatch(/private\.example|eyJhbGci|Bearer |session=/);
  });
});
