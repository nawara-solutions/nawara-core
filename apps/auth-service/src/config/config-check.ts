import { describeCliFailure, type FileReader } from '@nawara/service-kit';
import { ConfigError, JWT_LEGACY_KEY_ID, loadConfig, type AppConfig } from './app-config.js';

export interface ConfigCheckResult {
  ok: boolean;
  exitCode: 0 | 1;
  /** The one line to print: never a value, a decoded key or a ring id. */
  line: string;
}

/** The JWT mode by kind and count only (ADR-0058): ring ids are public, but the check prints none, so its output never carries a value. */
function jwtMode(jwt: AppConfig['jwt']): string {
  if (jwt.ring.size === 0) return 'legacy only (JWT_SECRET signs and verifies)';
  if (jwt.activeKeyId === JWT_LEGACY_KEY_ID) return `ring (active: legacy, ring keys: ${jwt.ring.size}, verification only)`;
  return `ring (active: a ring key, ring keys: ${jwt.ring.size}, legacy key: ${jwt.legacyKey ? 'kept' : 'retired'})`;
}

/**
 * V2 A4.8 (A4 record §11): validates a complete Auth configuration with the service's own loader, exactly as the service would at start:
 * every setting and key rule, including the JWT key ring (A4.7). Reads only the environment and its `NAME_FILE` files; opens no
 * connection and generates or changes nothing. A refusal is the loader's `ConfigError` text, which names variables and rules only.
 */
export function checkConfig(env: NodeJS.ProcessEnv, readFile?: FileReader): ConfigCheckResult {
  try {
    const cfg = loadConfig(env, readFile);
    return { ok: true, exitCode: 0, line: `configuration valid; JWT: ${jwtMode(cfg.jwt)}` };
  } catch (e) {
    if (e instanceof ConfigError) return { ok: false, exitCode: 1, line: `configuration invalid: ${e.message}` };
    return { ok: false, exitCode: 1, line: `configuration check failed: ${describeCliFailure(e)}` }; // never the error's own message
  }
}
