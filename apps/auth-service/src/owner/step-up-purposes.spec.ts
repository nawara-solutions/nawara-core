import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEP_UP_METHODS } from './step-up.service.js';

/**
 * A5.4-A1 (ADR-0061 §3, §4): the `hierarchy.reference.repair` step-up purpose is declared, factor-only, and nothing else changes.
 * The 19 purposes and methods below are the allow-list as it was on main before A1.
 */
const BEFORE_A1 = {
  'platform_assignment.grant': ['totp', 'webauthn', 'secret_key'],
  'platform_assignment.revoke': ['totp', 'webauthn', 'secret_key'],
  'platform.create': ['totp', 'webauthn', 'secret_key'],
  'organization.create': ['totp', 'webauthn', 'secret_key'],
  'operator.create': ['totp', 'webauthn', 'secret_key'],
  'owner.secret_key.rotate': ['totp', 'webauthn'],
  'owner.factor.enroll': ['totp', 'webauthn'],
  'owner.factor.remove': ['totp', 'webauthn'],
  'owner.password.change': ['totp', 'webauthn'],
  'join_code.create': ['totp', 'webauthn', 'secret_key'],
  'join_code.revoke': ['totp', 'webauthn', 'secret_key'],
  'organization.admin.grant': ['totp', 'webauthn'],
  'organization.admin.revoke': ['totp', 'webauthn'],
  'admin_invitation.create': ['totp', 'webauthn'],
  'admin_invitation.revoke': ['totp', 'webauthn'],
  'account.suspend': ['totp', 'webauthn'],
  'account.restore': ['totp', 'webauthn'],
  'release.withdraw': ['totp', 'webauthn'],
  'compatibility_policy.change': ['totp', 'webauthn'],
};
const PURPOSE = 'hierarchy.reference.repair';
/** S2-Auth.1: the refund authorization purpose; only the receipt issuance consumes it, through the exported constant. */
const REFUND = 'refund.authorize';
/** S2-Audit.4: verified and consumed by audit-service through POST /auth/step-up/verify (not Auth-local). */
const LEGAL_HOLD = ['audit.legal_hold.place', 'audit.legal_hold.release'] as const;

describe('step-up purposes (A5.4-A1)', () => {
  it('the 19 earlier purposes keep exactly their methods', () => {
    const current = STEP_UP_METHODS as Record<string, readonly string[]>;
    for (const [purpose, methods] of Object.entries(BEFORE_A1)) expect([...(current[purpose] ?? [])], purpose).toEqual(methods);
  });

  it('A1 adds exactly one purpose, hierarchy.reference.repair, factor-only (never the secret key); S2-Auth.1 then adds refund.authorize', () => {
    expect(Object.keys(STEP_UP_METHODS).filter((p) => !(p in BEFORE_A1))).toEqual([PURPOSE, REFUND, ...LEGAL_HOLD]);
    expect([...STEP_UP_METHODS[PURPOSE]]).toEqual(['totp', 'webauthn']);
  });

  it('S2-Auth.1 (ADR-0067 decision 1): refund.authorize is factor-only, never the secret key', () => {
    expect([...STEP_UP_METHODS[REFUND]]).toEqual(['totp', 'webauthn']);
  });

  it('S2-Audit.4 (Owner decision H3): the two legal-hold purposes are factor-only, never the secret key', () => {
    for (const p of LEGAL_HOLD) expect([...STEP_UP_METHODS[p]], p).toEqual(['totp', 'webauthn']);
  });

  it('no application source outside the allow-list names either purpose literally (each has one Auth-local consumer)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const apps = resolve(here, '../../..');
    const allowList = join(here, 'step-up.service.ts');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name === 'test' || name.startsWith('.')) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) && !/\.spec\.ts$/.test(name) && path !== allowList
          && /hierarchy\.reference\.repair|refund\.authorize/.test(readFileSync(path, 'utf8'))) hits.push(path);
      }
    };
    walk(apps);
    expect(hits).toEqual([]);
  });
});
