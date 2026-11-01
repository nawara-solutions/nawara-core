import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitForHealth } from './support/process.js';

/**
 * Core V2 S-INT G7 (readiness record `docs/architecture/core-v2-s-int-readiness.md` §7.3; S0 §3.8 FC-10): production refuses simulation.
 * The BUILT billing-service and payment-service, each started as its own process with NODE_ENV=production and the production
 * configuration the image smoke test certifies (`scripts/smoke-core-image.sh`; the database deliberately unreachable: liveness never needs
 * it, and neither does the mounting of routes):
 *
 *   1. a valid production configuration boots, and every simulation-only module is NOT mounted: its routes answer 404 (an unmounted
 *      route), while a production contract of the same service (B6, the payment read) is mounted and refuses an anonymous caller;
 *   2. the same configuration with any simulation or test setting added refuses to start (a non-zero exit, before listening).
 *
 * A real RabbitMQ broker is needed (both attach to it at startup in production). Nothing here is a production deployment.
 * Prerequisite: `npm run build -w @nawara/service-kit -w @nawara/audit-contract -w billing-service -w payment-service`.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const hex = (n: number) => randomBytes(n).toString('hex');
const UUID = '0b0b0b0b-0000-4000-8000-000000000001';
const NOWHERE_DB = (user: string, db: string) => `postgres://${user}:${hex(16)}@127.0.0.1:1/${db}`; // nothing listens there

/** Starts `node dist/main.js` and resolves with its exit code and output, or `null` as the code if it is still running after `ms`. */
function exitOf(cwd: string, env: Record<string, string | undefined>, ms = 20_000): Promise<{ code: number | null; output: string }> {
  const defined = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>; // `undefined` removes a setting
  return new Promise((resolve) => {
    const child = spawn('node', ['dist/main.js'], { cwd, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...defined }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (b: Buffer) => { output += b.toString('utf8'); });
    child.stderr.on('data', (b: Buffer) => { output += b.toString('utf8'); });
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, output }); }, ms);
    child.once('exit', (code) => { clearTimeout(t); resolve({ code, output }); });
  });
}

