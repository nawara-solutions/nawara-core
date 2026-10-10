import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTOR_TYPES, AUDIT_ACTIONS, AUDIT_CATALOG, AUDIT_CATEGORIES, AUDIT_CONTRACT_VERSION, AUDIT_OUTCOMES, CORE_PRODUCERS,
  SUPPORTED_AUDIT_VERSIONS, USER_KINDS, validateAuditPayload,
} from '../src/index.js';
import { mayRetainRefusedAuditBody, validateAuditEvent } from '../src/consumer.js';
import { SAMPLE_IDS } from '../src/testing.js';

/**
 * A5.4-AC1, first batch (docs/architecture/core-v2-a5-4-ac1-repair-audit-contract.md): two producer-less ADR-0061 reference-repair
 * actions, added consumer-first. These tests pin that the change is additive only: the 54 earlier entries and every contract constant
 * are exactly as before, the two new entries accept precisely the decided shapes, and no application emits them yet.
 */
type P = Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));
const BEFORE: Record<string, unknown> = JSON.parse(readFileSync(join(here, 'support/catalog-before-ac1.json'), 'utf8'));
const REPAIRED = 'hierarchy.reference_repaired';
const DENIED = 'hierarchy.reference_repair_denied';
const ID = SAMPLE_IDS.resource;
const user = (userKind: string) => ({ type: 'user', id: SAMPLE_IDS.user, userKind });

const repaired = (over: P = {}): P => ({
  action: REPAIRED, actor: user('owner'), organizationId: null, resource: { type: 'platform', id: ID }, outcome: 'succeeded',
  changes: { placed: true }, ...over,
});
const denied = (over: P = {}): P => ({
  action: DENIED, actor: user('member'), organizationId: null, resource: { type: 'organization', id: ID }, outcome: 'denied',
  changes: { reason: 'no_authority' }, ...over,
});
const valid = (p: P) => () => validateAuditPayload(p, 'auth-service');

describe('A5.4-AC1: additive only', () => {
  it('the 54 earlier entries are exactly as they were (snapshot taken from main before AC1)', () => {
    expect(Object.keys(BEFORE)).toHaveLength(54);
    for (const [action, entry] of Object.entries(BEFORE)) expect(JSON.parse(JSON.stringify(AUDIT_CATALOG.get(action as never))), action).toEqual(entry);
  });

  it('batch 1 added exactly the two reference-repair actions to the 54 (batch 2 adds two more: reference-repair-batch2.spec.ts)', () => {
    const BATCH2 = ['hierarchy.reference_anchor_mismatch_detected', 'hierarchy.reference_repair_unresolved'];
    expect(AUDIT_ACTIONS.filter((a) => !(a in BEFORE) && !BATCH2.includes(a)).sort()).toEqual([DENIED, REPAIRED]);
  });

  it('no contract constant changes: version, supported versions, user kinds, outcomes, actor types, categories, producers', () => {
    expect(AUDIT_CONTRACT_VERSION).toBe(1);
    expect(SUPPORTED_AUDIT_VERSIONS).toEqual([1]);
    expect(USER_KINDS).toEqual(['member', 'owner', 'operator']);
    expect(AUDIT_OUTCOMES).toEqual(['succeeded', 'denied']);
    expect(ACTOR_TYPES).toEqual(['user', 'service', 'system']);
    expect(AUDIT_CATEGORIES).toEqual(['security', 'business', 'commercial', 'administrative']);
    expect(CORE_PRODUCERS).toEqual(['auth-service', 'organization-service', 'billing-service', 'payment-service', 'file-service', 'audit-service', 'release-service']);
  });

  it('both actions are owned by auth-service, in the security category, introduced in contract version 1', () => {
    for (const a of [REPAIRED, DENIED] as const) {
      const e = AUDIT_CATALOG.get(a)!;
      expect([e.producer, e.category, e.since], a).toEqual(['auth-service', 'security', 1]);
    }
  });
});

