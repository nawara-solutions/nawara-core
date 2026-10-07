import { readFileSync } from 'node:fs';

/** Thrown at startup when configuration is missing or invalid. Messages NEVER contain a configuration value. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type FileReader = (path: string) => string;

/**
 * Typed access to environment configuration. A value may come from `NAME` or from a mounted secret file `NAME_FILE`, so secrets never
 * have to live in the process environment. Errors name the variable, never the value.
 *
 * V2 A2.1 (OD-A2-4, OD-A2.1-b): surrounding whitespace is removed from `NAME`, from the `NAME_FILE` path and from the file's content, and
 * a value that is empty after that counts as unset. Setting both `NAME` and `NAME_FILE` is refused (it is ambiguous which one is meant):
 * neither source is silently preferred.
 */
export class EnvReader {
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly readFile: FileReader = (p) => readFileSync(p, 'utf8'),
  ) {}

  get(name: string): string | undefined {
    const file = normalized(this.env[`${name}_FILE`]);
    const direct = normalized(this.env[name]);
    if (file !== undefined && direct !== undefined) throw new ConfigError(`set ${name} or ${name}_FILE, not both`);
    if (file === undefined) return direct;
    let content: string;
    try {
      content = this.readFile(file);
    } catch {
      throw new ConfigError(`${name}_FILE is set but the file cannot be read`);
    }
    return normalized(content);
  }

  required(name: string): string {
    const v = this.get(name);
    if (v === undefined) throw new ConfigError(`${name} is required`);
    return v;
  }

  optional(name: string, fallback?: string): string | undefined {
    return this.get(name) ?? fallback;
  }

  int(name: string, opts: { default: number; min: number; max: number }): number {
    const raw = this.get(name);
    if (raw === undefined) return opts.default;
    // OD-A2.1-a: an explicit signed decimal grammar; `Number()` alone would also accept 1e3, 0x10, 5.0 or Infinity.
    const n = DECIMAL_INTEGER.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < opts.min || n > opts.max) {
      throw new ConfigError(`${name} must be an integer between ${opts.min} and ${opts.max}`);
    }
    return n;
  }

  bool(name: string, dflt: boolean): boolean {
    const raw = this.get(name);
    if (raw === undefined) return dflt;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new ConfigError(`${name} must be "true" or "false"`);
  }

  oneOf<T extends string>(name: string, values: readonly T[], dflt: T): T {
    const raw = this.get(name);
    if (raw === undefined) return dflt;
    if (!(values as readonly string[]).includes(raw)) {
      throw new ConfigError(`${name} must be one of: ${values.join(', ')}`);
    }
    return raw as T;
  }

  /** A secret with a minimum length. Never echoed. */
  secret(name: string, minLength = 32): string {
    const v = this.required(name);
    if (v.length < minLength) throw new ConfigError(`${name} must be at least ${minLength} characters`);
    return v;
  }

  /** A URL restricted to the given protocols. The value (which may embed credentials) is never echoed. */
  url(name: string, protocols: readonly string[]): string {
    const v = this.required(name);
    let parsed: URL;
    try {
      parsed = new URL(v);
    } catch {
      throw new ConfigError(`${name} must be a valid URL`);
    }
    if (!protocols.includes(parsed.protocol)) {
      throw new ConfigError(`${name} must use one of: ${protocols.join(', ')}`);
    }
    return v;
  }
}

const DECIMAL_INTEGER = /^[+-]?[0-9]+$/;

/** Surrounding whitespace removed; empty (or whitespace only) means unset. */
function normalized(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v === undefined || v === '' ? undefined : v;
}
