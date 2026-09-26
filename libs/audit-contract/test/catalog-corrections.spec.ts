import { AUDIT_ACTIONS, AUDIT_CATALOG, validateAuditPayload, type AuditAction } from '../src/index.js';
import { SAMPLE_IDS, sampleAuditPayload } from '../src/testing.js';

/**
 * Stage 18.7 catalog corrections G1–G5, discovered during real producer integration (each justified by a code path or the persisted model;
 * see the Stage 18.7 record). These tests pin BOTH sides: what became valid, and the boundaries that must stay invalid. Nothing else in
 * the catalog was broadened.
 */
type P = Record<string, any>;
const producer = (a: AuditAction) => AUDIT_CATALOG.get(a)!.producer;
const base = (a: AuditAction): P => JSON.parse(JSON.stringify(sampleAuditPayload(a)));
const ok = (a: AuditAction, over: P) => () => validateAuditPayload({ ...base(a), ...over }, producer(a));
const USER = { type: 'user', id: SAMPLE_IDS.user, userKind: 'member' };
const system = (id: string) => ({ type: 'system', id });

describe('G1: payment.succeeded / payment.failed accept a verified user and the attempt resolver', () => {
  it.each(['payment.succeeded', 'payment.failed'] as const)('%s: user (member / owner / operator), payment_attempt_resolver, and the prior service / webhook actors', (a) => {
    for (const userKind of ['member', 'owner', 'operator']) expect(ok(a, { actor: { ...USER, userKind } })).not.toThrow();
    for (const actor of [system('payment_attempt_resolver'), system('payment_webhook'), { type: 'service', id: 'billing-service' }]) expect(ok(a, { actor })).not.toThrow();
    expect(ok(a, { actor: system('payment_expiry_sweep') })).toThrow('invalid_actor');
    expect(ok(a, { actor: { ...USER, userKind: 'admin' } })).toThrow('invalid_actor');
  });

  it('only there: every other action refuses the resolver, and the other Payment actions still refuse a user', () => {
    for (const a of AUDIT_ACTIONS.filter((x) => x !== 'payment.succeeded' && x !== 'payment.failed')) {
      expect(ok(a, { actor: system('payment_attempt_resolver') }), a).toThrow('invalid_actor');
    }
    for (const a of ['payment.created', 'payment.cancelled', 'payment.expired'] as const) expect(ok(a, { actor: USER }), a).toThrow('invalid_actor');
  });
});

describe('G2: payment_request.cancelled accepts the payment-event consumer and the reconciler', () => {
  it('both processes, and still a user or a service', () => {
    for (const actor of [system('payment_event_consumer'), system('payment_reconciler'), USER, { type: 'service', id: 'some-product' }]) {
      expect(ok('payment_request.cancelled', { actor })).not.toThrow();
    }
    expect(ok('payment_request.cancelled', { actor: system('payment_expiry_sweep') })).toThrow('invalid_actor');
  });

  it('payment_request.created does NOT gain them (a request is only created by a user or a service)', () => {
    for (const id of ['payment_event_consumer', 'payment_reconciler']) expect(ok('payment_request.created', { actor: system(id) })).toThrow('invalid_actor');
  });

  it('the two process codes stay confined to the Billing actions that already had them, plus payment_request.cancelled', () => {
    const allowed = new Set(['subscription.activated', 'subscription.renewed', 'invoice.paid', 'payment_request.cancelled']);
    for (const a of AUDIT_ACTIONS.filter((x) => !allowed.has(x))) expect(ok(a, { actor: system('payment_event_consumer') }), a).toThrow('invalid_actor');
  });
});

describe('G3: invoice / payment_request actions record the invoice\'s organization, or null for an organization-less invoice', () => {
  const g3 = ['invoice.issued', 'invoice.discarded', 'invoice.paid', 'payment_request.created', 'payment_request.cancelled'] as const;
  it.each(g3)('%s: a UUID or null; never malformed, never a list', (a) => {
    expect(ok(a, { organizationId: SAMPLE_IDS.organization })).not.toThrow();
    expect(ok(a, { organizationId: null })).not.toThrow();
    for (const bad of ['*', 'all', SAMPLE_IDS.organization.toUpperCase(), [SAMPLE_IDS.organization]]) expect(ok(a, { organizationId: bad })).toThrow('invalid_organization');
    const { organizationId: _o, ...missing } = base(a);
    expect(() => validateAuditPayload(missing, producer(a))).toThrow('invalid_organization'); // still explicit, even when null
  });

  it('the subscription actions keep organization REQUIRED (a subscription always belongs to one organization)', () => {
    for (const a of ['subscription.activated', 'subscription.renewed'] as const) expect(ok(a, { organizationId: null }), a).toThrow('invalid_organization');
  });
});