describe(`${REPAIRED}`, () => {
  it('accepts placed true and placed false (a placement and an already-present reference are the same action)', () => {
    for (const placed of [true, false]) expect(validateAuditPayload(repaired({ changes: { placed } }), 'auth-service').changes).toEqual({ placed });
  });

  it('organizationId is the resource id for an Organization, and null for a Company or a Platform', () => {
    expect(validateAuditPayload(repaired({ resource: { type: 'organization', id: ID }, organizationId: ID }), 'auth-service').organizationId).toBe(ID);
    expect(valid(repaired({ resource: { type: 'organization', id: ID }, organizationId: null }))).toThrow('invalid_organization');
    expect(valid(repaired({ resource: { type: 'organization', id: ID }, organizationId: SAMPLE_IDS.organization }))).toThrow('invalid_organization');
    for (const type of ['company', 'platform']) {
      expect(validateAuditPayload(repaired({ resource: { type, id: ID } }), 'auth-service').organizationId, type).toBeNull();
      expect(valid(repaired({ resource: { type, id: ID }, organizationId: ID })), type).toThrow('invalid_organization');
    }
  });

  it('only a verified owner may be the actor', () => {
    for (const k of ['member', 'operator', 'steward', 'admin']) expect(valid(repaired({ actor: user(k) })), k).toThrow('invalid_actor');
    expect(valid(repaired({ actor: { type: 'service', id: 'auth-service' } }))).toThrow('invalid_actor');
    expect(valid(repaired({ actor: { type: 'system', id: 'reference_repair' } }))).toThrow('invalid_actor');
  });

  it('refuses another outcome, a missing or non-boolean placed, extra metadata, a subject and another resource type', () => {
    expect(valid(repaired({ outcome: 'denied' }))).toThrow('invalid_outcome');
    expect(valid(repaired({ outcome: 'failed' }))).toThrow('invalid_outcome');
    expect(valid(repaired({ changes: undefined }))).toThrow();
    expect(valid(repaired({ changes: { placed: 'true' } }))).toThrow('invalid_changes');
    expect(valid(repaired({ changes: { placed: true, reason: 'no_authority' } }))).toThrow('invalid_changes');
    expect(valid(repaired({ subject: { type: 'user', id: SAMPLE_IDS.subject } }))).toThrow('invalid_subject');
    expect(valid(repaired({ resource: { type: 'user', id: ID } }))).toThrow('invalid_resource');
  });
});

describe(`${DENIED}`, () => {
  it('accepts each verified user kind with each of the two reasons, for each resource type', () => {
    for (const k of ['member', 'owner', 'operator']) {
      for (const reason of ['no_authority', 'step_up_required']) {
        for (const type of ['company', 'platform', 'organization']) {
          expect(valid(denied({ actor: user(k), resource: { type, id: ID }, changes: { reason } })), `${k} ${reason} ${type}`).not.toThrow();
        }
      }
    }
  });

  it('never names an organization: organizationId must be present and null, even for an Organization resource', () => {
    expect(valid(denied({ organizationId: ID }))).toThrow('invalid_organization');
    const { organizationId: _, ...missing } = denied();
    expect(valid(missing)).toThrow('invalid_organization');
  });

  it('refuses another reason, another outcome, a steward or non-user actor, extra metadata and a subject', () => {
    for (const reason of ['not_found', 'other_company', 'No_Authority', 'rate_limited']) expect(valid(denied({ changes: { reason } })), reason).toThrow('invalid_changes');
    expect(valid(denied({ changes: { reason: 'no_authority', placed: false } }))).toThrow('invalid_changes');
    expect(valid(denied({ outcome: 'succeeded' }))).toThrow('invalid_outcome');
    expect(valid(denied({ actor: user('steward') }))).toThrow('invalid_actor');
    expect(valid(denied({ actor: { type: 'service', id: 'auth-service' } }))).toThrow('invalid_actor');
    expect(valid(denied({ subject: { type: 'user', id: SAMPLE_IDS.subject } }))).toThrow('invalid_subject');
  });
});

describe('consumer side and producers', () => {
  const envelope = (p: P, source = 'auth-service') => {
    const id = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b11';
    return { id, name: `audit.${p.action}`, payload: p, headers: { eventId: id, source, occurredAt: '2026-10-10T10:00:00.000Z', version: 1 } };
  };

  it('audit-service would accept both only from auth-service, and the dead-letter screen keeps their bodies (every value a token)', () => {
    for (const p of [repaired(), denied()]) {
      expect(validateAuditEvent(envelope(p)).category).toBe('security');
      expect(() => validateAuditEvent(envelope(p, 'organization-service'))).toThrow('producer_not_admitted');
      expect(mayRetainRefusedAuditBody(envelope(p))).toBe(true);
    }
  });

  it('is producer-less: no file under apps/ names either action', () => {
    const apps = resolve(here, '../../../apps');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|js|mjs|json)$/.test(name) && /hierarchy\.reference_repair(ed|_denied)/.test(readFileSync(path, 'utf8'))) hits.push(path);
      }
    };
    walk(apps);
    expect(hits).toEqual([]);
  });
});
