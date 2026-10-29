import { organizationPayerGrant } from '../payments/payment.service.js';
import { readFileSync } from 'node:fs';
import { generateServiceToken } from '@nawara/service-kit';
import { describe, expect, it } from 'vitest';
import { loadPaymentConfig } from './payment-config.js';

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://payment_app:pw@localhost:5433/payment',
  AUTH_SERVICE_URL: 'http://localhost:3001',
};
/** Stage 21.C.2: production needs Payment's own Organization reference credential (Organization verification has no bypass). */
const PROD_REFERENCE = { ORGANIZATION_SERVICE_URL: 'http://organization-service:3000', ORGANIZATION_REFERENCE_TOKEN: 'r'.repeat(43) };
const P1 = 'aaaaaaaa-0000-4000-8000-0000000000f1';
const BILLING_POLICY = JSON.stringify({ callers: { 'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel'], allowedPlatforms: [P1] } } });

describe('loadPaymentConfig', () => {
  it('loads with sane defaults from the minimal required env', () => {
    const cfg = loadPaymentConfig(BASE_ENV);
    expect(cfg.serviceName).toBe('payment-service');
    expect(cfg.supportedCurrencies).toEqual(['TND']);
    expect(cfg.maxAttempts).toBe(3);
    expect(cfg).not.toHaveProperty('idempotencyTtlHours'); // Core V2 S4g: class M, set by the database
    expect(cfg.testProviderEnabled).toBe(false);
    expect(cfg.rabbitmqUrl).toBeUndefined();
    expect(cfg.serviceTokens).toEqual([]);
  });

  it('parses and upper-cases a configured currency list', () => {
    const cfg = loadPaymentConfig({ ...BASE_ENV, PAYMENT_SUPPORTED_CURRENCIES: 'tnd, usd ,EUR' });
    expect(cfg.supportedCurrencies).toEqual(['TND', 'USD', 'EUR']);
  });

  it('refuses the test provider switch in production', () => {
    expect(() => loadPaymentConfig({ ...BASE_ENV, NODE_ENV: 'production', PAYMENT_TEST_PROVIDER: 'true' })).toThrow(
      /PAYMENT_TEST_PROVIDER must not be enabled/,
    );
  });

  it('allows the test provider switch outside production', () => {
    const cfg = loadPaymentConfig({ ...BASE_ENV, PAYMENT_TEST_PROVIDER: 'true' });
    expect(cfg.testProviderEnabled).toBe(true);
  });

  it('requires AUTH_SERVICE_URL and DATABASE_URL', () => {
    expect(() => loadPaymentConfig({ NODE_ENV: 'test', DATABASE_URL: BASE_ENV.DATABASE_URL })).toThrow(/AUTH_SERVICE_URL/);
    expect(() => loadPaymentConfig({ NODE_ENV: 'test', AUTH_SERVICE_URL: BASE_ENV.AUTH_SERVICE_URL })).toThrow(/DATABASE_URL/);
  });

  it('parses SERVICE_TOKENS via the kit helper', () => {
    const digest = 'a'.repeat(64);
    const cfg = loadPaymentConfig({ ...BASE_ENV, SERVICE_TOKENS: `billing-service:${digest}`, PAYMENT_SERVICE_POLICY: BILLING_POLICY });
    expect(cfg.serviceTokens).toEqual([{ caller: 'billing-service', digest }]);
  });

  describe('PAYMENT_SERVICE_POLICY (Stage 21.C.2, ADR-0052; ADR-0042 AD-2 and Amendment 3)', () => {
    const digest = 'a'.repeat(64);
    const authDigest = 'b'.repeat(64);

    it('billing-service holds exactly its three approved operations within its Platforms', () => {
      const p = loadPaymentConfig({ ...BASE_ENV, SERVICE_TOKENS: `billing-service:${digest}`, PAYMENT_SERVICE_POLICY: BILLING_POLICY }).servicePolicy.of('billing-service');
      expect([...p!.operations].sort()).toEqual(['payment.cancel', 'payment.create', 'payment.read']);
      expect([...p!.allowedPlatforms]).toEqual([P1]);
    });

    it('a registered token with no policy refuses to start (deny by default)', () => {
      expect(() => loadPaymentConfig({ ...BASE_ENV, SERVICE_TOKENS: `billing-service:${digest}` })).toThrow(/PAYMENT_SERVICE_POLICY is required/);
    });

    it('auth-service cannot be admitted with nothing (no empty operation list), and no attempt operation exists to grant', () => {
      const env = { ...BASE_ENV, SERVICE_TOKENS: `billing-service:${digest},auth-service:${authDigest}` };
      const policy = (auth: unknown) => JSON.stringify({ callers: { 'billing-service': JSON.parse(BILLING_POLICY).callers['billing-service'], 'auth-service': auth } });
      expect(() => loadPaymentConfig({ ...env, PAYMENT_SERVICE_POLICY: policy({ operations: [], allowedPlatforms: [] }) })).toThrow(/non-empty list/);
      expect(() => loadPaymentConfig({ ...env, PAYMENT_SERVICE_POLICY: BILLING_POLICY })).toThrow(/registered caller "auth-service" has no PAYMENT_SERVICE_POLICY entry/);
      expect(() => loadPaymentConfig({ ...env, PAYMENT_SERVICE_POLICY: policy({ operations: ['payment.attempt.sync'], allowedPlatforms: [] }) })).toThrow(/value other than/);
      expect(() => loadPaymentConfig({ ...env, PAYMENT_SERVICE_POLICY: policy({ operations: ['*'], allowedPlatforms: [] }) })).toThrow(/value other than/);
    });

    it('allowedPlatforms is required and explicit (no wildcard)', () => {
      const env = { ...BASE_ENV, SERVICE_TOKENS: `billing-service:${digest}` };
      expect(() => loadPaymentConfig({ ...env, PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: { 'billing-service': { operations: ['payment.read'] } } }) })).toThrow(/allowedPlatforms must be an explicit list/);
      expect(() => loadPaymentConfig({ ...env, PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: { 'billing-service': { operations: ['payment.read'], allowedPlatforms: ['*'] } } }) })).toThrow(/wrong form/);
    });

    it('errors never echo the digest or a policy value', () => {
      try {
        loadPaymentConfig({ ...BASE_ENV, SERVICE_TOKENS: `billing-service:${digest}`, PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: { 'billing-service': { operations: ['s3cret-op'], allowedPlatforms: [] } } }) });
        throw new Error('no throw');
      } catch (e) {
        expect((e as Error).message).not.toMatch(/s3cret-op|aaaaaaaa/);
      }
    });
  });

  describe('Organization reference (Stage 21.C.2, ADR-0052 decision 3; AD-5: no bypass)', () => {
    const fixture = JSON.stringify([{ organizationId: 'bbbbbbbb-0000-4000-8000-000000000001', platformId: P1, companyId: 'cccccccc-0000-4000-8000-000000000001' }]);
    const PROD = { ...BASE_ENV, NODE_ENV: 'production', RABBITMQ_URL: 'amqp://broker:5672' };

    it('production requires Organization Service and Payment\'s own reference credential', () => {
      expect(() => loadPaymentConfig(PROD)).toThrow(/ORGANIZATION_SERVICE_URL and ORGANIZATION_REFERENCE_TOKEN are required in production/);
      expect(loadPaymentConfig({ ...PROD, ...PROD_REFERENCE }).organizationReference).toMatchObject({ kind: 'http', baseUrl: PROD_REFERENCE.ORGANIZATION_SERVICE_URL, timeoutMs: 2000 });
    });

    it('the fixture is impossible to enable in production, even alongside a real reference', () => {
      expect(() => loadPaymentConfig({ ...PROD, ORGANIZATION_REFERENCE_FIXTURE: fixture })).toThrow(/refused in production/);
      expect(() => loadPaymentConfig({ ...PROD, ...PROD_REFERENCE, ORGANIZATION_REFERENCE_FIXTURE: fixture })).toThrow(/refused in production/);
    });

    it('outside production: the fixture, the real reference, or none (then every Organization-bearing create fails closed)', () => {
      expect(loadPaymentConfig({ ...BASE_ENV, ORGANIZATION_REFERENCE_FIXTURE: fixture }).organizationReference.kind).toBe('fixture');
      expect(loadPaymentConfig({ ...BASE_ENV, ...PROD_REFERENCE }).organizationReference.kind).toBe('http');
      expect(loadPaymentConfig(BASE_ENV).organizationReference.kind).toBe('none');
    });

    it('half a reference, or a fixture combined with a reference, is refused; a short token is refused without being echoed', () => {
      expect(() => loadPaymentConfig({ ...BASE_ENV, ORGANIZATION_SERVICE_URL: 'http://org:3000' })).toThrow(/must be set together/);
      expect(() => loadPaymentConfig({ ...BASE_ENV, ...PROD_REFERENCE, ORGANIZATION_REFERENCE_FIXTURE: fixture })).toThrow(/cannot be combined/);
      try {
        loadPaymentConfig({ ...BASE_ENV, ORGANIZATION_SERVICE_URL: 'http://org:3000', ORGANIZATION_REFERENCE_TOKEN: 'short-s3cret' });
        throw new Error('no throw');
      } catch (e) {
        expect((e as Error).message).not.toContain('short-s3cret');
      }
    });
  });

  it('reads the baseline rate limits, with defaults, and refuses a nonsensical value', () => {
    const base = { ...BASE_ENV };
    expect(loadPaymentConfig(base).rateLimits).toEqual({ createPerMinute: 300, attemptPerMinute: 30 });
    expect(loadPaymentConfig({ ...base, PAYMENT_RATE_LIMIT_CREATE_PER_MINUTE: '5', PAYMENT_RATE_LIMIT_ATTEMPT_PER_MINUTE: '2' }).rateLimits).toEqual({ createPerMinute: 5, attemptPerMinute: 2 });
    expect(() => loadPaymentConfig({ ...base, PAYMENT_RATE_LIMIT_CREATE_PER_MINUTE: '0' })).toThrow();
    expect(() => loadPaymentConfig({ ...base, PAYMENT_RATE_LIMIT_ATTEMPT_PER_MINUTE: 'lots' })).toThrow();
  });

  describe('event bus configuration (audit finding M-03)', () => {
    const PROD = { ...BASE_ENV, ...PROD_REFERENCE, NODE_ENV: 'production', RABBITMQ_URL: 'amqp://user:s3cret-pw@broker.internal:5672' };
    const refusal = (env: NodeJS.ProcessEnv): string => {
      try {
        loadPaymentConfig(env);
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    };

    it('production with RABBITMQ_URL loads and keeps the URL', () => {
      expect(loadPaymentConfig(PROD).rabbitmqUrl).toBe(PROD.RABBITMQ_URL);
    });

    it('production WITHOUT RABBITMQ_URL is refused at configuration time, so the service cannot start on the in-memory bus', () => {
      const env: NodeJS.ProcessEnv = { ...PROD };
      delete env.RABBITMQ_URL;
      expect(refusal(env)).toMatch(/RABBITMQ_URL is required in production/);
      // an unset NODE_ENV defaults to production, so a forgotten variable in a real deployment fails the same way
      const noNodeEnv: NodeJS.ProcessEnv = { ...BASE_ENV };
      delete noNodeEnv.NODE_ENV;
      expect(refusal(noNodeEnv)).toMatch(/RABBITMQ_URL is required in production/);
    });

    it('an empty RABBITMQ_URL in production is not a configured broker', () => {
      expect(refusal({ ...PROD, RABBITMQ_URL: '' })).not.toBe('');
    });

    it('a RABBITMQ_URL that is not amqp(s) is refused, and the error never echoes the URL or its credentials', () => {
      const msg = refusal({ ...PROD, RABBITMQ_URL: 'http://user:s3cret-pw@broker.internal' });
      expect(msg).toContain('RABBITMQ_URL');
      expect(msg).not.toContain('s3cret-pw');
      expect(msg).not.toContain('broker.internal');
    });

    it('outside production an unset RABBITMQ_URL stays allowed (development and tests use the in-memory bus)', () => {
      for (const NODE_ENV of ['development', 'test']) expect(loadPaymentConfig({ ...BASE_ENV, NODE_ENV }).rabbitmqUrl).toBeUndefined();
    });
  });

  // Stage 14.3: parity with billing-service/organization-service configuration rules.
  const PROD_ENV = { ...BASE_ENV, ...PROD_REFERENCE, NODE_ENV: 'production', RABBITMQ_URL: 'amqp://broker:5672' };

  it('accepts the least-privilege runtime role in production', () => {
    expect(loadPaymentConfig(PROD_ENV).databaseUrl).toBe(BASE_ENV.DATABASE_URL);
  });

  it.each(['postgres', 'root', 'payment_migrator', 'payment_admin', 'x_admin'])('refuses the %s database user in production, without echoing the URL', (user) => {
    try {
      loadPaymentConfig({ ...PROD_ENV, DATABASE_URL: `postgres://${user}:s3cret-value@localhost:5433/payment` });
      throw new Error('no throw');
    } catch (err) {
      expect((err as Error).message).toMatch(/least-privilege runtime role/);
      expect((err as Error).message).not.toContain('s3cret-value');
    }
  });

  it('V2 A2.2 (OD-A2.2-1, callee side): refuses a registered digest of the development token published in .env.example, naming the caller only', () => {
    const line = readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8').split('\n').find((l) => l.startsWith('BILLING_TO_PAYMENT_DIGEST='));
    const published = line!.slice('BILLING_TO_PAYMENT_DIGEST='.length).trim();
    const admitted = (digest: string) => ({ ...PROD_ENV, SERVICE_TOKENS: `billing-service:${digest}`, PAYMENT_SERVICE_POLICY: BILLING_POLICY });
    try {
      loadPaymentConfig(admitted(published));
      throw new Error('no throw');
    } catch (err) {
      expect((err as Error).message).toBe('SERVICE_TOKENS registers a published development token for caller "billing-service"; it is refused in production');
      expect((err as Error).message).not.toContain(published);
    }
    expect(loadPaymentConfig(admitted(generateServiceToken().digest)).serviceTokens).toHaveLength(1); // an unrelated digest passes
    expect(loadPaymentConfig({ ...BASE_ENV, SERVICE_TOKENS: `billing-service:${published}`, PAYMENT_SERVICE_POLICY: BILLING_POLICY }).serviceTokens).toHaveLength(1); // development keeps it
  });

  it('allows any database user outside production (tests use an admin connection)', () => {
    expect(loadPaymentConfig({ ...BASE_ENV, DATABASE_URL: 'postgres://postgres:pw@localhost:5433/payment' }).databaseUrl).toContain('postgres:pw');
  });

  it.each(['not a url', 'ftp://auth:3000', 'auth-service:3000'])('refuses a malformed AUTH_SERVICE_URL: %s', (url) => {
    expect(() => loadPaymentConfig({ ...BASE_ENV, AUTH_SERVICE_URL: url })).toThrow(/AUTH_SERVICE_URL/);
  });

  it('SWAGGER_PASSWORD, when set, must be at least 16 characters (docs stay unmounted when unset)', () => {
    expect(() => loadPaymentConfig({ ...BASE_ENV, SWAGGER_PASSWORD: 'short' })).toThrow(/SWAGGER_PASSWORD must be at least 16/);
    expect(loadPaymentConfig({ ...BASE_ENV, SWAGGER_PASSWORD: 'x'.repeat(16) }).docs.password).toBe('x'.repeat(16));
    expect(loadPaymentConfig(BASE_ENV).docs.password).toBeUndefined();
  });

  it.each(['TN', 'TNDX', 'T1D', 'TND,US$'])('refuses a malformed PAYMENT_SUPPORTED_CURRENCIES entry: %s', (list) => {
    expect(() => loadPaymentConfig({ ...BASE_ENV, PAYMENT_SUPPORTED_CURRENCIES: list })).toThrow(/three-letter ISO 4217/);
  });

  it('de-duplicates the currency list and still refuses an empty one', () => {
    expect(loadPaymentConfig({ ...BASE_ENV, PAYMENT_SUPPORTED_CURRENCIES: 'tnd,TND, eur' }).supportedCurrencies).toEqual(['TND', 'EUR']);
    expect(() => loadPaymentConfig({ ...BASE_ENV, PAYMENT_SUPPORTED_CURRENCIES: ' , ' })).toThrow(/PAYMENT_SUPPORTED_CURRENCIES/);
  });

  // Stage 14.6: bound on a RabbitMQ publisher confirm (a timeout fails the publish; the outbox keeps the event and retries it).
  it('RABBITMQ_CONFIRM_TIMEOUT_MS defaults to 5000 and is bounded (100-60000)', () => {
    expect(loadPaymentConfig(BASE_ENV).rabbitmqConfirmTimeoutMs).toBe(5000);
    expect(loadPaymentConfig({ ...BASE_ENV, RABBITMQ_CONFIRM_TIMEOUT_MS: '2000' }).rabbitmqConfirmTimeoutMs).toBe(2000);
    for (const bad of ['0', '99', '60001', 'abc', '1.5']) expect(() => loadPaymentConfig({ ...BASE_ENV, RABBITMQ_CONFIRM_TIMEOUT_MS: bad })).toThrow(/RABBITMQ_CONFIRM_TIMEOUT_MS/);
  });

  // Stage 15.3 (I9): the heartbeat this service requests; 0 (off) is refused, so a silent broker is always detected by Core's own bound.
  it('RABBITMQ_HEARTBEAT_S defaults to 10 and is bounded (5-60); 0 is refused', () => {
    expect(loadPaymentConfig(BASE_ENV).rabbitmqHeartbeatS).toBe(10);
    expect(loadPaymentConfig({ ...BASE_ENV, RABBITMQ_HEARTBEAT_S: '5' }).rabbitmqHeartbeatS).toBe(5);
    expect(loadPaymentConfig({ ...BASE_ENV, RABBITMQ_HEARTBEAT_S: '60' }).rabbitmqHeartbeatS).toBe(60);
    for (const bad of ['0', '4', '61', '-1', 'abc', '2.5']) expect(() => loadPaymentConfig({ ...BASE_ENV, RABBITMQ_HEARTBEAT_S: bad })).toThrow(/RABBITMQ_HEARTBEAT_S must be an integer between 5 and 60/);
  });

  it('Core V2 S4g (PAY-15): the retired IDEMPOTENCY_TTL_HOURS is refused, whatever its value, never silently ignored', () => {
    for (const v of ['24', '720', '2160', '1', 'ninety']) {
      expect(() => loadPaymentConfig({ ...BASE_ENV, IDEMPOTENCY_TTL_HOURS: v }), v).toThrow(/IDEMPOTENCY_TTL_HOURS was retired by Core V2 S4g/);
    }
    expect(() => loadPaymentConfig({ ...BASE_ENV, IDEMPOTENCY_TTL_HOURS: '' })).not.toThrow(); // empty means unset, like every optional value
  });
  describe('Core V2 S4f (PAY-14): the simulation provider (F-S1, F-S2, F-S5, F-S7)', () => {
    const SECRET = 's'.repeat(24) + 'imulation-own-secret';
    const SIM = { PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SIMULATION_WEBHOOK_SECRET: SECRET };
    const harness = generateServiceToken();
    const HARNESS_POLICY = (operations: string[]) => JSON.stringify({ callers: { 'simulation-harness': { operations, allowedPlatforms: [] } } });

    it('is off by default and, when enabled outside production, carries its own signing secret', () => {
      expect(loadPaymentConfig(BASE_ENV).simulation).toBeUndefined();
      expect(loadPaymentConfig({ ...BASE_ENV, ...SIM }).simulation).toEqual({ webhookSecret: SECRET });
    });

    it('refuses to start in production with the simulation provider, or with its secret configured', () => {
      const prod = { ...BASE_ENV, ...PROD_REFERENCE, NODE_ENV: 'production', RABBITMQ_URL: 'amqp://mq:5672' };
      expect(() => loadPaymentConfig({ ...prod, ...SIM })).toThrow(/PAYMENT_SIMULATION_PROVIDER must not be enabled/);
      expect(() => loadPaymentConfig({ ...prod, PAYMENT_SIMULATION_WEBHOOK_SECRET: SECRET })).toThrow(/PAYMENT_SIMULATION_WEBHOOK_SECRET must not be configured/);
    });

    it('requires signing material of at least 32 characters, never a development value published in this repository', () => {
      expect(() => loadPaymentConfig({ ...BASE_ENV, PAYMENT_SIMULATION_PROVIDER: 'true' })).toThrow(/PAYMENT_SIMULATION_WEBHOOK_SECRET is required/);
      expect(() => loadPaymentConfig({ ...BASE_ENV, ...SIM, PAYMENT_SIMULATION_WEBHOOK_SECRET: 'x'.repeat(31) })).toThrow(/at least 32 characters/);
      expect(() => loadPaymentConfig({ ...BASE_ENV, ...SIM, PAYMENT_SIMULATION_WEBHOOK_SECRET: 'test-provider-webhook-secret' })).toThrow(/at least 32 characters/);
    });

    it('F-S7: never runs beside the test provider (whose scenarios a payer chooses)', () => {
      expect(() => loadPaymentConfig({ ...BASE_ENV, ...SIM, PAYMENT_TEST_PROVIDER: 'true' })).toThrow(/mutually exclusive/);
    });

    it('F-S2: payment.simulation.resolve is held alone, and only where the simulation provider is enabled', () => {
      const env = { ...BASE_ENV, SERVICE_TOKENS: `simulation-harness:${harness.digest}` };
      expect(loadPaymentConfig({ ...env, ...SIM, PAYMENT_SERVICE_POLICY: HARNESS_POLICY(['payment.simulation.resolve']) }).servicePolicy.of('simulation-harness')?.operations)
        .toEqual(new Set(['payment.simulation.resolve']));
      expect(() => loadPaymentConfig({ ...env, ...SIM, PAYMENT_SERVICE_POLICY: HARNESS_POLICY(['payment.simulation.resolve', 'payment.read']) })).toThrow(/held alone/);
      expect(() => loadPaymentConfig({ ...env, PAYMENT_SERVICE_POLICY: HARNESS_POLICY(['payment.simulation.resolve']) })).toThrow(/requires PAYMENT_SIMULATION_PROVIDER/);
    });
  });
  describe('Core V2 S4e (PAY-03): payment.create.organization_payer is an inactive, default-denied capability (A-5)', () => {
    const producer = generateServiceToken();
    const policy = (operations: string[]) => JSON.stringify({ callers: { 'billing-service': { operations, allowedPlatforms: [P1] } } });
    const env = { ...BASE_ENV, SERVICE_TOKENS: `billing-service:${producer.digest}` };
    const prod = { ...env, ...PROD_REFERENCE, NODE_ENV: 'production', RABBITMQ_URL: 'amqp://mq:5672' };

    it('is never implied: the approved V1 policy does not hold it', () => {
      expect(loadPaymentConfig({ ...env, PAYMENT_SERVICE_POLICY: BILLING_POLICY }).servicePolicy.of('billing-service')?.operations.has('payment.create.organization_payer')).toBe(false);
    });

    it('may be held by an isolated non-production test policy', () => {
      const cfg = loadPaymentConfig({ ...env, PAYMENT_SERVICE_POLICY: policy(['payment.create', 'payment.create.organization_payer']) });
      expect(cfg.servicePolicy.of('billing-service')?.operations.has('payment.create.organization_payer')).toBe(true);
    });

    it('is refused in production configuration (a separate Owner decision grants it to a real producer)', () => {
      expect(() => loadPaymentConfig({ ...prod, PAYMENT_SERVICE_POLICY: policy(['payment.create', 'payment.create.organization_payer']) })).toThrow(/no production configuration may hold yet/);
      expect(() => loadPaymentConfig({ ...prod, PAYMENT_SERVICE_POLICY: BILLING_POLICY })).not.toThrow();
    });

    it('no wildcard or prefix grants it', () => {
      for (const op of ['*', 'payment.*', 'payment.create.*', 'payment.create.organization']) {
        expect(() => loadPaymentConfig({ ...env, PAYMENT_SERVICE_POLICY: policy(['payment.create', op]) }), op).toThrow();
      }
    });
  });

  describe('Core V2 S6b (R6B-1): payment.refund.create is billing-service\'s alone, never in production, and needs Payment\'s own Auth credential', () => {
    const producer = generateServiceToken();
    const other = generateServiceToken();
    const authToken = generateServiceToken().token;
    const env = { ...BASE_ENV, SERVICE_TOKENS: `billing-service:${producer.digest},other-producer:${other.digest}` };
    const policy = (billing: string[], others: string[] = ['payment.create']) =>
      JSON.stringify({ callers: { 'billing-service': { operations: billing, allowedPlatforms: [P1] }, 'other-producer': { operations: others, allowedPlatforms: [P1] } } });
    const prod = { ...env, ...PROD_REFERENCE, NODE_ENV: 'production', RABBITMQ_URL: 'amqp://mq:5672' };

    it('the grant enables refunds with Payment\'s own Auth token; without the grant there are no refunds at all', () => {
      const cfg = loadPaymentConfig({ ...env, AUTH_SERVICE_TOKEN: authToken, PAYMENT_SERVICE_POLICY: policy(['payment.create', 'payment.refund.create']) });
      expect(cfg.refunds).toEqual({ authServiceToken: authToken });
      expect(loadPaymentConfig({ ...env, PAYMENT_SERVICE_POLICY: policy(['payment.create']) }).refunds).toBeUndefined();
    });

    it('the grant without AUTH_SERVICE_TOKEN (or with a short one) is refused', () => {
      expect(() => loadPaymentConfig({ ...env, PAYMENT_SERVICE_POLICY: policy(['payment.create', 'payment.refund.create']) })).toThrow(/AUTH_SERVICE_TOKEN/);
      expect(() => loadPaymentConfig({ ...env, AUTH_SERVICE_TOKEN: 'short', PAYMENT_SERVICE_POLICY: policy(['payment.create', 'payment.refund.create']) })).toThrow(/AUTH_SERVICE_TOKEN/);
    });

    it('no other service identity may hold it, and nothing implies it', () => {
      expect(() => loadPaymentConfig({ ...env, AUTH_SERVICE_TOKEN: authToken, PAYMENT_SERVICE_POLICY: policy(['payment.create'], ['payment.create', 'payment.refund.create']) })).toThrow(/may be held only by billing-service/);
      for (const op of ['payment.refund', 'payment.refund.*', 'payment.*']) {
        expect(() => loadPaymentConfig({ ...env, AUTH_SERVICE_TOKEN: authToken, PAYMENT_SERVICE_POLICY: policy(['payment.create', op]) })).toThrow();
      }
    });

    it('is refused in production configuration, and so is an Auth credential for it', () => {
      expect(() => loadPaymentConfig({ ...prod, AUTH_SERVICE_TOKEN: authToken, PAYMENT_SERVICE_POLICY: policy(['payment.create', 'payment.refund.create']) })).toThrow(/no production configuration may hold/);
      expect(() => loadPaymentConfig({ ...prod, AUTH_SERVICE_TOKEN: authToken, PAYMENT_SERVICE_POLICY: policy(['payment.create']) })).toThrow(/AUTH_SERVICE_TOKEN must not be configured/);
    });

    it("Core V2 S6e-D (PAY-10): File Service for dispute evidence only beside refunds, set together, Payment's own token, never in production", () => {
      const fileToken = generateServiceToken().token;
      const refunds = { ...env, AUTH_SERVICE_TOKEN: authToken, PAYMENT_SERVICE_POLICY: policy(['payment.create', 'payment.refund.create']) };
      expect(loadPaymentConfig({ ...refunds, FILE_SERVICE_URL: 'http://file:3000', FILE_SERVICE_TOKEN: fileToken }).disputeEvidence).toEqual({ fileServiceUrl: 'http://file:3000', fileServiceToken: fileToken });
      expect(loadPaymentConfig(refunds).disputeEvidence).toBeUndefined();
      expect(loadPaymentConfig({ ...env, FILE_SERVICE_URL: 'http://file:3000', FILE_SERVICE_TOKEN: fileToken, PAYMENT_SERVICE_POLICY: policy(['payment.create']) }).disputeEvidence).toBeUndefined(); // no refunds, no disputes
      expect(() => loadPaymentConfig({ ...refunds, FILE_SERVICE_URL: 'http://file:3000' })).toThrow(/set together/);
      expect(() => loadPaymentConfig({ ...refunds, FILE_SERVICE_URL: 'http://file:3000', FILE_SERVICE_TOKEN: 'short' })).toThrow(/FILE_SERVICE_TOKEN/);
      expect(() => loadPaymentConfig({ ...prod, FILE_SERVICE_URL: 'http://file:3000', FILE_SERVICE_TOKEN: fileToken, PAYMENT_SERVICE_POLICY: policy(['payment.create']) })).toThrow(/FILE_SERVICE_URL must not be configured/);
    });
  });

  describe('Core V2 S5b (E-2): payment.create.assisted_settlement is a narrow, purpose-bound grant for billing-service only', () => {
    const producer = generateServiceToken();
    const other = generateServiceToken();
    const env = { ...BASE_ENV, SERVICE_TOKENS: `billing-service:${producer.digest},other-producer:${other.digest}` };
    const policy = (billing: string[], others: string[] = ['payment.create']) =>
      JSON.stringify({ callers: { 'billing-service': { operations: billing, allowedPlatforms: [P1] }, 'other-producer': { operations: others, allowedPlatforms: [P1] } } });
    const prod = { ...env, ...PROD_REFERENCE, NODE_ENV: 'production', RABBITMQ_URL: 'amqp://mq:5672' };

    it('billing-service may hold it in a non-production policy; the approved V1 policy does not', () => {
      expect(loadPaymentConfig({ ...env, PAYMENT_SERVICE_POLICY: policy(['payment.create', 'payment.create.assisted_settlement']) }).servicePolicy.of('billing-service')?.operations.has('payment.create.assisted_settlement')).toBe(true);
      expect(loadPaymentConfig({ ...BASE_ENV, SERVICE_TOKENS: `billing-service:${producer.digest}`, PAYMENT_SERVICE_POLICY: BILLING_POLICY }).servicePolicy.of('billing-service')?.operations.has('payment.create.assisted_settlement')).toBe(false);
    });

    it('no other service identity may hold it', () => {
      expect(() => loadPaymentConfig({ ...env, PAYMENT_SERVICE_POLICY: policy(['payment.create'], ['payment.create', 'payment.create.assisted_settlement']) })).toThrow(/may be held only by billing-service/);
    });

    it('is refused in production configuration', () => {
      expect(() => loadPaymentConfig({ ...prod, PAYMENT_SERVICE_POLICY: policy(['payment.create', 'payment.create.assisted_settlement']) })).toThrow(/no production configuration may hold yet/);
    });

    it('no wildcard or prefix grants it', () => {
      for (const op of ['payment.create.assisted', 'payment.create.assisted_settlement.*', 'payment.create.*']) {
        expect(() => loadPaymentConfig({ ...env, PAYMENT_SERVICE_POLICY: policy(['payment.create', op]) }), op).toThrow();
      }
    });

    it('the required grant is purpose-bound: assisted and (Core V2 S6f, R6F-2) recovery need their narrow grants only; any other Organization payer needs the broad one', () => {
      expect(organizationPayerGrant('assisted_settlement', 'organization')).toBe('payment.create.assisted_settlement');
      expect(organizationPayerGrant('assisted_settlement', 'user')).toBe('payment.create.assisted_settlement'); // the pairing then refuses it
      expect(organizationPayerGrant('recovery_settlement', 'organization')).toBe('payment.create.recovery_settlement');
      expect(organizationPayerGrant('non_entitlement', 'organization')).toBe('payment.create.organization_payer');
      expect(organizationPayerGrant('direct_purchase', 'user')).toBeNull();
      expect(organizationPayerGrant('organization_subscription', 'user')).toBeNull();
    });
  });

  describe('Core V2 S6f (R6F-2): payment.create.recovery_settlement is billing-service\'s alone, never in production', () => {
    const producer = generateServiceToken();
    const other = generateServiceToken();
    const env = { ...BASE_ENV, SERVICE_TOKENS: `billing-service:${producer.digest},other-producer:${other.digest}` };
    const policy = (billing: string[], others: string[] = ['payment.create']) =>
      JSON.stringify({ callers: { 'billing-service': { operations: billing, allowedPlatforms: [P1] }, 'other-producer': { operations: others, allowedPlatforms: [P1] } } });
    it('billing-service may hold it; no other caller; production refuses it', () => {
      expect(loadPaymentConfig({ ...env, PAYMENT_SERVICE_POLICY: policy(['payment.create', 'payment.create.recovery_settlement']) }).servicePolicy.of('billing-service')!.operations.has('payment.create.recovery_settlement')).toBe(true);
      expect(() => loadPaymentConfig({ ...env, PAYMENT_SERVICE_POLICY: policy(['payment.create'], ['payment.create', 'payment.create.recovery_settlement']) })).toThrow(/may be held only by billing-service/);
      expect(() => loadPaymentConfig({ ...env, ...PROD_REFERENCE, NODE_ENV: 'production', RABBITMQ_URL: 'amqp://mq:5672', PAYMENT_SERVICE_POLICY: policy(['payment.create', 'payment.create.recovery_settlement']) }))
        .toThrow(/no production configuration may hold/);
    });
  });
});
