import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import amqp from 'amqplib';

/**
 * Core V2 S0-C14 WP D (item 7): the REAL `billing-service` broker identity for one test file: a disposable user created through the management
 * API with exactly `infra/rabbitmq/provision.sh`'s `producer_consumer billing.payment-events` resource permissions and the topic grant the S1d-1
 * generator computes from the repository's event contracts, audit catalog and activation file (the generated block of provision.sh). Never
 * `guest`, never `.*`. A user of that name that already exists is never overwritten. Its password is random and never printed.
 */
export const BILLING_USER = 'billing-service';
const EXCHANGE = 'nawara.events';
const QUEUE = 'billing.payment-events';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

async function billingTopicGrant(): Promise<{ write: string; read: string; writeKeys: string[] }> {
  const tp = (await import(new URL('../../../scripts/lib/topic-permissions.mjs', import.meta.url).href)) as {
    generateTopicPermissions(input: unknown): { identities: Record<string, { write: { regex: string; keys: string[] }; read: { regex: string } }> };
  };
  const apps = readdirSync(join(ROOT, 'apps'));
  const contracts = Object.fromEntries(apps.filter((a) => existsSync(join(ROOT, 'apps', a, 'contracts/events.json'))).map((a) => [a, readFileSync(join(ROOT, 'apps', a, 'contracts/events.json'), 'utf8')]));
  const out = tp.generateTopicPermissions({
    apps, contracts, auditCatalog: readFileSync(join(ROOT, 'libs/audit-contract/src/catalog.ts'), 'utf8'),
    activation: JSON.parse(readFileSync(join(ROOT, 'infra/rabbitmq/topic-activation.json'), 'utf8')),
  });
  const g = out.identities[BILLING_USER]!;
  return { write: g.write.regex, read: g.read.regex, writeKeys: g.write.keys };
}

export interface BillingIdentity {
  url(base: string): string;
  /** The generated write keys (what the identity may publish). */
  writeKeys: string[];
  /** Publishes on a confirm channel as `billing-service`: resolves `published`, or `refused` when the broker closes the channel (ACCESS_REFUSED). */
  tryPublish(routingKey: string): Promise<'published' | 'refused'>;
  remove(): Promise<void>;
}

export async function createBillingIdentity(env: { TEST_RABBITMQ_URL: string; TEST_RABBITMQ_MGMT_URL: string }): Promise<BillingIdentity> {
  const mgmt = new URL(env.TEST_RABBITMQ_MGMT_URL);
  const auth = `Basic ${Buffer.from(`${decodeURIComponent(mgmt.username)}:${decodeURIComponent(mgmt.password)}`).toString('base64')}`;
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${mgmt.origin}/api${path}`, { method, headers: { authorization: auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const vhost = encodeURIComponent(decodeURIComponent(new URL(env.TEST_RABBITMQ_URL).pathname.slice(1)) || '/');
  if ((await api('GET', `/users/${BILLING_USER}`)).status !== 404) throw new Error(`a broker user named ${BILLING_USER} already exists on the test broker; refusing to overwrite it`);
  const password = randomBytes(24).toString('hex');
  const grant = await billingTopicGrant();
  const ok = async (r: Promise<Response>, what: string) => {
    const res = await r;
    if (!res.ok) throw new Error(`management API: ${what} failed (${res.status})`);
  };
  // provision.sh `producer_consumer billing.payment-events`, character for character (consumer(), then the producer's write on the exchange)
  const x = EXCHANGE.replace(/\./g, '\\.');
  const q = QUEUE.replace(/\./g, '\\.');
  const conf = `^(${x}|${x}\\.dlx|${q}|${q}\\.retry|${q}\\.dead)$`;
  const write = `^(amq\\.default|${x}|${x}\\.dlx|${q}|${q}\\.retry|${q}\\.dead)$`;
  await ok(api('PUT', `/users/${BILLING_USER}`, { password, tags: '' }), 'create the billing-service user');
  try {
    await ok(api('PUT', `/permissions/${vhost}/${BILLING_USER}`, { configure: conf, write, read: conf }), 'set its resource permissions');
    await ok(api('PUT', `/topic-permissions/${vhost}/${BILLING_USER}`, { exchange: EXCHANGE, write: grant.write, read: grant.read }), 'set its generated topic grant');
  } catch (e) {
    await api('DELETE', `/users/${BILLING_USER}`);
    throw e;
  }
  const url = (base: string) => {
    const u = new URL(base);
    u.username = BILLING_USER;
    u.password = password;
    return u.toString();
  };
  return {
    url,
    writeKeys: grant.writeKeys,
    async tryPublish(routingKey: string) {
      const conn = await amqp.connect(url(env.TEST_RABBITMQ_URL));
      conn.on('error', () => undefined);
      try {
        const ch = await conn.createConfirmChannel();
        let closed = false;
        ch.on('error', () => { closed = true; });
        ch.on('close', () => { closed = true; });
        try {
          ch.publish(EXCHANGE, routingKey, Buffer.from('{}'), { persistent: false, contentType: 'application/json', userId: BILLING_USER });
          await ch.waitForConfirms();
        } catch {
          return 'refused';
        }
        await new Promise((r) => setTimeout(r, 300));
        if (closed) return 'refused';
        await ch.close().catch(() => undefined);
        return 'published';
      } finally {
        await conn.close().catch(() => undefined);
      }
    },
    async remove() {
      await api('DELETE', `/users/${BILLING_USER}`);
    },
  };
}
