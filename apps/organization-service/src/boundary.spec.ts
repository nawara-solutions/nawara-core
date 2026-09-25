import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static guards for the ADR-0039 boundary of THIS stage (organization-service is implemented but not yet authoritative). They read the
 * shipped source (not the tests) and fail if the service grows a dependency or capability that belongs to a later stage or to
 * another service. `scripts/check-repo.mjs` additionally forbids importing another service's source and product-specific terms.
 */
const srcDir = fileURLToPath(new URL('.', import.meta.url));
const migrationsDir = join(srcDir, '../db/migrations');

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}
const shipped = [...files(srcDir)].filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** Code with string literals blanked, for checks about identifiers (documentation text may legitimately say "membership"). */
const identifiers = (f: string) => code(f).replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");

// Stage 10.1 (ADR-0040, accepted) adds the ownership-transition machinery. It is allowed ONLY in the ownership module and its CLI;
// everywhere else (controllers, repositories, the API surface) the original Stage-9 prohibition still holds.
const isOwnership = (f: string) => f.includes('/ownership/') || f.endsWith('/cli/ownership.ts');
// ADR-0042 decision 6 / Amendment 1: the human-admin module is the ONE bounded exception to "no Auth dependency, no
// user-token handling" — it forwards a caller's OWN bearer to Auth's /auth/grants and /auth/step-up/verify, and only
// there. Everywhere else in this service (every other controller, repository, the reference/ownership surfaces) the
// original Stage-9 prohibition still holds, exactly as it already does for the ownership module above. The one file
// outside `admin/` that legitimately names `AUTH_SERVICE_URL` is the shared config loader (it stores the URL string;
// it makes no outbound call and imports no HTTP client — the admin module's own file-count assertion below still
// requires the real client/guard/controller files to live under `admin/`).
const isAdmin = (f: string) => f.includes('/admin/') || f.endsWith('/config/organization-config.ts');
// Stage 18.7.3 (ADR-0049): the central audit intent is the ONE use of events. The kit outbox, relay and RabbitMQ bus live ONLY in
// `audit/` (and the config loader names the broker URL); the outbound-call and Auth prohibitions still hold there. There are still
// no organization domain events.
const isAudit = (f: string) => f.includes('/audit/') || f.endsWith('/config/organization-config.ts');

