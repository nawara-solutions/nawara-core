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
 * Typed access to environment configuration. A value may come from `NAME` or from a mounted secret file `NAME_FILE`
 * (the file wins), so secrets never have to live in the process environment. Errors name the variable, never the value.
 */
export class EnvReader {
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly readFile: FileReader = (p) => readFileSync(p, 'utf8'),
  ) {}

  get(name: string): string | undefined {
    const file = this.env[`${name}_FILE`];
    if (file) {
      let content: string;
      try {
        content = this.readFile(file).trim();
      } catch {
        throw new ConfigError(`${name}_FILE is set but the file cannot be read`);
      }
      return content === '' ? undefined : content;
    }
    const v = this.env[name];
    return v === undefined || v === '' ? undefined : v;
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
    const n = Number(raw);
    if (!Number.isInteger(n) || n < opts.min || n > opts.max) {
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
