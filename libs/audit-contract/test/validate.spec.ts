import { AUDIT_CATALOG, AUDIT_ACTIONS, USER_KINDS, validateAuditPayload, type AuditAction } from '../src/index.js';
import { SAMPLE_IDS, sampleAuditPayload } from '../src/testing.js';

/**
 * The contract matrix (Stage 18.4 §39), table-driven over EVERY cataloged action: each row starts from a valid sample and breaks one
 * rule. A new catalog action is covered by every row the moment it is added.
 */

type Mutable = Record<string, any>;
const clone = (v: unknown): Mutable => JSON.parse(JSON.stringify(v));
const producerOf = (a: AuditAction) => AUDIT_CATALOG.get(a)!.producer;
const check = (a: AuditAction, p: unknown) => () => validateAuditPayload(p, producerOf(a));
const entries = [...AUDIT_CATALOG];

describe.each(entries)('%s', (action, e) => {
  const minimal = () => clone(sampleAuditPayload(action, 'minimal'));
  const complete = () => clone(sampleAuditPayload(action, 'complete'));

  it('accepts the minimal and the complete payload, returning an equal canonical copy', () => {
    for (const p of [minimal(), complete()]) {
      const out = validateAuditPayload(p, e.producer);
      expect(out).toEqual(p);
      expect(out).not.toBe(p);
      expect(Object.isFrozen(out)).toBe(true);
    }
  });

  it('refuses every other producer', () => {
    expect(check(action, minimal())).not.toThrow();
    expect(() => validateAuditPayload(minimal(), e.producer === 'file-service' ? 'payment-service' : 'file-service')).toThrow('producer_not_admitted');
  });

  it('refuses a category in the payload (the catalog owns it)', () => {
    expect(check(action, { ...minimal(), category: e.category })).toThrow('unknown_field');
    expect(check(action, { ...minimal(), category: e.category === 'commercial' ? 'security' : 'commercial' })).toThrow('unknown_field');
  });

  it('refuses an actor type the action does not allow, and a wrong user kind', () => {
    const allowed = Object.keys(e.actors);
    const candidates = [
      { type: 'user', id: SAMPLE_IDS.user, userKind: 'member' },
      { type: 'service', id: 'some-service' },
      { type: 'system', id: 'not_a_cataloged_process' },
    ];
    for (const actor of candidates) {
      if (actor.type === 'system' || !allowed.includes(actor.type) || (actor.type === 'user' && !e.actors.user!.includes('member'))) {
        expect(check(action, { ...minimal(), actor })).toThrow('invalid_actor');
      }
    }
    if (e.actors.user) {
      for (const kind of USER_KINDS.filter((k) => !e.actors.user!.includes(k))) {
        expect(check(action, { ...minimal(), actor: { type: 'user', id: SAMPLE_IDS.user, userKind: kind } })).toThrow('invalid_actor');
      }
      expect(check(action, { ...minimal(), actor: { type: 'user', id: SAMPLE_IDS.user, userKind: 'admin' } })).toThrow('invalid_actor');
      expect(check(action, { ...minimal(), actor: { type: 'user', id: SAMPLE_IDS.user } })).toThrow('invalid_actor');
      expect(check(action, { ...minimal(), actor: { type: 'user', id: SAMPLE_IDS.user.toUpperCase(), userKind: e.actors.user[0] } })).toThrow('invalid_actor');
    }
    expect(check(action, { ...minimal(), actor: { type: 'operator', id: SAMPLE_IDS.user } })).toThrow('invalid_actor');
    expect(check(action, { ...minimal(), actor: undefined })).toThrow('invalid_payload');
    const { actor: _drop, ...noActor } = minimal();
    expect(check(action, noActor)).toThrow('invalid_actor');
  });

  it('enforces the organization rule', () => {
    const { organizationId: _o, ...missing } = minimal();
    expect(check(action, missing)).toThrow('invalid_organization');
    expect(check(action, { ...minimal(), organizationId: 'not-a-uuid' })).toThrow('invalid_organization');
    expect(check(action, { ...minimal(), organizationId: SAMPLE_IDS.organization.toUpperCase() })).toThrow('invalid_organization');
    switch (e.organization) {
      case 'required':
        expect(check(action, { ...minimal(), organizationId: null })).toThrow('invalid_organization');
        break;
      case 'none':
        expect(check(action, { ...minimal(), organizationId: SAMPLE_IDS.organization })).toThrow('invalid_organization');
        break;
      case 'optional':
        expect(check(action, { ...minimal(), organizationId: null })).not.toThrow();
        expect(check(action, { ...minimal(), organizationId: SAMPLE_IDS.organization })).not.toThrow();
        break;
      case 'self':
        expect(check(action, { ...minimal(), organizationId: null })).toThrow('invalid_organization');
        expect(check(action, { ...minimal(), organizationId: SAMPLE_IDS.uuidA })).toThrow('invalid_organization');
        break;
      case 'resource':
        expect(check(action, { ...minimal(), organizationId: SAMPLE_IDS.uuidA })).toThrow('invalid_organization');
        break;
    }
  });

  it('refuses a missing, malformed or wrongly typed resource', () => {
    const { resource: _r, ...missing } = minimal();
    expect(check(action, missing)).toThrow('invalid_resource');
    expect(check(action, { ...minimal(), resource: { type: 'not_this_type', id: SAMPLE_IDS.resource } })).toThrow('invalid_resource');
    expect(check(action, { ...minimal(), resource: { type: e.resource[0], id: 'x' } })).toThrow('invalid_resource');
    expect(check(action, { ...minimal(), resource: { type: e.resource[0] } })).toThrow('invalid_resource');
    expect(check(action, { ...minimal(), resource: { ...minimal().resource, extra: 1 } })).toThrow('unknown_field');
    expect(check(action, { ...minimal(), resource: [e.resource[0], SAMPLE_IDS.resource] })).toThrow('invalid_resource');
  });

  it('enforces the subject rule', () => {
    const subject = { type: e.subject.rule === 'forbidden' ? 'user' : e.subject.type, id: SAMPLE_IDS.subject };
    if (e.subject.rule === 'forbidden') {
      expect(check(action, { ...minimal(), subject })).toThrow('invalid_subject');
    } else {
      expect(check(action, { ...minimal(), subject: { type: 'wrong_type', id: SAMPLE_IDS.subject } })).toThrow('invalid_subject');
      expect(check(action, { ...minimal(), subject: { type: e.subject.type, id: 'nope' } })).toThrow('invalid_subject');
      expect(check(action, { ...minimal(), subject: [subject] })).toThrow('invalid_subject');
    }
    if (e.subject.rule === 'required') {
      const { subject: _s, ...missing } = minimal();
      expect(check(action, missing)).toThrow('invalid_subject');
    }
    expect(check(action, { ...minimal(), subject: null })).toThrow('invalid_subject');
  });

  it('refuses an outcome the action does not allow', () => {
    for (const o of ['succeeded', 'denied'].filter((x) => !(e.outcomes as readonly string[]).includes(x))) {
      expect(check(action, { ...minimal(), outcome: o })).toThrow('invalid_outcome');
    }
    for (const o of ['failed', 'SUCCEEDED', '', 1, null]) expect(check(action, { ...minimal(), outcome: o })).toThrow('invalid_outcome');
  });

  it('refuses a missing required change, an unknown key, a wrong type, an oversized value, and empty or null changes', () => {
    const keys = Object.keys(e.changes);
    const required = keys.filter((k) => e.changes[k]!.required);
    for (const k of required) {
      const p = complete();
      delete p.changes[k];
      if (Object.keys(p.changes).length === 0) delete p.changes;
      expect(check(action, p), k).toThrow('invalid_changes');
    }
    expect(check(action, { ...minimal(), changes: { ...minimal().changes, random_debug_data: 'x' } })).toThrow('invalid_changes');
    expect(check(action, { ...minimal(), changes: {} })).toThrow('invalid_changes');
    expect(check(action, { ...minimal(), changes: null })).toThrow('invalid_changes');
    for (const k of keys) {
      const s = e.changes[k]!;
      const wrong = s.type === 'boolean' ? 'true' : s.type === 'integer' ? '123' : 7;
      const p = complete();
      p.changes[k] = s.shape === 'transition' ? { from: wrong, to: wrong } : wrong;
      expect(check(action, p), `${k} wrong type`).toThrow('invalid_changes');
      const big = complete();
      big.changes[k] = s.shape === 'transition' ? { from: 'x'.repeat(65), to: 'y'.repeat(65) } : 'x'.repeat(65);
      expect(check(action, big), `${k} oversized`).toThrow('invalid_changes');
      const shape = complete();
      shape.changes[k] = s.shape === 'transition' ? shape.changes[k].to : { from: shape.changes[k], to: shape.changes[k] };
      expect(check(action, shape), `${k} wrong shape`).toThrow('invalid_changes');
    }
  });

  it('refuses an unknown top-level field', () => {
    expect(check(action, { ...minimal(), note: 'free text' })).toThrow('unknown_field');
    expect(check(action, { ...minimal(), sourceService: e.producer })).toThrow('unknown_field');
    expect(check(action, { ...minimal(), eventType: `audit.${action}` })).toThrow('unknown_field');
    expect(check(action, { ...minimal(), occurredAt: '2026-01-01T00:00:00.000Z' })).toThrow('unknown_field');
  });

  it('refuses a malformed causation id', () => {
    expect(check(action, { ...minimal(), causationId: 'abc' })).toThrow('invalid_causation');
    expect(check(action, { ...minimal(), causationId: null })).toThrow('invalid_causation');
  });
});

