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
 * A5.4-AC1 batch 2 (ADR-0064; docs/architecture/core-v2-a5-4-ac1-batch2-decisions.md): two more producer-less reference-repair
 * actions, added consumer-first. Pinned here: the change is additive only (the 56 earlier entries and every contract constant are as
 * before), each new entry accepts precisely the decided shape, the collapsed-404 record cannot distinguish its three cases, and no
 * application emits either action yet.
 */
type P = Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));
const BEFORE: Record<string, unknown> = JSON.parse(readFileSync(join(here, 'support/catalog-before-ac1-batch2.json'), 'utf8'));
const UNRESOLVED = 'hierarchy.reference_repair_unresolved';
const MISMATCH = 'hierarchy.reference_anchor_mismatch_detected';
const OPERATIONS = ['reference_repair', 'join_code_creation', 'invitation_creation', 'platform_assignment_grant'];
const ID = SAMPLE_IDS.resource;
const user = (userKind: string) => ({ type: 'user', id: SAMPLE_IDS.user, userKind });
const DETECTOR = { type: 'system', id: 'hierarchy_anchor_detection' };

const unresolved = (over: P = {}): P => ({
  action: UNRESOLVED, actor: user('owner'), organizationId: null, resource: { type: 'organization', id: ID }, outcome: 'denied',
  changes: { reason: 'unresolved' }, ...over,
});
const mismatch = (over: P = {}): P => ({
  action: MISMATCH, actor: DETECTOR, organizationId: null, resource: { type: 'platform', id: ID }, outcome: 'denied',
  changes: { operation: 'reference_repair' }, ...over,
});
const valid = (p: P) => () => validateAuditPayload(p, 'auth-service');

describe('A5.4-AC1 batch 2: additive only', () => {
  it('the 56 earlier entries are exactly as they were (snapshot taken from main before batch 2)', () => {
    expect(Object.keys(BEFORE)).toHaveLength(56);
    for (const [action, entry] of Object.entries(BEFORE)) expect(JSON.parse(JSON.stringify(AUDIT_CATALOG.get(action as never))), action).toEqual(entry);
  });

  it('the catalog grows from 56 to 58 with exactly the two batch 2 actions', () => {
    expect(AUDIT_ACTIONS).toHaveLength(58);
    expect(AUDIT_ACTIONS.filter((a) => !(a in BEFORE)).sort()).toEqual([MISMATCH, UNRESOLVED]);
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
    for (const a of [UNRESOLVED, MISMATCH] as const) {
      const e = AUDIT_CATALOG.get(a)!;
      expect([e.producer, e.category, e.since], a).toEqual(['auth-service', 'security', 1]);
    }
  });
});

describe(`${UNRESOLVED} (D1: the collapsed 404)`, () => {
  it('accepts the verified owner, outcome denied, the one reason, for each requested resource type, with organizationId null', () => {
    for (const type of ['company', 'platform', 'organization']) {
      expect(validateAuditPayload(unresolved({ resource: { type, id: ID } }), 'auth-service').organizationId, type).toBeNull();
    }
  });

  it('cannot distinguish its cases: one reason only, and never an organization, even for an Organization the caller named', () => {
    expect(AUDIT_CATALOG.get(UNRESOLVED)!.changes.reason).toMatchObject({ values: ['unresolved'] });
    for (const reason of ['not_found', 'other_company', 'out_of_scope', 'no_authority', 'Unresolved']) {
      expect(valid(unresolved({ changes: { reason } })), reason).toThrow('invalid_changes');
    }
    expect(valid(unresolved({ organizationId: ID }))).toThrow('invalid_organization');
    expect(valid(unresolved({ organizationId: SAMPLE_IDS.organization }))).toThrow('invalid_organization');
    const { organizationId: _, ...missing } = unresolved();
    expect(valid(missing)).toThrow('invalid_organization');
  });

  it('only a verified owner may be the actor', () => {
    for (const k of ['member', 'operator', 'steward', 'admin']) expect(valid(unresolved({ actor: user(k) })), k).toThrow('invalid_actor');
    expect(valid(unresolved({ actor: { type: 'service', id: 'auth-service' } }))).toThrow('invalid_actor');
    expect(valid(unresolved({ actor: DETECTOR }))).toThrow('invalid_actor');
  });

  it('refuses another outcome, missing or extra metadata, a subject and another resource type', () => {
    expect(valid(unresolved({ outcome: 'succeeded' }))).toThrow('invalid_outcome');
    expect(valid(unresolved({ outcome: 'failed' }))).toThrow('invalid_outcome');
    const { changes: _, ...noChanges } = unresolved();
    expect(valid(noChanges)).toThrow('invalid_changes');
    expect(valid(unresolved({ changes: { reason: 'unresolved', placed: false } }))).toThrow('invalid_changes');
    expect(valid(unresolved({ subject: { type: 'user', id: SAMPLE_IDS.subject } }))).toThrow('invalid_subject');
    expect(valid(unresolved({ resource: { type: 'user', id: ID } }))).toThrow('invalid_resource');
  });
});

