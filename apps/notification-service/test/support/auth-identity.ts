import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * TEST ONLY (Core V2 S1e-4, ADR-0057 §13.1, "S0-C6"): Notification processes an Auth event only when the BROKER says it came from Auth (an
 * original delivery whose AMQP `user_id` is the authenticated broker user `auth-service`). Suites that publish genuine Auth events over a
 * real broker therefore publish as a disposable broker user named `auth-service`, created through the management API for one test file
 * and deleted at its end. Its permissions are Auth's own: the producer role of `infra/rabbitmq/provision.sh` (configure and write
 * `nawara.events`, read nothing) and the topic grant the S1d-1 generator computes from the repository's event contracts, audit catalog and
 * reviewed activation file, with Auth's domain events ACTIVATED in memory (the reviewed production file keeps them inactive until S1-R;
 * that activation is exactly the grant Notification's first production activation requires). Never `.*` or another shortcut. A user of
 * that name that already exists is never overwritten (the suite refuses to start); its password is random and never printed.
 */
export const AUTH_USER = 'auth-service';
const EXCHANGE = 'nawara.events';
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

async function authTopicGrant(): Promise<{ write: string; read: string }> {
  const tp = (await import(new URL('../../../../scripts/lib/topic-permissions.mjs', import.meta.url).href)) as {
    generateTopicPermissions(input: unknown): { identities: Record<string, { write: { regex: string }; read: { regex: string } }> };
  };
  const apps = readdirSync(join(ROOT, 'apps'));
  const contracts = Object.fromEntries(apps.filter((a) => existsSync(join(ROOT, 'apps', a, 'contracts/events.json'))).map((a) => [a, readFileSync(join(ROOT, 'apps', a, 'contracts/events.json'), 'utf8')]));
  const activation = JSON.parse(readFileSync(join(ROOT, 'infra/rabbitmq/topic-activation.json'), 'utf8')) as { domainEvents: Record<string, string> };
  const out = tp.generateTopicPermissions({
    apps, contracts, auditCatalog: readFileSync(join(ROOT, 'libs/audit-contract/src/catalog.ts'), 'utf8'),
    activation: { ...activation, domainEvents: { ...activation.domainEvents, [AUTH_USER]: 'active' } },
  });
  const grant = out.identities[AUTH_USER]!;
  return { write: grant.write.regex, read: grant.read.regex };
}

export interface AuthIdentity {
  /** `base` (a broker URL) authenticated as `auth-service`. Never logged. */
  url(base: string): string;
  remove(): Promise<void>;
}

export async function createAuthIdentity(env: { TEST_RABBITMQ_URL: string; TEST_RABBITMQ_MGMT_URL: string }): Promise<AuthIdentity> {
  const mgmt = new URL(env.TEST_RABBITMQ_MGMT_URL);
  const auth = `Basic ${Buffer.from(`${decodeURIComponent(mgmt.username)}:${decodeURIComponent(mgmt.password)}`).toString('base64')}`;
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${mgmt.origin}/api${path}`, { method, headers: { authorization: auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const vhost = encodeURIComponent(decodeURIComponent(new URL(env.TEST_RABBITMQ_URL).pathname.slice(1)) || '/');
  const existing = await api('GET', `/users/${AUTH_USER}`);
  if (existing.status !== 404) throw new Error(`a broker user named ${AUTH_USER} already exists on the test broker; refusing to overwrite it`);
  const password = randomBytes(24).toString('hex');
  const grant = await authTopicGrant();
  const ok = async (r: Promise<Response>, what: string) => {
    const res = await r;
    if (!res.ok) throw new Error(`management API: ${what} failed (${res.status})`);
  };
  await ok(api('PUT', `/users/${AUTH_USER}`, { password, tags: '' }), 'create the auth-service user');
  try {
    await ok(api('PUT', `/permissions/${vhost}/${AUTH_USER}`, { configure: '^nawara\\.events$', write: '^nawara\\.events$', read: '^$' }), 'set its resource permissions');
    await ok(api('PUT', `/topic-permissions/${vhost}/${AUTH_USER}`, { exchange: EXCHANGE, write: grant.write, read: grant.read }), 'set its generated topic grant');
  } catch (e) {
    await api('DELETE', `/users/${AUTH_USER}`);
    throw e;
  }
  return {
    url: (base) => {
      const u = new URL(base);
      u.username = AUTH_USER;
      u.password = password;
      return u.toString();
    },
    remove: async () => void (await api('DELETE', `/users/${AUTH_USER}`)),
  };
}
