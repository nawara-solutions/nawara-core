import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EVENT_NAME as KIT_EVENT_NAME } from '@nawara/service-kit';
import {
  ACTOR_TYPES, AUDIT_ACTIONS, AUDIT_CATALOG, AUDIT_CATEGORIES, AUDIT_CONTRACT_VERSION, AUDIT_OUTCOMES, CORE_PRODUCERS, USER_KINDS,
  actionsOwnedBy, validateAuditPayload,
} from '../src/index.js';
import { renderCatalogDocument } from '../src/catalog-doc.js';
import { CHANGE_KEY, CODE_VALUE, EVENT_NAME, MAX_ACTION_LENGTH, TYPE_CODE } from '../src/grammar.js';
import { isSecretShaped, isSensitiveKey } from '../src/sensitive.js';

const entries = [...AUDIT_CATALOG];

describe('catalog completeness (every action fully defined)', () => {
  it.each(entries)('%s has producer, category, version, actors, organization, resource, subject, outcomes, changes and purpose', (action, e) => {
    expect(Object.keys(e).sort()).toEqual(['actors', 'category', 'changes', 'organization', 'outcomes', 'producer', 'purpose', 'resource', 'since', 'subject']);
    expect(CORE_PRODUCERS).toContain(e.producer);
    expect(AUDIT_CATEGORIES).toContain(e.category);
    expect(e.since).toBe(1);
    expect(e.since).toBeLessThanOrEqual(AUDIT_CONTRACT_VERSION);
    const actorKinds = Object.keys(e.actors);
    expect(actorKinds.length).toBeGreaterThan(0);
    for (const k of actorKinds) expect(ACTOR_TYPES).toContain(k);
    if (e.actors.user) {
      expect(e.actors.user.length).toBeGreaterThan(0);
      for (const kind of e.actors.user) expect(USER_KINDS).toContain(kind);
    }
    if (e.actors.service !== undefined) expect(e.actors.service).toBe(true);
    if (e.actors.system) {
      expect(e.actors.system.length).toBeGreaterThan(0);
      for (const code of e.actors.system) expect(code).toMatch(TYPE_CODE);
    }
    expect(['required', 'none', 'optional', 'self', 'resource']).toContain(e.organization);
    expect(e.resource.length).toBeGreaterThan(0);
    for (const r of e.resource) expect(r).toMatch(TYPE_CODE);
    if (e.organization === 'self') expect(e.resource).toEqual(['organization']);
    if (e.organization === 'resource') expect(e.resource).toContain('organization');
    expect(['forbidden', 'required', 'optional']).toContain(e.subject.rule);
    if (e.subject.rule !== 'forbidden') expect(e.subject.type).toMatch(TYPE_CODE);
    expect(e.outcomes.length).toBeGreaterThan(0);
    for (const o of e.outcomes) expect(AUDIT_OUTCOMES).toContain(o);
    expect(Object.keys(e.changes).length).toBeLessThanOrEqual(8);
    for (const [k, s] of Object.entries(e.changes)) {
      expect(k).toMatch(CHANGE_KEY);
      expect(['code', 'uuid', 'boolean', 'integer', 'timestamp']).toContain(s.type);
      expect(['value', 'transition']).toContain(s.shape);
      expect(typeof s.required).toBe('boolean');
      if (s.type === 'code') {
        expect(s.values.length).toBeGreaterThan(s.shape === 'transition' ? 1 : 0);
        for (const v of s.values) expect(v).toMatch(CODE_VALUE);
      }
    }
    expect(e.purpose.length).toBeGreaterThan(10);
    expect(action.length).toBeLessThanOrEqual(MAX_ACTION_LENGTH);
  });

  it('is frozen: no runtime code can add, remove or edit an action', () => {
    const e = AUDIT_CATALOG.get('file.deleted')!;
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(e.actors)).toBe(true);
    expect(Object.isFrozen(e.changes)).toBe(true);
    expect(() => {
      (e as { producer: string }).producer = 'payment-service';
    }).toThrow(TypeError);
    expect(Object.isFrozen(AUDIT_ACTIONS)).toBe(true);
  });
});

describe('action names and event types', () => {
  it('the contract grammar IS the kit event-name grammar', () => {
    expect(EVENT_NAME.source).toBe(KIT_EVENT_NAME.source);
    expect(EVENT_NAME.flags).toBe(KIT_EVENT_NAME.flags);
  });

  it.each(AUDIT_ACTIONS)('%s is a valid kit event name, and so is audit.%s', (action) => {
    expect(action).toMatch(KIT_EVENT_NAME);
    expect(`audit.${action}`).toMatch(KIT_EVENT_NAME);
  });

  it('no action is itself in the audit. namespace (the event type adds it once)', () => {
    for (const a of AUDIT_ACTIONS) expect(a.startsWith('audit.')).toBe(false);
  });
});