describe(`${MISMATCH} (D3: the anchor-mismatch incident)`, () => {
  it('accepts the detecting process, outcome denied, each operation code, for a Platform or an Organization, with organizationId null', () => {
    for (const type of ['platform', 'organization']) {
      for (const operation of OPERATIONS) {
        expect(valid(mismatch({ resource: { type, id: ID }, changes: { operation } })), `${type} ${operation}`).not.toThrow();
      }
    }
  });

  it('the operation codes are a closed list (owner_bootstrap is not one: it ensures only a Company, which has no anchor)', () => {
    expect(AUDIT_CATALOG.get(MISMATCH)!.changes.operation).toMatchObject({ values: OPERATIONS });
    for (const operation of ['owner_bootstrap', 'membership_approval', 'Reference_Repair', 'join code creation']) {
      expect(valid(mismatch({ changes: { operation } })), operation).toThrow('invalid_changes');
    }
    const { changes: _, ...noChanges } = mismatch();
    expect(valid(noChanges)).toThrow('invalid_changes');
  });

  it('only the detecting process may be the actor: no user, no service, no other process', () => {
    for (const k of ['owner', 'operator', 'member']) expect(valid(mismatch({ actor: user(k) })), k).toThrow('invalid_actor');
    expect(valid(mismatch({ actor: { type: 'service', id: 'auth-service' } }))).toThrow('invalid_actor');
    expect(valid(mismatch({ actor: { type: 'system', id: 'refresh_reuse_detection' } }))).toThrow('invalid_actor');
  });

  it('refuses a Company resource, an organization, another outcome, a subject and any hierarchy payload beyond the code', () => {
    expect(valid(mismatch({ resource: { type: 'company', id: ID } }))).toThrow('invalid_resource');
    expect(valid(mismatch({ resource: { type: 'organization', id: ID }, organizationId: ID }))).toThrow('invalid_organization');
    expect(valid(mismatch({ outcome: 'succeeded' }))).toThrow('invalid_outcome');
    expect(valid(mismatch({ subject: { type: 'user', id: SAMPLE_IDS.subject } }))).toThrow('invalid_subject');
    expect(valid(mismatch({ changes: { operation: 'reference_repair', parent_id: SAMPLE_IDS.uuidA } }))).toThrow('invalid_changes');
  });
});

describe('consumer side and producers', () => {
  const envelope = (p: P, source = 'auth-service') => {
    const id = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b22';
    return { id, name: `audit.${p.action}`, payload: p, headers: { eventId: id, source, occurredAt: '2026-10-10T10:00:00.000Z', version: 1 } };
  };

  it('audit-service would accept both only from auth-service, and the dead-letter screen keeps their bodies (every value a token)', () => {
    for (const p of [unresolved(), mismatch()]) {
      expect(validateAuditEvent(envelope(p)).category).toBe('security');
      expect(() => validateAuditEvent(envelope(p, 'organization-service'))).toThrow('producer_not_admitted');
      expect(mayRetainRefusedAuditBody(envelope(p))).toBe(true);
    }
  });

  it('is producer-less: no source file under apps/ or libs/ (outside the contract library) names either action', () => {
    const roots = [resolve(here, '../../../apps'), resolve(here, '../..')];
    const own = resolve(here, '..');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
        const path = join(dir, name);
        if (path === own) continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx|mts|cts|js|mjs|cjs|json)$/.test(name) && /reference_repair_unresolved|reference_anchor_mismatch/.test(readFileSync(path, 'utf8'))) hits.push(path);
      }
    };
    for (const root of roots) walk(root);
    expect(hits).toEqual([]);
  });
});