describe('service boundary (static)', () => {
  it('has source to inspect', () => expect(shipped.length).toBeGreaterThan(10));

  it('makes no outbound call and has no Auth dependency outside admin/: no fetch, no HTTP client, no Auth client', () => {
    const forbidden = /\bfetch\(|\bHttpAuthClient\b|\bAuthClient\b|\bAUTH_SERVICE_URL\b|\baxios\b|node:https?['"]|\bgot\(/;
    for (const f of shipped.filter((x) => !isAdmin(x))) expect(code(f), f).not.toMatch(forbidden);
  });

  it('touches the broker, the outbox and the relay ONLY in audit/ (the central audit intent), never consumes events, and nowhere else', () => {
    const events = /\bamqplib\b|\bEventsModule\b|\bOutboxService\b|\bOutboxRelayService\b|\bRabbitMq/;
    for (const f of shipped.filter((x) => !isAudit(x))) expect(code(f), f).not.toMatch(events);
    for (const f of shipped) expect(code(f), f).not.toMatch(/\bInboxService\b|\bsubscribe\(/);
    const audit = shipped.filter((f) => f.includes('/audit/'));
    expect(audit).toHaveLength(1);
    // Only the audit writer enqueues: no organization domain event is ever published.
    expect(code(audit[0]!)).not.toMatch(/\.enqueue\(/);
  });

  it('admin/ is the only module with an outbound Auth dependency, and it never imports a service-token concept (it authenticates a HUMAN bearer, never a service credential)', () => {
    const admin = shipped.filter(isAdmin);
    expect(admin.length).toBeGreaterThan(3);
    for (const f of admin) expect(code(f), f).not.toMatch(/\bServiceTokenGuard\b|\bServicePolicyGuard\b|\bRequireCapability\b|\bCallerService\b/);
  });

  it('never reads a user token outside admin/: no user-guard, no JWT handling, no identity or membership lookups', () => {
    for (const f of shipped.filter((x) => !isAdmin(x))) expect(identifiers(f), f).not.toMatch(/\bgetIdentity\b|\bhasPlatformAccess\b|jsonwebtoken|\bJwtService\b|\bmemberships?\b/i);
  });

  it('contains no migration, import or cutover machinery outside the ownership module and its CLI', () => {
    for (const f of shipped.filter((x) => !isOwnership(x))) expect(code(f), f).not.toMatch(/\b(bootstrap-?import|importFromAuth|cutover|write-?freeze|authority[_-]?record|reconcil)/i);
  });

  it('the ownership module transfers nothing by pg_dump, fdw or dblink, deletes nothing, and never UPDATEs a hierarchy row', () => {
    const own = shipped.filter(isOwnership);
    expect(own.length).toBeGreaterThan(3);
    for (const f of own) expect(code(f), f).not.toMatch(/pg_dump|postgres_fdw|\bdblink\b|\bDELETE\s+FROM\b|\bTRUNCATE\b|\bUPDATE\s+(company|platform|organization)\b/i);
  });

  it('no runtime code path can change the ownership state: only the admin operations and the CLI write the ownership tables', () => {
    for (const f of shipped.filter((x) => !x.endsWith('/ownership/ownership-admin.ts') && !x.endsWith('/cli/ownership.ts'))) {
      expect(code(f), f).not.toMatch(/\bUPDATE\s+ownership_state\b|\bINSERT\s+INTO\s+ownership_(event|import_run)\b|\bOwnershipAdmin\b/i);
    }
  });

  it('introduces no invented hierarchy entity', () => {
    for (const f of shipped) expect(code(f), f).not.toMatch(/\b(Tenant|Workspace|BusinessUnit|Department)\b/);
  });

  it('every SERVICE-TOKEN controller is guarded by the token guard AND the policy guard (deny by default), and every route declares its capability', () => {
    const controllers = shipped.filter((f) => f.endsWith('.controller.ts') && !isAdmin(f));
    expect(controllers).toHaveLength(4);
    for (const f of controllers) {
      const c = code(f);
      expect(c, f).toMatch(/@UseGuards\(ServiceTokenGuard, ServicePolicyGuard\)\s*\n@Controller\(/);
      const routes = (c.match(/^\s*@(Get|Post|Patch|Put|Delete)\(/gm) ?? []).length;
      const declared = (c.match(/^\s*@RequireCapability\(/gm) ?? []).length;
      expect(routes, f).toBeGreaterThan(0);
      expect(declared, `${f}: every route must declare the ONE capability it needs`).toBe(routes);
    }
  });

  it('the admin controller is guarded by HumanAuthGuard ONLY (never the service-token guards) — it is a human-bearer surface, not a service-token one', () => {
    const controllers = shipped.filter((f) => f.endsWith('.controller.ts') && isAdmin(f));
    expect(controllers).toHaveLength(1);
    for (const f of controllers) {
      const c = code(f);
      expect(c, f).toMatch(/@UseGuards\(HumanAuthGuard\)\s*\n@Controller\(/);
      expect((c.match(/^\s*@(Get|Post|Patch|Put|Delete)\(/gm) ?? []).length, f).toBeGreaterThan(0);
    }
  });

  it('no SQL statement in the shipped code names another service\'s tables, and no migration references another database', () => {
    const otherServices = /\b(FROM|JOIN|INTO|UPDATE)\s+"?(user|owner|operator|refresh_token|organization_membership|invoice|payment|product|price|license)\b/i;
    for (const f of shipped) expect(code(f), f).not.toMatch(otherServices);
    for (const m of readdirSync(migrationsDir)) {
      const text = readFileSync(join(migrationsDir, m), 'utf8').replace(/--.*$/gm, '');
      expect(text, m).not.toMatch(/\b(dblink|postgres_fdw|CREATE\s+SERVER|CREATE\s+EXTENSION|REFERENCES\s+auth\b)/i);
    }
  });
});