describe('producer ownership (one canonical producer per action)', () => {
  it('each action is owned by exactly one service, and ownership partitions the catalog', () => {
    const owned = CORE_PRODUCERS.flatMap((p) => actionsOwnedBy(p));
    expect(owned.sort()).toEqual([...AUDIT_ACTIONS].sort());
    expect(new Set(owned).size).toBe(owned.length);
  });

  it('notification-service owns nothing (no privileged capability exists); audit-service owns only its platform-read record (18.6)', () => {
    expect(actionsOwnedBy('notification-service')).toEqual([]);
    expect(actionsOwnedBy('audit-service')).toEqual(['platform_query.executed']);
  });

  it('release-service owns its two automation actions (Stage 20.3): platform-level, a service actor only, never a user', () => {
    expect(actionsOwnedBy('release-service')).toEqual(['release.registered', 'release.published', 'release.withdrawn', 'compatibility_policy.changed']);
    for (const a of ['release.registered', 'release.published'] as const) {
      const e = AUDIT_CATALOG.get(a)!;
      expect(e).toMatchObject({ category: 'administrative', organization: 'none', resource: ['release'], actors: { service: true } });
      expect('user' in e.actors || 'system' in e.actors).toBe(false);
      // bounded facts only: identifiers and the closed kind; no version text, build id, revision, notes or product key
      expect(Object.keys(e.changes).sort()).toEqual(['component_id', 'kind', 'product_id']);
    }
  });

  it('release-service owns its two human administration actions (Stage 20.4): security, the verified OWNER only, never a service or system', () => {
    for (const a of ['release.withdrawn', 'compatibility_policy.changed'] as const) {
      const e = AUDIT_CATALOG.get(a)!;
      expect(e).toMatchObject({ category: 'security', organization: 'none', actors: { user: ['owner'] } });
      expect('service' in e.actors || 'system' in e.actors).toBe(false);
    }
    expect(AUDIT_CATALOG.get('release.withdrawn')!.resource).toEqual(['release']);
    const policy = AUDIT_CATALOG.get('compatibility_policy.changed')!;
    expect(policy.resource).toEqual(['component']);
    expect(Object.keys(policy.changes).sort()).toEqual(['kind', 'minimum_release_id', 'policy_version', 'previous_minimum_release_id', 'product_id']);
    expect((policy.changes.kind as { values: readonly string[] }).values).not.toContain('backend'); // a backend has no policy
  });

  it.each(entries)('%s: every other service is refused deterministically (producer_not_admitted)', (action, e) => {
    const other = ['auth-service', 'organization-service', 'billing-service', 'payment-service', 'file-service', 'notification-service', 'audit-service', 'release-service'];
    for (const source of other.filter((s) => s !== e.producer)) {
      expect(() => validateAuditPayload({ action }, source)).toThrow('producer_not_admitted');
    }
  });
});

describe('the catalog cannot itself carry sensitive data', () => {
  it('no change key names a sensitive concept, and no payload field name does', () => {
    for (const [, e] of entries) for (const k of Object.keys(e.changes)) expect(isSensitiveKey(k), k).toBe(false);
    for (const k of ['action', 'actor', 'organizationId', 'resource', 'subject', 'outcome', 'changes', 'causationId', 'type', 'id', 'userKind', 'from', 'to']) {
      expect(isSensitiveKey(k), k).toBe(false);
    }
  });

  it('no enumerated value, process code, resource or subject type is secret-shaped', () => {
    for (const [, e] of entries) {
      for (const s of Object.values(e.changes)) if (s.type === 'code') for (const v of s.values) expect(isSecretShaped(v), v).toBe(false);
      for (const code of e.actors.system ?? []) expect(isSecretShaped(code)).toBe(false);
      for (const r of e.resource) expect(isSecretShaped(r)).toBe(false);
    }
  });

  it('no change key is an identity or contact attribute (PII minimization, A30)', () => {
    const pii = /name|email|phone|address|ip|agent|birth|contact/;
    for (const [, e] of entries) for (const k of Object.keys(e.changes)) expect(k).not.toMatch(pii);
  });
});

describe('the catalog document is generated from this catalog', () => {
  it('docs/architecture/audit-event-catalog.md equals the rendered catalog (regenerate with npm run catalog:doc)', () => {
    const file = readFileSync(resolve(__dirname, '../../../docs/architecture/audit-event-catalog.md'), 'utf8');
    expect(file).toBe(renderCatalogDocument());
  });

  it('lists every action exactly once', () => {
    const doc = renderCatalogDocument();
    for (const a of AUDIT_ACTIONS) expect(doc.split(`| \`${a}\` |`).length - 1).toBe(1);
  });
});