describe('G4: product / price actions record the seller organization, or null when the seller is not an organization', () => {
  it.each(['product.created', 'product.archived', 'price.created', 'price.retired'] as const)('%s: a UUID or null', (a) => {
    expect(ok(a, { organizationId: SAMPLE_IDS.organization })).not.toThrow();
    expect(ok(a, { organizationId: null })).not.toThrow();
    expect(ok(a, { organizationId: 'not-a-uuid' })).toThrow('invalid_organization');
  });

  it('genuinely platform-level actions keep organization NONE', () => {
    for (const a of ['company.created', 'platform.created', 'operator.created', 'owner.password_changed', 'platform_query.executed'] as const) {
      expect(ok(a, { organizationId: SAMPLE_IDS.organization }), a).toThrow('invalid_organization');
    }
  });
});

describe('G5: organization.updated accepts a member (an org-admin member of THAT organization, per Organization\'s own authorization)', () => {
  it('member, owner, operator and a service are accepted; the kind is recorded as given, never another kind', () => {
    for (const userKind of ['member', 'owner', 'operator']) {
      const p = validateAuditPayload({ ...base('organization.updated'), actor: { ...USER, userKind } }, producer('organization.updated'));
      expect(p.actor).toEqual({ ...USER, userKind });
    }
    expect(ok('organization.updated', { actor: { type: 'service', id: 'provisioning' } })).not.toThrow();
    expect(ok('organization.updated', { actor: { ...USER, userKind: 'admin' } })).toThrow('invalid_actor');
    expect(ok('organization.updated', { actor: system('payment_reconciler') })).toThrow('invalid_actor');
  });

  it('the organization is still the resource itself (self): another organization, or none, is refused', () => {
    const p = base('organization.updated');
    expect(ok('organization.updated', { actor: USER, organizationId: p.resource.id })).not.toThrow();
    expect(ok('organization.updated', { actor: USER, organizationId: SAMPLE_IDS.user })).toThrow('invalid_organization');
    expect(ok('organization.updated', { actor: USER, organizationId: null })).toThrow('invalid_organization');
  });

  it('only there: organization.created and every platform / company action still refuse a member', () => {
    for (const a of ['organization.created', 'platform.created', 'platform.updated'] as const) {
      expect(ok(a, { actor: USER }), a).toThrow('invalid_actor');
      expect(ok(a, { actor: { ...USER, userKind: 'owner' } }), a).not.toThrow();
    }
    for (const a of ['company.created', 'company.updated'] as const) expect(ok(a, { actor: USER }), a).toThrow('invalid_actor');
  });
});

describe('nothing else was broadened', () => {
  it('the catalog has the 50 actions of Stage 18.7 plus the two of Stage 20.3 and the two of Stage 20.4, and only the corrected entries changed their actor or organization rules (snapshot of the rest)', () => {
    expect(AUDIT_ACTIONS).toHaveLength(54);
    expect(AUDIT_ACTIONS.filter((a) => AUDIT_CATALOG.get(a)!.producer === 'release-service'))
      .toEqual(['release.registered', 'release.published', 'release.withdrawn', 'compatibility_policy.changed']); // Stages 20.3 / 20.4 (ADR-0051 §9), additive
    const corrected = new Set(['payment.succeeded', 'payment.failed', 'payment_request.cancelled', 'invoice.issued', 'invoice.discarded', 'invoice.paid', 'payment_request.created',
      'product.created', 'product.archived', 'price.created', 'price.retired']);
    const optional = AUDIT_ACTIONS.filter((a) => AUDIT_CATALOG.get(a)!.organization === 'optional' && !corrected.has(a));
    expect(optional.sort()).toEqual(['file.deleted', 'file.integrity_incident', 'payment.cancelled', 'payment.created', 'payment.expired', 'payment.failed', 'payment.succeeded'].filter((a) => !corrected.has(a)).sort());
    const withUser = AUDIT_ACTIONS.filter((a) => AUDIT_CATALOG.get(a)!.producer === 'payment-service' && AUDIT_CATALOG.get(a)!.actors.user);
    expect(withUser.sort()).toEqual(['payment.failed', 'payment.succeeded']);
  });

  it('exactly these actions accept a member: the 13 of Stage 18.4, plus G1 (payment.succeeded / failed) and G5 (organization.updated)', () => {
    const member = AUDIT_ACTIONS.filter((a) => (AUDIT_CATALOG.get(a)!.actors.user ?? []).includes('member' as never));
    const stage184 = ['membership.approved', 'membership.rejected', 'membership.revoked', 'membership.admin_provisioned', 'join_code.created', 'join_code.revoked',
      'admin_invitation.created', 'admin_invitation.revoked', 'hierarchy.admin_operation_denied', 'invoice.issued', 'invoice.discarded', 'payment_request.created',
      'payment_request.cancelled'];
    expect(member.sort()).toEqual([...stage184, 'payment.succeeded', 'payment.failed', 'organization.updated'].sort());
    // Every other action refuses a member outright.
    for (const a of AUDIT_ACTIONS.filter((x) => !member.includes(x))) expect(ok(a, { actor: USER }), a).toThrow('invalid_actor');
  });
});

