import { describe, expect, it } from 'vitest';
import { ConfigError, EnvReader, readDocsCredentials } from '../src/index.js';

const reader = (env: Record<string, string | undefined>, files: Record<string, string> = {}) =>
  new EnvReader(env as NodeJS.ProcessEnv, (p) => {
    if (!(p in files)) throw new Error('ENOENT');
    return files[p];
  });

describe('V2 A2.1: readDocsCredentials (ADR-0056 §10, OD-A2-3)', () => {
  it('absent, empty or blank password: no documentation (the service does not mount it); username defaults to docs', () => {
    for (const env of [{}, { SWAGGER_PASSWORD: '' }, { SWAGGER_PASSWORD: '   ' }, { SWAGGER_PASSWORD: ' '.repeat(20) }]) {
      expect(readDocsCredentials(reader(env))).toEqual({ username: 'docs', password: undefined });
    }
  });

  it('a password of at least 16 characters, from the variable or a mounted file; a custom username', () => {
    expect(readDocsCredentials(reader({ SWAGGER_PASSWORD: 'sixteen-chars-ok' }))).toEqual({ username: 'docs', password: 'sixteen-chars-ok' });
    expect(readDocsCredentials(reader({ SWAGGER_PASSWORD_FILE: '/run/secrets/docs' }, { '/run/secrets/docs': 'from-a-mounted-file\n' })).password).toBe('from-a-mounted-file');
    expect(readDocsCredentials(reader({ SWAGGER_PASSWORD: 'sixteen-chars-ok', SWAGGER_USERNAME: ' reviewer ' })).username).toBe('reviewer');
    expect(readDocsCredentials(reader({ SWAGGER_PASSWORD: 'sixteen-chars-ok', SWAGGER_USERNAME: '  ' })).username).toBe('docs');
  });

  it('refuses a short password without echoing it', () => {
    let error: unknown;
    try {
      readDocsCredentials(reader({ SWAGGER_PASSWORD: 'fifteen-chars!!' }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe('SWAGGER_PASSWORD must be at least 16 characters');
    expect((error as Error).message).not.toContain('fifteen-chars!!');
  });
});