describeWithEnv('Core V2 S-INT G7: production refuses simulation (built Billing and Payment, NODE_ENV=production)', ['TEST_RABBITMQ_URL'], (env) => {
  const billingProduction = (port: number): Record<string, string> => ({
    NODE_ENV: 'production', PORT: String(port), DATABASE_URL: NOWHERE_DB('billing_app', 'billing'), RABBITMQ_URL: env.TEST_RABBITMQ_URL,
    BILLING_SUPPORTED_CURRENCIES: 'TND', AUTH_SERVICE_URL: 'http://127.0.0.1:9', PAYMENT_SERVICE_URL: 'http://127.0.0.1:9', PAYMENT_SERVICE_TOKEN: hex(32),
  });
  const paymentProduction = (port: number): Record<string, string> => ({
    NODE_ENV: 'production', PORT: String(port), DATABASE_URL: NOWHERE_DB('payment_app', 'payment'), RABBITMQ_URL: env.TEST_RABBITMQ_URL,
    AUTH_SERVICE_URL: 'http://127.0.0.1:9', ORGANIZATION_SERVICE_URL: 'http://127.0.0.1:9', ORGANIZATION_REFERENCE_TOKEN: hex(32),
  });
  const status = async (base: string, method: string, path: string) => (await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) })).status;

  describe('a valid production configuration boots with every simulation-only module unmounted', () => {
    it('billing-service: checkout, BIL-12, assistance, refunds, fraud holds, recovery, late settlements and reconciliation answer 404; B6 is mounted', async () => {
      const port = 13741;
      const base = `http://127.0.0.1:${port}`;
      const svc = spawnService('billing-prod', BILLING_DIR, billingProduction(port));
      try {
        await waitForHealth(`${base}/health`, 30_000).catch((e) => { throw new Error(`${String(e)}\n${svc.tail()}`); });
        const unmounted: Array<[string, string]> = [
          ['POST', '/billing/checkout/direct'],
          ['GET', `/billing/me/platforms/${UUID}/personal-subscriptions`],
          ['POST', '/billing/assistance-requests'],
          ['GET', `/billing/assistance-requests/${UUID}`],
          ['POST', '/billing/admin/refund-cases'],
          ['POST', '/billing/admin/fraud-holds'],
          ['GET', `/billing/recovery-obligations/${UUID}`],
          ['POST', `/billing/recovery-obligations/${UUID}/settlement`],
          ['POST', `/billing/admin/late-settlements/${UUID}/application`],
          ['GET', '/billing/admin/reconciliation-cases'],
        ];
        for (const [method, path] of unmounted) expect(await status(base, method, path), `${method} ${path}`).toBe(404);
        // a production contract of the same process is mounted: it refuses an anonymous caller, it is not missing
        expect(await status(base, 'GET', `/billing/users/u/platforms/${UUID}/products/${UUID}/entitlement`)).toBe(401);
      } finally {
        await svc.stop();
      }
    }, 60_000);

    it('payment-service: the simulation harness is unmounted (404) and the simulation provider is unknown to the webhook route (404); the payment read is mounted', async () => {
      const port = 13742;
      const base = `http://127.0.0.1:${port}`;
      const svc = spawnService('payment-prod', PAYMENT_DIR, paymentProduction(port));
      try {
        await waitForHealth(`${base}/health`, 30_000).catch((e) => { throw new Error(`${String(e)}\n${svc.tail()}`); });
        for (const [method, path] of [
          ['POST', `/payment/simulation/payments/${UUID}/attempts/${UUID}/outcomes`],
          ['POST', `/payment/simulation/payments/${UUID}/disputes`],
          ['POST', `/payment/simulation/refunds/${UUID}/outcomes`],
          ['POST', `/payment/simulation/commands/c-1/deliver`],
          ['POST', '/payment/webhooks/simulation'],
        ] as Array<[string, string]>) expect(await status(base, method, path), `${method} ${path}`).toBe(404);
        expect(await status(base, 'GET', `/payment/payments/${UUID}`)).toBe(401);
      } finally {
        await svc.stop();
      }
    }, 60_000);
  });

  describe('any simulation or test setting in production refuses to start', () => {
    it.each([
      ['PAYMENT_SIMULATION_PROVIDER=true', { PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SIMULATION_WEBHOOK_SECRET: hex(32) }, /PAYMENT_SIMULATION_PROVIDER must not be enabled when NODE_ENV=production/],
      ['PAYMENT_SIMULATION_WEBHOOK_SECRET alone', { PAYMENT_SIMULATION_WEBHOOK_SECRET: hex(32) }, /PAYMENT_SIMULATION_WEBHOOK_SECRET must not be configured when NODE_ENV=production/],
      ['PAYMENT_TEST_PROVIDER=true', { PAYMENT_TEST_PROVIDER: 'true' }, /PAYMENT_TEST_PROVIDER must not be enabled when NODE_ENV=production/],
      ['no broker (the in-memory bus)', { RABBITMQ_URL: undefined }, /RABBITMQ_URL is required in production/],
    ])('payment-service with %s: a non-zero exit before listening', async (_label, extra, message) => {
      const run = await exitOf(PAYMENT_DIR, { ...paymentProduction(13743), ...extra });
      expect(run.code, run.output).not.toBe(0);
      expect(run.code, run.output).not.toBeNull();
      expect(run.output).toMatch(message);
    }, 30_000);

    it.each([
      ['the fraud-hold simulation clients (Auth receipts, File)', { AUTH_SERVICE_TOKEN: hex(32), FILE_SERVICE_URL: 'http://127.0.0.1:9', FILE_SERVICE_TOKEN: hex(32) },
        /must not be configured when NODE_ENV=production/],
      ['no broker (the in-memory bus)', { RABBITMQ_URL: undefined }, /RABBITMQ_URL/],
    ])('billing-service with %s: a non-zero exit before listening', async (_label, extra, message) => {
      const run = await exitOf(BILLING_DIR, { ...billingProduction(13744), ...extra });
      expect(run.code, run.output).not.toBe(0);
      expect(run.code, run.output).not.toBeNull();
      expect(run.output).toMatch(message);
    }, 30_000);
  });
});
