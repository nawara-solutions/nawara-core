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

describe('service boundary (static)', () => {
  it('has source to inspect', () => expect(shipped.length).toBeGreaterThan(10));

  it('makes no outbound call and has no Auth dependency: no fetch, no HTTP client, no Auth client, no broker, no events', () => {
    const forbidden = /\bfetch\(|\bHttpAuthClient\b|\bAuthClient\b|\bAUTH_SERVICE_URL\b|\bamqplib\b|\bEventsModule\b|\bOutboxService\b|\bInboxService\b|\bRabbitMq|\baxios\b|node:https?['"]|\bgot\(/;
    for (const f of shipped) expect(code(f), f).not.toMatch(forbidden);
  });

  it('never reads a user token: no user-guard, no JWT handling, no identity or membership lookups', () => {
    for (const f of shipped) expect(identifiers(f), f).not.toMatch(/\bgetIdentity\b|\bhasPlatformAccess\b|jsonwebtoken|\bJwtService\b|\bmemberships?\b/i);
  });

  it('contains no migration, import or cutover machinery (ADR-0039 Phases A-E belong to a later stage)', () => {
    for (const f of shipped) expect(code(f), f).not.toMatch(/\b(bootstrap-?import|importFromAuth|cutover|write-?freeze|authority[_-]?record|reconcil)/i);
  });

  it('introduces no invented hierarchy entity', () => {
    for (const f of shipped) expect(code(f), f).not.toMatch(/\b(Tenant|Workspace|BusinessUnit|Department)\b/);
  });

  it('every controller is guarded by the service-token guard (deny by default)', () => {
    const controllers = shipped.filter((f) => f.endsWith('.controller.ts'));
    expect(controllers).toHaveLength(3);
    for (const f of controllers) expect(code(f), f).toMatch(/@UseGuards\(ServiceTokenGuard\)\s*\n@Controller\(/);
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
