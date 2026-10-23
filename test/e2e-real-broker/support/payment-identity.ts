import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import amqp, { type ChannelModel, type ConsumeMessage } from 'amqplib';

/**
 * Core V2 S1e-2 (ADR-0057 §13.1, §13.5, "S0-C5", "S0-C6"): Billing processes a Payment event only when the BROKER says it came from
 * Payment: an original delivery whose AMQP `user_id` is the authenticated broker user `payment-service`. These suites therefore run the real
 * Payment process (and publish every GENUINE Payment message) as a disposable broker user named `payment-service`, created through the
 * management API for one test file and deleted at its end. Its permissions are Payment's own: the producer role of
 * `infra/rabbitmq/provision.sh` (configure and write `nawara.events`, read nothing) and the topic grant the S1d-1 generator computes from
 * the repository's event contracts, audit catalog and reviewed activation file: never `^audit\.`, `.*` or another shortcut. A user of that
 * name that already exists is never overwritten (the suite refuses to start). Its password is random and never printed. The test's own
 * `guest` connection stays what it always was: an identity Billing must NOT trust for Payment events.
 */
export const PAYMENT_USER = 'payment-service';
const EXCHANGE = 'nawara.events';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Payment's generated topic-write grant (and its deny-all read), from the same generator `provision.sh` is checked against. */
async function paymentTopicGrant(): Promise<{ write: string; read: string }> {
  const tp = (await import(new URL('../../../scripts/lib/topic-permissions.mjs', import.meta.url).href)) as {
    generateTopicPermissions(input: unknown): { identities: Record<string, { write: { regex: string }; read: { regex: string } }> };
  };
  const apps = readdirSync(join(ROOT, 'apps'));
  const contracts = Object.fromEntries(apps.filter((a) => existsSync(join(ROOT, 'apps', a, 'contracts/events.json'))).map((a) => [a, readFileSync(join(ROOT, 'apps', a, 'contracts/events.json'), 'utf8')]));
  const out = tp.generateTopicPermissions({
    apps, contracts, auditCatalog: readFileSync(join(ROOT, 'libs/audit-contract/src/catalog.ts'), 'utf8'),
    activation: JSON.parse(readFileSync(join(ROOT, 'infra/rabbitmq/topic-activation.json'), 'utf8')),
  });
  const grant = out.identities[PAYMENT_USER]!;
  return { write: grant.write.regex, read: grant.read.regex };
}

export interface PaymentIdentity {
  /** `base` (a broker URL, e.g. the test broker or a test proxy) authenticated as `payment-service`. Never logged. */
  url(base: string): string;
  /** Publishes one message to `nawara.events` on a confirm channel authenticated as `payment-service`, with `user_id` = that user. */
  publish(routingKey: string, content: Buffer, properties: Record<string, unknown>): Promise<void>;
  /** Re-publishes a CAPTURED message byte for byte (content, message id, type, headers, timestamp) as Payment: a genuine redelivery. */
  redeliver(message: CapturedMessage): Promise<void>;
  remove(): Promise<void>;
}

export async function createPaymentIdentity(env: { TEST_RABBITMQ_URL: string; TEST_RABBITMQ_MGMT_URL: string }): Promise<PaymentIdentity> {
  const mgmt = new URL(env.TEST_RABBITMQ_MGMT_URL);
  const auth = `Basic ${Buffer.from(`${decodeURIComponent(mgmt.username)}:${decodeURIComponent(mgmt.password)}`).toString('base64')}`;
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${mgmt.origin}/api${path}`, { method, headers: { authorization: auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const vhost = encodeURIComponent(decodeURIComponent(new URL(env.TEST_RABBITMQ_URL).pathname.slice(1)) || '/');
  const existing = await api('GET', `/users/${PAYMENT_USER}`);
  if (existing.status !== 404) throw new Error(`a broker user named ${PAYMENT_USER} already exists on the test broker; refusing to overwrite it`);
  const password = randomBytes(24).toString('hex');
  const grant = await paymentTopicGrant();
  const ok = async (r: Promise<Response>, what: string) => {
    const res = await r;
    if (!res.ok) throw new Error(`management API: ${what} failed (${res.status})`);
  };
  await ok(api('PUT', `/users/${PAYMENT_USER}`, { password, tags: '' }), 'create the payment-service user');
  try {
    // the producer role of provision.sh: declare and publish to the event exchange, consume nothing
    await ok(api('PUT', `/permissions/${vhost}/${PAYMENT_USER}`, { configure: '^nawara\\.events$', write: '^nawara\\.events$', read: '^$' }), 'set its resource permissions');
    await ok(api('PUT', `/topic-permissions/${vhost}/${PAYMENT_USER}`, { exchange: EXCHANGE, write: grant.write, read: grant.read }), 'set its generated topic grant');
  } catch (e) {
    await api('DELETE', `/users/${PAYMENT_USER}`);
    throw e;
  }
  const url = (base: string) => {
    const u = new URL(base);
    u.username = PAYMENT_USER;
    u.password = password;
    return u.toString();
  };
  const publish = async (routingKey: string, content: Buffer, properties: Record<string, unknown>) => {
    const conn = await amqp.connect(url(env.TEST_RABBITMQ_URL));
    try {
      const ch = await conn.createConfirmChannel();
      ch.publish(EXCHANGE, routingKey, content, { persistent: true, contentType: 'application/json', ...properties, userId: PAYMENT_USER });
      await ch.waitForConfirms();
      await ch.close();
    } finally {
      await conn.close().catch(() => undefined);
    }
  };
  return {
    url,
    publish,
    redeliver: (m) => publish(m.routingKey, m.content, { messageId: m.messageId, type: m.type, headers: m.headers, timestamp: m.timestamp, contentType: m.contentType }),
    remove: async () => void (await api('DELETE', `/users/${PAYMENT_USER}`)),
  };
}

export interface CapturedMessage {
  routingKey: string;
  content: Buffer;
  messageId: string;
  type: string;
  headers: Record<string, unknown>;
  timestamp: number | undefined;
  contentType: string | undefined;
  userId: string | undefined;
}

/**
 * A capture of every `payment.*` message the broker routes (an exclusive queue on the test connection), so a test can redeliver the
 * EXACT message Payment published, as at-least-once delivery does. Binding needs no topic grant for the test's own connection.
 */
export async function tapPaymentEvents(conn: ChannelModel): Promise<{ take(messageId: string, ms?: number): Promise<CapturedMessage>; close(): Promise<void> }> {
  const ch = await conn.createChannel();
  await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
  const { queue } = await ch.assertQueue('', { exclusive: true, autoDelete: true });
  await ch.bindQueue(queue, EXCHANGE, 'payment.#');
  const seen = new Map<string, CapturedMessage>();
  await ch.consume(queue, (m: ConsumeMessage | null) => {
    if (!m) return;
    seen.set(String(m.properties.messageId), {
      routingKey: m.fields.routingKey, content: m.content, messageId: String(m.properties.messageId), type: String(m.properties.type),
      headers: (m.properties.headers ?? {}) as Record<string, unknown>, timestamp: m.properties.timestamp as number | undefined,
      contentType: m.properties.contentType as string | undefined, userId: m.properties.userId as string | undefined,
    });
  }, { noAck: true });
  return {
    take: async (messageId, ms = 20_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const m = seen.get(messageId);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`the ${messageId} message was not captured`);
    },
    close: async () => void (await ch.close().catch(() => undefined)),
  };
}
