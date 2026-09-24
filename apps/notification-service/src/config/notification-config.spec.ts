import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, generateServiceToken } from '@nawara/service-kit';
import { SERVICE_NAME, loadNotificationConfig } from './notification-config.js';

const DB = 'postgres://notification_app:pw-not-real@db:5432/notification';
const KEY = randomBytes(32).toString('base64');
const HASH_KEY = randomBytes(32).toString('base64');
const DEST_KEY = randomBytes(32).toString('base64');
const REQUIRED = {
  DATABASE_URL: DB, RABBITMQ_URL: 'amqp://notify:pw-not-real@broker:5672', NOTIFICATION_SECRET_KEYS: `k1:${KEY}`, NOTIFICATION_SECRET_ACTIVE_KEY_ID: 'k1',
  NOTIFICATION_DEFAULT_LOCALE: 'en', NOTIFICATION_REQUEST_HASH_KEY: HASH_KEY,
};
/** A provider selected needs the destination-limiter key (Stage 16.9). */
const WITH_LIMIT = { NOTIFICATION_DESTINATION_LIMIT_KEY: DEST_KEY };
const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...REQUIRED, ...over });

describe('notification-service configuration', () => {
  it('has one canonical identity, and production is the default environment (the safe behaviour)', () => {
    const c = loadNotificationConfig(env());
    expect(SERVICE_NAME).toBe('notification-service');
    expect(c.serviceName).toBe('notification-service');
    expect(c.nodeEnv).toBe('production');
    expect(c.isProduction).toBe(true);
  });

  it('in production needs only the database, the broker, the secret key ring and the default locale; no default opens anything', () => {
    const c = loadNotificationConfig(env({ NODE_ENV: 'production' }));
    expect(c.databaseUrl).toBe(DB);
    expect(c.port).toBe(3000);
    expect(c.httpDrainTimeoutMs).toBe(5000);
    expect(c.corsOrigins).toEqual([]);
    expect(c.trustProxy).toBe(false);
    expect(c.serviceTokens).toEqual([]); // every service-token call refused
  });

  it('carries the kit database limits with their bounded defaults (Stage 16.4)', () => {
    expect(loadNotificationConfig(env()).db).toEqual({ poolMax: 10, connectionTimeoutMs: 5000, statementTimeoutMs: 30_000, idleInTransactionTimeoutMs: 60_000, queryTimeoutMs: 35_000 });
    expect(() => loadNotificationConfig(env({ DB_POOL_MAX: '0' }))).toThrow(ConfigError);
    expect(() => loadNotificationConfig(env({ DB_STATEMENT_TIMEOUT_MS: '30000', DB_QUERY_TIMEOUT_MS: '30000' }))).toThrow(/DB_QUERY_TIMEOUT_MS/);
  });

  it('carries no provider credential unless that provider is selected (16.8)', () => {
    const d = loadNotificationConfig(env()).delivery;
    expect([d.resend, d.twilio]).toEqual([undefined, undefined]);
    for (const k of ['smtp', 'emailFrom', 'apiKey']) expect(Object.keys(loadNotificationConfig(env()))).not.toContain(k);
  });

  it.each(['RABBITMQ_URL', 'NOTIFICATION_SECRET_KEYS', 'NOTIFICATION_SECRET_ACTIVE_KEY_ID', 'NOTIFICATION_DEFAULT_LOCALE', 'NOTIFICATION_REQUEST_HASH_KEY'])('refuses to start without %s (no default)', (name) => {
    const e = env();
    delete e[name];
    expect(() => loadNotificationConfig(e)).toThrow(ConfigError);
  });

  it('the broker settings have the Core bounds, and the broker URL is never echoed', () => {
    const c = loadNotificationConfig(env());
    expect([c.rabbitmqConfirmTimeoutMs, c.rabbitmqHeartbeatS]).toEqual([5000, 10]);
    for (const [k, v] of [['RABBITMQ_CONFIRM_TIMEOUT_MS', '99'], ['RABBITMQ_HEARTBEAT_S', '0'], ['RABBITMQ_HEARTBEAT_S', '61']]) expect(() => loadNotificationConfig(env({ [k]: v }))).toThrow(ConfigError);
    try {
      loadNotificationConfig(env({ RABBITMQ_URL: 'http://notify:broker-pw-value@broker' }));
      throw new Error('no throw');
    } catch (e) {
      expect((e as Error).message).toMatch(/RABBITMQ_URL/);
      expect((e as Error).message).not.toContain('broker-pw-value');
    }
  });

  it('the secret key ring: 32-byte keys, distinct ids and keys, an active id that exists; never echoed', () => {
    const c = loadNotificationConfig(env({ NOTIFICATION_SECRET_KEYS: `k1:${KEY},k2:${randomBytes(32).toString('base64')}`, NOTIFICATION_SECRET_ACTIVE_KEY_ID: 'k2' }));
    expect([...c.secretKeys.keys()]).toEqual(['k1', 'k2']);
    expect(c.secretActiveKeyId).toBe('k2');
    for (const [keys, active] of [[`k1:${randomBytes(16).toString('base64')}`, 'k1'], [`k1:${KEY},k1:${randomBytes(32).toString('base64')}`, 'k1'], [`k1:${KEY},k2:${KEY}`, 'k1'], [`bad id:${KEY}`, 'bad id'], [`k1:${KEY}`, 'k9'], [KEY, 'k1']]) {
      try {
        loadNotificationConfig(env({ NOTIFICATION_SECRET_KEYS: keys, NOTIFICATION_SECRET_ACTIVE_KEY_ID: active }));
        throw new Error('no throw');
      } catch (e) {
        expect(e, keys).toBeInstanceOf(ConfigError);
        expect((e as Error).message).not.toContain(KEY);
      }
    }
  });

  it('the default locale is a BCP 47 locale', () => {
    expect(loadNotificationConfig(env({ NOTIFICATION_DEFAULT_LOCALE: 'fr-TN' })).defaultLocale).toBe('fr-TN');
    for (const bad of ['FR', 'fr_TN', 'french', 'x']) expect(() => loadNotificationConfig(env({ NOTIFICATION_DEFAULT_LOCALE: bad })), bad).toThrow(ConfigError);
  });

  it('refuses a missing or non-PostgreSQL DATABASE_URL, without echoing it', () => {
    expect(() => loadNotificationConfig({ ...REQUIRED, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    for (const bad of ['mysql://u:secret-pw-value@h/db', 'not a url']) {
      try {
        loadNotificationConfig(env({ DATABASE_URL: bad }));
        throw new Error('no throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as Error).message).not.toContain('secret-pw-value');
      }
    }
  });

  it.each(['postgres', 'root', 'notification_migrator'])('refuses the %s database user in production (superuser / schema owner), without echoing the URL', (user) => {
    try {
      loadNotificationConfig(env({ NODE_ENV: 'production', DATABASE_URL: `postgres://${user}:s3cret-value@db:5432/notification` }));
      throw new Error('no throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toMatch(/least-privilege runtime role/);
      expect((e as Error).message).not.toContain('s3cret-value');
    }
  });

  it('allows any database user outside production (tests and local runs use an admin connection)', () => {
    expect(loadNotificationConfig(env({ NODE_ENV: 'test', DATABASE_URL: 'postgres://postgres@localhost:5433/n' })).databaseUrl).toContain('postgres@');
  });

  it('accepts registered service callers, and refuses malformed SERVICE_TOKENS without echoing them', () => {
    const { digest } = generateServiceToken();
    const policy = JSON.stringify({ callers: { 'some-core-service': { templates: ['membership.approved'], channels: ['EMAIL'], organizations: 'none' } } });
    expect(loadNotificationConfig(env({ SERVICE_TOKENS: `some-core-service:${digest}`, NOTIFICATION_SERVICE_POLICY: policy })).serviceTokens).toEqual([{ caller: 'some-core-service', digest }]);
    for (const bad of ['no-colon', 'caller:not-a-digest', `a:${digest},b:${digest}`]) {
      try {
        loadNotificationConfig(env({ SERVICE_TOKENS: bad }));
        throw new Error('no throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as Error).message).not.toContain(digest);
        expect((e as Error).message).not.toContain('not-a-digest');
      }
    }
  });

  it.each([
    ['PORT', ['0', '65536', 'abc', '1.5']],
    ['HTTP_DRAIN_TIMEOUT_MS', ['499', '120001', 'soon']],
    ['NODE_ENV', ['prod', 'staging']],
    ['LOG_LEVEL', ['verbose']],
    ['BODY_LIMIT_KB', ['0', '10241']],
    ['CORS_ORIGINS', ['*', 'https://app.example.com/path', 'ftp://x.example']],
    ['TRUST_PROXY', ['maybe']],
  ])('refuses an invalid %s (fail closed)', (name, values) => {
    for (const v of values) expect(() => loadNotificationConfig(env({ [name]: v })), `${name}=${v}`).toThrow(ConfigError);
  });

  it('HTTP_DRAIN_TIMEOUT_MS has the kit default and bounds (5000, 500-120000), further bounded by the provider timeout (SDD §8.2)', () => {
    expect(loadNotificationConfig(env({ HTTP_DRAIN_TIMEOUT_MS: '500' })).httpDrainTimeoutMs).toBe(500);
    expect(loadNotificationConfig(env({ HTTP_DRAIN_TIMEOUT_MS: '49999' })).httpDrainTimeoutMs).toBe(49_999);
    // Stage 16.7: provider timeout (default 10 s) < the 60 s stop grace - the HTTP drain, so a drain of 50 s or more is refused.
    expect(() => loadNotificationConfig(env({ HTTP_DRAIN_TIMEOUT_MS: '50000' }))).toThrow(/NOTIFICATION_PROVIDER_TIMEOUT_MS/);
    expect(loadNotificationConfig(env({ HTTP_DRAIN_TIMEOUT_MS: '59000', NOTIFICATION_PROVIDER_TIMEOUT_MS: '900', NOTIFICATION_LEASE_MS: '5000' })).httpDrainTimeoutMs).toBe(59_000);
    expect(() => loadNotificationConfig(env({ HTTP_DRAIN_TIMEOUT_MS: '120000', NOTIFICATION_PROVIDER_TIMEOUT_MS: '100', NOTIFICATION_LEASE_MS: '5000' }))).toThrow(ConfigError);
  });

  describe('delivery engine (Stage 16.7)', () => {
    it('defaults: no provider (no worker), and the bounded engine values', () => {
      expect(loadNotificationConfig(env()).delivery).toEqual({
        emailProvider: 'none', smsProvider: 'none', resend: undefined, twilio: undefined, intervalMs: 1000, batchSize: 20, concurrency: 4, leaseMs: 60_000, providerTimeoutMs: 10_000, retryBaseMs: 30_000,
        retryCeilingMs: 1_800_000, maxAttempts: 5, timeZone: 'UTC', callerTemplateLimitPerMinute: 6000, drainTimeoutMs: 12_000,
      });
    });

    it('the test provider is accepted outside production and refused in production, on either channel (it delivers nothing)', () => {
      const dev = loadNotificationConfig(env({ NODE_ENV: 'development', NOTIFICATION_EMAIL_PROVIDER: 'test', NOTIFICATION_SMS_PROVIDER: 'test', ...WITH_LIMIT })).delivery;
      expect([dev.emailProvider, dev.smsProvider]).toEqual(['test', 'test']);
      expect(loadNotificationConfig(env({ NODE_ENV: 'test', NOTIFICATION_SMS_PROVIDER: 'test', ...WITH_LIMIT })).delivery.smsProvider).toBe('test');
      for (const k of ['NOTIFICATION_EMAIL_PROVIDER', 'NOTIFICATION_SMS_PROVIDER']) {
        expect(() => loadNotificationConfig(env({ NODE_ENV: 'production', [k]: 'test' }))).toThrow(/refused in production/);
        expect(() => loadNotificationConfig(env({ [k]: 'test' }))).toThrow(/refused in production/); // production is the default
      }
      expect(() => loadNotificationConfig(env({ NOTIFICATION_EMAIL_PROVIDER: 'twilio' }))).toThrow(ConfigError);
      expect(() => loadNotificationConfig(env({ NOTIFICATION_SMS_PROVIDER: 'resend' }))).toThrow(ConfigError);
      expect(() => loadNotificationConfig(env({ NOTIFICATION_DELIVERY_PROVIDER: 'test' }))).toThrow(/replaced by NOTIFICATION_EMAIL_PROVIDER/);
    });

    describe('real providers (Stage 16.8)', () => {
      const RESEND = { ...WITH_LIMIT, NOTIFICATION_EMAIL_PROVIDER: 'resend', NOTIFICATION_RESEND_API_KEY: 're_Sentinel_Resend_Key_0123456789', NOTIFICATION_EMAIL_FROM: 'Nawara <no-reply@notify.example.com>' };
      const TWILIO = {
        ...WITH_LIMIT, NOTIFICATION_SMS_PROVIDER: 'twilio', NOTIFICATION_TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`, NOTIFICATION_TWILIO_API_KEY_SID: `SK${'b'.repeat(32)}`,
        NOTIFICATION_TWILIO_API_KEY_SECRET: 'SentinelTwilioSecret0123456789ab', NOTIFICATION_TWILIO_MESSAGING_SERVICE_SID: `MG${'c'.repeat(32)}`,
      };

      it('valid production configuration: Resend and Twilio selected, https defaults, senders from configuration', () => {
        const d = loadNotificationConfig(env({ NODE_ENV: 'production', ...RESEND, ...TWILIO })).delivery;
        expect(d.resend).toEqual({ apiKey: RESEND.NOTIFICATION_RESEND_API_KEY, from: 'Nawara <no-reply@notify.example.com>', baseUrl: 'https://api.resend.com' });
        expect(d.twilio).toMatchObject({ messagingServiceSid: TWILIO.NOTIFICATION_TWILIO_MESSAGING_SERVICE_SID, baseUrl: 'https://api.twilio.com' });
        expect(loadNotificationConfig(env({ ...RESEND, NOTIFICATION_EMAIL_FROM: 'no-reply@notify.example.com' })).delivery.resend!.from).toBe('no-reply@notify.example.com');
      });

      it('credentials are read only for the provider selected; nothing is required with none', () => {
        expect(loadNotificationConfig(env({ NOTIFICATION_SMS_PROVIDER: 'none' })).delivery.twilio).toBeUndefined();
        expect(loadNotificationConfig(env({ ...TWILIO })).delivery.resend).toBeUndefined();
      });

      it.each([
        ...Object.keys(RESEND).filter((k) => k !== 'NOTIFICATION_EMAIL_PROVIDER').map((k) => [k, RESEND, undefined] as const),
        ...Object.keys(TWILIO).filter((k) => k !== 'NOTIFICATION_SMS_PROVIDER').map((k) => [k, TWILIO, undefined] as const),
      ])('refuses to start without %s when its provider is selected', (name, set) => {
        const e = env({ ...set });
        delete e[name];
        expect(() => loadNotificationConfig(e)).toThrow(new RegExp(name));
      });

      it.each([
        ['NOTIFICATION_RESEND_API_KEY', ['sk_live_x', 're_short', 're_has space in it 0123456789'], RESEND],
        ['NOTIFICATION_EMAIL_FROM', ['Nawara <no-reply@notify>', 'Evil\r\nBcc: x@evil.test <a@b.example>', '"Quoted" <a@b.example>', 'a, b <a@b.example>', 'x'.repeat(65) + ' <a@b.example>', ' Lead <a@b.example>', 'not-an-address'], RESEND],
        ['NOTIFICATION_RESEND_BASE_URL', ['ftp://api.resend.com', 'not a url'], RESEND],
        ['NOTIFICATION_TWILIO_ACCOUNT_SID', ['AC123', `SK${'a'.repeat(32)}`, `AC${'A'.repeat(32)}`], TWILIO],
        ['NOTIFICATION_TWILIO_API_KEY_SID', [`AC${'a'.repeat(32)}`], TWILIO],
        ['NOTIFICATION_TWILIO_API_KEY_SECRET', ['short', `${'a'.repeat(31)}!`], TWILIO],
        ['NOTIFICATION_TWILIO_MESSAGING_SERVICE_SID', ['+21620000000', 'AlphaSender', `MG${'z'.repeat(32)}`], TWILIO],
      ] as const)('refuses a malformed %s, never echoing it', (name, values, set) => {
        for (const v of values) {
          try {
            loadNotificationConfig(env({ ...set, [name]: v }));
            throw new Error(`accepted ${name}`);
          } catch (e) {
            expect((e as Error)).toBeInstanceOf(ConfigError);
            expect((e as Error).message).toContain(name);
            if (v.length > 6) expect((e as Error).message).not.toContain(v);
          }
        }
      });

      it('plain-http provider URLs (local stubs) are refused in production', () => {
        expect(() => loadNotificationConfig(env({ NODE_ENV: 'production', ...RESEND, NOTIFICATION_RESEND_BASE_URL: 'http://127.0.0.1:9' }))).toThrow(/NOTIFICATION_RESEND_BASE_URL/);
        expect(() => loadNotificationConfig(env({ NODE_ENV: 'production', ...TWILIO, NOTIFICATION_TWILIO_BASE_URL: 'http://127.0.0.1:9' }))).toThrow(/NOTIFICATION_TWILIO_BASE_URL/);
        expect(loadNotificationConfig(env({ NODE_ENV: 'development', ...TWILIO, NOTIFICATION_TWILIO_BASE_URL: 'http://127.0.0.1:9' })).delivery.twilio!.baseUrl).toBe('http://127.0.0.1:9');
      });

      it('secrets can come from *_FILE (Docker / Kubernetes secrets)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'notif-secret-'));
        writeFileSync(join(dir, 'k'), `${RESEND.NOTIFICATION_RESEND_API_KEY}\n`);
        const e = env({ ...RESEND, NOTIFICATION_RESEND_API_KEY_FILE: join(dir, 'k') });
        delete e.NOTIFICATION_RESEND_API_KEY;
        expect(loadNotificationConfig(e).delivery.resend!.apiKey).toBe(RESEND.NOTIFICATION_RESEND_API_KEY);
      });
    });

    it('enforces the SDD §8.2 relationships at startup', () => {
      expect(() => loadNotificationConfig(env({ NOTIFICATION_LEASE_MS: '19999' }))).toThrow(/at least 2 x NOTIFICATION_PROVIDER_TIMEOUT_MS/);
      expect(loadNotificationConfig(env({ NOTIFICATION_LEASE_MS: '20000' })).delivery.leaseMs).toBe(20_000);
      expect(loadNotificationConfig(env({ NOTIFICATION_PROVIDER_TIMEOUT_MS: '3000' })).delivery.drainTimeoutMs).toBe(5000); // drain >= timeout
      expect(() => loadNotificationConfig(env({ NOTIFICATION_RETRY_BASE_MS: '60000', NOTIFICATION_RETRY_CEILING_MS: '59999' }))).toThrow(/CEILING/);
      expect(() => loadNotificationConfig(env({ NOTIFICATION_WORKER_CONCURRENCY: '10' }))).toThrow(/DB_POOL_MAX/); // pool default 10
      expect(loadNotificationConfig(env({ NOTIFICATION_WORKER_CONCURRENCY: '10', DB_POOL_MAX: '11' })).delivery.concurrency).toBe(10);
    });

    it.each([
      ['NOTIFICATION_LEASE_MS', ['4999', '3600001', 'x']],
      ['NOTIFICATION_PROVIDER_TIMEOUT_MS', ['99', '30001']],
      ['NOTIFICATION_RETRY_BASE_MS', ['999', '3600001']],
      ['NOTIFICATION_RETRY_CEILING_MS', ['86400001']],
      ['NOTIFICATION_WORKER_CONCURRENCY', ['0', '51']],
      ['NOTIFICATION_WORKER_INTERVAL_MS', ['99', '60001']],
      ['NOTIFICATION_WORKER_BATCH_SIZE', ['0', '501']],
      ['NOTIFICATION_MAX_ATTEMPTS', ['0', '21']],
      ['NOTIFICATION_RATE_CALLER_TEMPLATE_PER_MINUTE', ['0', '1000001']],
      ['NOTIFICATION_TIME_ZONE', ['Mars/Olympus', 'not a zone']],
    ])('refuses an invalid %s', (name, values) => {
      for (const v of values) expect(() => loadNotificationConfig(env({ [name]: v })), `${name}=${v}`).toThrow(ConfigError);
    });

    it('accepts an IANA time zone', () => {
      expect(loadNotificationConfig(env({ NOTIFICATION_TIME_ZONE: 'Africa/Tunis' })).delivery.timeZone).toBe('Africa/Tunis');
    });
  });

  describe('Stage 16.9 key material, key rotation and operations', () => {
    const k = () => randomBytes(32).toString('base64');
    const readExample = () => readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8');
    const exampleValue = (name: string) => new RegExp(`^${name}=(\\S+)$`, 'm').exec(readExample())![1];

    it('the destination-limiter key is required while a provider is selected, and only then', () => {
      expect(() => loadNotificationConfig(env({ NODE_ENV: 'development', NOTIFICATION_EMAIL_PROVIDER: 'test' }))).toThrow(/NOTIFICATION_DESTINATION_LIMIT_KEY/);
      expect(loadNotificationConfig(env()).delivery.destinationLimit).toBeUndefined();
      const d = loadNotificationConfig(env({ NODE_ENV: 'development', NOTIFICATION_EMAIL_PROVIDER: 'test', ...WITH_LIMIT })).delivery.destinationLimit!;
      expect(d).toMatchObject({ limit: 30, windowSec: 3600, previousKey: undefined });
      expect(d.key.equals(Buffer.from(DEST_KEY, 'base64'))).toBe(true);
    });

    it.each([
      ['NOTIFICATION_RATE_DESTINATION_LIMIT', ['0', '100001']],
      ['NOTIFICATION_RATE_DESTINATION_WINDOW_SEC', ['59', '86401']],
      ['NOTIFICATION_OPS_REPORT_INTERVAL_MS', ['9999', '3600001']],
      ['NOTIFICATION_RETENTION_INTERVAL_MS', ['9999', '3600001']],
      ['NOTIFICATION_RETENTION_BATCH_SIZE', ['0', '10001']],
    ])('refuses an out-of-bounds %s', (name, values) => {
      for (const v of values) expect(() => loadNotificationConfig(env({ NOTIFICATION_EMAIL_PROVIDER: 'none', ...WITH_LIMIT, [name]: v })), `${name}=${v}`).toThrow(ConfigError);
    });

    it('one key, one purpose: every pair of secret, request-hash (current, previous) and destination-limiter (current, previous) keys must differ', () => {
      const secret = KEY;
      const cases: Array<[Record<string, string>, RegExp]> = [
        [{ NOTIFICATION_REQUEST_HASH_KEY: secret }, /NOTIFICATION_REQUEST_HASH_KEY must differ from NOTIFICATION_SECRET_KEYS/],
        [{ NOTIFICATION_DESTINATION_LIMIT_KEY: HASH_KEY }, /NOTIFICATION_DESTINATION_LIMIT_KEY must differ from NOTIFICATION_REQUEST_HASH_KEY/],
        [{ NOTIFICATION_DESTINATION_LIMIT_KEY: secret }, /NOTIFICATION_DESTINATION_LIMIT_KEY must differ from NOTIFICATION_SECRET_KEYS/],
        [{ NOTIFICATION_REQUEST_HASH_PREVIOUS_KEYS: HASH_KEY }, /NOTIFICATION_REQUEST_HASH_PREVIOUS_KEYS must differ from NOTIFICATION_REQUEST_HASH_KEY/],
        [{ ...WITH_LIMIT, NOTIFICATION_DESTINATION_LIMIT_PREVIOUS_KEY: DEST_KEY }, /NOTIFICATION_DESTINATION_LIMIT_PREVIOUS_KEY must differ from NOTIFICATION_DESTINATION_LIMIT_KEY/],
        [{ ...WITH_LIMIT, NOTIFICATION_DESTINATION_LIMIT_PREVIOUS_KEY: HASH_KEY }, /must differ/],
        [{ NOTIFICATION_REQUEST_HASH_PREVIOUS_KEYS: `${DEST_KEY}`, ...WITH_LIMIT }, /must differ/],
      ];
      for (const [over, message] of cases) {
        try {
          loadNotificationConfig(env(over));
          throw new Error(`accepted ${JSON.stringify(Object.keys(over))}`);
        } catch (e) {
          expect((e as Error).message).toMatch(message);
          for (const v of Object.values(over)) expect((e as Error).message).not.toContain(v);
        }
      }
    });

    it('request-hash previous keys: at most 2, each at least 32 bytes', () => {
      expect(loadNotificationConfig(env({ NOTIFICATION_REQUEST_HASH_PREVIOUS_KEYS: `${k()},${k()}` })).requestHashPreviousKeys).toHaveLength(2);
      expect(loadNotificationConfig(env()).requestHashPreviousKeys).toEqual([]);
      expect(() => loadNotificationConfig(env({ NOTIFICATION_REQUEST_HASH_PREVIOUS_KEYS: `${k()},${k()},${k()}` }))).toThrow(/at most 2/);
      expect(() => loadNotificationConfig(env({ NOTIFICATION_REQUEST_HASH_PREVIOUS_KEYS: 'c2hvcnQ=' }))).toThrow(/NOTIFICATION_REQUEST_HASH_PREVIOUS_KEYS/);
    });

    it.each(['NOTIFICATION_REQUEST_HASH_KEY', 'NOTIFICATION_DESTINATION_LIMIT_KEY', 'NOTIFICATION_SECRET_KEYS'])(
      'the development %s published in .env.example is refused in production, accepted in development', (name) => {
        const published = exampleValue(name);
        const value = name === 'NOTIFICATION_SECRET_KEYS' ? published : published;
        const over = name === 'NOTIFICATION_SECRET_KEYS' ? { NOTIFICATION_SECRET_KEYS: value, NOTIFICATION_SECRET_ACTIVE_KEY_ID: 'dev1' } : { [name]: value };
        const withProvider = name === 'NOTIFICATION_DESTINATION_LIMIT_KEY' ? { NOTIFICATION_EMAIL_PROVIDER: 'none' } : {};
        expect(() => loadNotificationConfig(env({ NODE_ENV: 'production', ...withProvider, ...over }))).toThrow(new RegExp(`${name}.*published development key`));
        expect(() => loadNotificationConfig(env({ NODE_ENV: 'development', ...withProvider, ...over }))).not.toThrow();
      },
    );

    it('a patterned (non-random) key is refused in production for every purpose', () => {
      const weak = Buffer.from('ab'.repeat(16)).toString('base64');
      for (const over of [{ NOTIFICATION_REQUEST_HASH_KEY: weak }, { NOTIFICATION_SECRET_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}` }, { ...WITH_LIMIT, NOTIFICATION_DESTINATION_LIMIT_KEY: weak }]) {
        expect(() => loadNotificationConfig(env({ NODE_ENV: 'production', ...over }))).toThrow(/does not look random/);
        expect(() => loadNotificationConfig(env({ NODE_ENV: 'development', ...over }))).not.toThrow();
      }
    });
  });
});