describe('actions and transitions', () => {
  it('refuses an unknown, malformed or non-string action, never mapping it to "unknown"', () => {
    for (const action of ['membership.promoted', 'unknown', 'Membership.Revoked', 'membership..revoked', 'audit.file.deleted', 'x'.repeat(101), 1, null, '', 'constructor', '__proto__', 'toString']) {
      expect(() => validateAuditPayload({ ...sampleAuditPayload('file.deleted'), action }, 'file-service')).toThrow('unknown_action');
    }
  });

  it('a transition must change something', () => {
    const p = clone(sampleAuditPayload('subscription.renewed'));
    p.changes.period_end.to = p.changes.period_end.from;
    expect(() => validateAuditPayload(p, 'billing-service')).toThrow('invalid_changes');
    p.changes.period_end = { from: '2026-09-25T10:00:00.000Z', to: '2026-10-25T10:00:00.000Z', by: 'x' };
    expect(() => validateAuditPayload(p, 'billing-service')).toThrow('invalid_changes');
  });

  it('a timestamp change must be an exact UTC instant', () => {
    const p = clone(sampleAuditPayload('subscription.renewed'));
    for (const bad of ['2026-02-30T10:00:00.000Z', '2026-09-25T10:00:00Z', '2026-09-25T10:00:00.000+01:00', 'yesterday', 'infinity']) {
      p.changes.period_end = { from: bad, to: '2026-10-25T10:00:00.000Z' };
      expect(() => validateAuditPayload(p, 'billing-service'), bad).toThrow('invalid_changes');
    }
  });

  it('a code change must be one of its enumerated values (no free text reaches a change)', () => {
    const p = clone(sampleAuditPayload('hierarchy.admin_operation_denied'));
    for (const bad of ['company.delete', 'No_Authority', 'no authority', 'Le rôle a été changé']) {
      p.changes.reason = bad;
      expect(() => validateAuditPayload(p, 'organization-service'), bad).toThrow('invalid_changes');
    }
  });

  it('a denial record needs the organization of its target only when the target is an organization', () => {
    const base = clone(sampleAuditPayload('hierarchy.admin_operation_denied'));
    const org = { ...base, resource: { type: 'organization', id: SAMPLE_IDS.organization }, organizationId: SAMPLE_IDS.organization };
    expect(validateAuditPayload(org, 'organization-service').organizationId).toBe(SAMPLE_IDS.organization);
    expect(() => validateAuditPayload({ ...org, organizationId: null }, 'organization-service')).toThrow('invalid_organization');
    const platform = { ...base, resource: { type: 'platform', id: SAMPLE_IDS.resource }, organizationId: null };
    expect(validateAuditPayload(platform, 'organization-service').organizationId).toBeNull();
  });

  it('covers the whole catalog', () => {
    expect(entries.length).toBe(AUDIT_ACTIONS.length);
  });
});
