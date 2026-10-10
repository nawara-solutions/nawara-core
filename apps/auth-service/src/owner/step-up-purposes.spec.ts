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

describe('step-up purposes (A5.4-A1)', () => {
  it('the 19 earlier purposes keep exactly their methods', () => {
    const current = STEP_UP_METHODS as Record<string, readonly string[]>;
    for (const [purpose, methods] of Object.entries(BEFORE_A1)) expect([...(current[purpose] ?? [])], purpose).toEqual(methods);
  });

  it('A1 adds exactly one purpose, hierarchy.reference.repair, factor-only (never the secret key)', () => {
    expect(Object.keys(STEP_UP_METHODS).filter((p) => !(p in BEFORE_A1))).toEqual([PURPOSE]);
    expect([...STEP_UP_METHODS[PURPOSE]]).toEqual(['totp', 'webauthn']);
  });

  it('no application source outside the allow-list names the purpose: no route, consumer or producer exists for it', () => {
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
          && readFileSync(path, 'utf8').includes(PURPOSE)) hits.push(path);
      }
    };
    walk(apps);
    expect(hits).toEqual([]);
  });
});