describe('Stage 19.2: account.disabled accepts the closed suspension reason (ADR-0050 D6), and nothing else widens', () => {
  const owner = { type: 'user', id: SAMPLE_IDS.user, userKind: 'owner' };
  it.each(['compromised_account', 'security_incident', 'policy_violation'])('%s is accepted; no reason (the operator block) still is', (reason) => {
    expect(ok('account.disabled', { actor: owner, changes: { reason } })).not.toThrow();
    expect(ok('account.disabled', { actor: owner })).not.toThrow();
  });

  it('owner_request, free text, a non-string, another key and an empty object are refused', () => {
    for (const changes of [{ reason: 'owner_request' }, { reason: 'he was rude' }, { reason: 'x'.repeat(200) }, { reason: 7 }, { note: 'free text' }, { reason: 'compromised_account', note: 'x' }, {}]) {
      expect(ok('account.disabled', { actor: owner, changes }), JSON.stringify(changes)).toThrow('invalid_changes');
    }
  });

  it('the actor stays owner-only, the organization stays none, and account.enabled still carries no changes', () => {
    for (const userKind of ['operator', 'member']) expect(ok('account.disabled', { actor: { ...owner, userKind } }), userKind).toThrow('invalid_actor');
    expect(ok('account.disabled', { actor: owner, organizationId: SAMPLE_IDS.organization })).toThrow('invalid_organization');
    expect(ok('account.enabled', { actor: owner, changes: { reason: 'compromised_account' } })).toThrow('invalid_changes');
  });
});

describe('Stage 19.3: platform_query.executed accepts a verified Company owner (Audit-X) and the queried organization, nothing else widens', () => {
  const owner = { type: 'user', id: SAMPLE_IDS.user, userKind: 'owner' };
  const facts = { target: 'organization', window_days: 29, result_count: 3, page: 'first', filtered: false };
  it('an owner actor with organization_id, and the unchanged service reader without it', () => {
    expect(ok('platform_query.executed', { actor: owner, changes: { ...facts, organization_id: SAMPLE_IDS.organization } })).not.toThrow();
    expect(ok('platform_query.executed', { actor: { type: 'service', id: 'platform-reader' }, changes: { ...facts, target: 'all' } })).not.toThrow();
  });

  it('operators, members and system actors are refused; the record stays platform-level; organization_id is a UUID', () => {
    for (const userKind of ['operator', 'member']) expect(ok('platform_query.executed', { actor: { ...owner, userKind }, changes: facts }), userKind).toThrow('invalid_actor');
    expect(ok('platform_query.executed', { actor: system('audit_query'), changes: facts })).toThrow('invalid_actor');
    expect(ok('platform_query.executed', { actor: owner, organizationId: SAMPLE_IDS.organization, changes: facts })).toThrow('invalid_organization');
    for (const bad of ['*', 'all', [SAMPLE_IDS.organization]]) expect(ok('platform_query.executed', { actor: owner, changes: { ...facts, organization_id: bad } })).toThrow('invalid_changes');
  });

  it('no other audit-service action gains an owner actor', () => {
    for (const a of AUDIT_ACTIONS.filter((x) => producer(x) === 'audit-service' && x !== 'platform_query.executed')) expect(ok(a, { actor: owner }), a).toThrow('invalid_actor');
  });
});
