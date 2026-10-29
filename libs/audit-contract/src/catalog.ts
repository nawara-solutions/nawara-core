import type { AuditCategory, AuditOutcome, UserKind } from './contract.js';

/**
 * THE Core audit catalog, version 1 (ADR-0049 A51). The only source of valid audit actions: an action that is not here does not exist,
 * for producers and for audit-service alike. Each entry is declarative, and the validator reads nothing else.
 *
 * Adding an action = a reviewed change to this file, justified against the A7 selection rule, plus the regenerated catalog document
 * (`npm run catalog:doc -w @nawara/audit-contract`; a test fails while the two differ). A rename is a new action plus a deprecation,
 * never an edit of a published name (A13). Audit-service is deployed with a new catalog BEFORE a producer emits the new action.
 *
 * The catalog records THAT an action occurred and who owns it; it is never business truth (the owning service remains the authority).
 */

/**
 * The Core services that may own catalog actions. notification-service owns none in V1 (no privileged capability exists). audit-service
 * owns exactly one (Stage 18.6): the record of a privileged platform-scope read, which it writes itself (never over the bus).
 * release-service (Stage 20.3, ADR-0051 §9) owns its release-management actions.
 */
export const CORE_PRODUCERS = ['auth-service', 'organization-service', 'billing-service', 'payment-service', 'file-service', 'audit-service', 'release-service'] as const;
export type CoreProducer = (typeof CORE_PRODUCERS)[number];

export type ChangeType = 'code' | 'uuid' | 'boolean' | 'integer' | 'timestamp' | 'token';

/**
 * One allowed change fact. `value`: a scalar. `transition`: exactly `{ from, to }` of scalars, which must differ.
 * `code` values are always a closed enumeration (`values`): no free text can reach a change. Core V2 S2-Audit.4: `token` is a bounded,
 * grammar-validated code (`^[a-z][a-z0-9_]{0,63}$`: lowercase, digits, underscore) for a value whose vocabulary is the recording
 * service's (the legal-hold reason code, Owner decision H6, validated like the receipt `reason`): never free text, never a space.
 */
export type ChangeSpec =
  | { type: 'code'; shape: 'value' | 'transition'; required: boolean; values: readonly string[] }
  | { type: 'integer'; shape: 'value' | 'transition'; required: boolean; min: number; max: number }
  | { type: 'uuid' | 'boolean' | 'timestamp' | 'token'; shape: 'value' | 'transition'; required: boolean };

/**
 * Where `organizationId` comes from (A11), always resolved by the producer from its own rows:
 * - `required`: the resource belongs to exactly one organization (a UUID);
 * - `none`: a platform-level record (`null`);
 * - `optional`: the resource may or may not belong to one (UUID or `null`, as recorded on the resource);
 * - `self`: the resource IS the organization (`organizationId` must equal `resource.id`);
 * - `resource`: the organization when `resource.type` is `organization` (then equal to `resource.id`), `null` otherwise.
 */
export type OrganizationRule = 'required' | 'none' | 'optional' | 'self' | 'resource';

export type SubjectRule = { rule: 'forbidden' } | { rule: 'required' | 'optional'; type: string };

/**
 * Core V2 S2-Audit.1 (ADR-0069 decisions 2 and 4): whether the action's producer may assert a Company and / or a Platform in a version-2
 * event (`required`: always; `optional`: when recorded on the resource). Absent = the field is refused for the action. Granting it to an
 * action is a reviewed catalog decision (like adding the action itself); in this slice NO entry grants it, so no production event can
 * assert scope yet. An assertion becomes trusted scope only when the producer's identity is broker-verified (decision 4); ownership is
 * never inferred.
 */
export interface ScopeRule {
  company?: 'required' | 'optional';
  platform?: 'required' | 'optional';
}

/**
 * Core V2 S2-Audit.2 (ADR-0069 decision 3, D5): the action records a verified human approver as `approvedBy` (a user reference of one
 * of `userKinds`). Absent = `approvedBy` is refused for the action. The recording service must take it from its own verification.
 */
export interface ApprovalRule {
  required: boolean;
  userKinds: readonly UserKind[];
}

export interface ActorRule {
  /** Allowed user kinds when a verified user acts; absent = a user actor is not allowed. */
  user?: readonly UserKind[];
  /** A trusted service (its caller name) may be the actor. */
  service?: boolean;
  /** The producer's automated processes that may be the actor (their exact codes). */
  system?: readonly string[];
}

export interface CatalogEntry {
  /** The ONE service that may emit this action. */
  producer: CoreProducer;
  category: AuditCategory;
  /** The contract version that introduced the action. */
  since: number;
  actors: ActorRule;
  organization: OrganizationRule;
  /** The resource type(s); one in every entry except a denial that can target several kinds of object. */
  resource: readonly string[];
  subject: SubjectRule;
  outcomes: readonly AuditOutcome[];
  changes: Readonly<Record<string, ChangeSpec>>;
  /**
   * Core V2 S2-Audit.1: the scope a version-2 event of this action may assert. Granted ONLY to the three `authorization_receipt.*` actions
   * (S2-Audit.2, Owner decision D3: Company, from Auth's own Owner–Company row); every other action asserts none.
   */
  scope?: Readonly<ScopeRule>;
  /** Core V2 S2-Audit.2: whether the action records `approvedBy` (only `authorization_receipt.consumed`, D5). */
  approval?: Readonly<ApprovalRule>;
  /** Why the action has central accountability value (A7); shown in the catalog document. */
  purpose: string;
}

const USERS_ALL = ['member', 'owner', 'operator'] as const;
const AUTHORITY = { type: 'code', shape: 'value', required: true, values: ['owner', 'operator', 'org_admin'] } as const;
const OK = ['succeeded'] as const;
const DENIED = ['denied'] as const;
const NO_SUBJECT = { rule: 'forbidden' } as const;
const SUBJECT_USER = { rule: 'required', type: 'user' } as const;
const NONE = {} as const;
/** Core V2 S2-Audit.2 (D3): the authorization receipts' scope: their Company, always. No Platform. */
const RECEIPT_SCOPE = { company: 'required' } as const;


const SPEC = {
  // ------------------------------------------------------------------------------------------------ auth-service (emits after its outbox, 18.7)
  'membership.approved': {
    producer: 'auth-service', category: 'business', since: 1, actors: { user: USERS_ALL }, organization: 'required',
    resource: ['membership'], subject: SUBJECT_USER, outcomes: OK, changes: { authority: AUTHORITY },
    purpose: 'A person is admitted into an organization: access is granted by an identified administrator.',
  },
  'membership.rejected': {
    producer: 'auth-service', category: 'business', since: 1, actors: { user: USERS_ALL }, organization: 'required',
    resource: ['membership'], subject: SUBJECT_USER, outcomes: OK, changes: { authority: AUTHORITY },
    purpose: 'A request to join an organization is refused by an identified administrator.',
  },
  'membership.revoked': {
    producer: 'auth-service', category: 'business', since: 1, actors: { user: USERS_ALL }, organization: 'required',
    resource: ['membership'], subject: SUBJECT_USER, outcomes: OK,
    changes: { authority: AUTHORITY, was_admin: { type: 'boolean', shape: 'value', required: true } },
    purpose: 'A member loses access to an organization (and any administrator capability with it).',
  },
  'membership.admin_granted': {
    producer: 'auth-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'required',
    resource: ['membership'], subject: SUBJECT_USER, outcomes: OK, changes: NONE,
    purpose: 'An owner makes a member an organization administrator (a privilege grant, with step-up).',
  },
  'membership.admin_revoked': {
    producer: 'auth-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'required',
    resource: ['membership'], subject: SUBJECT_USER, outcomes: OK, changes: NONE,
    purpose: 'An owner removes the administrator capability of a member.',
  },
  'membership.admin_provisioned': {
    producer: 'auth-service', category: 'security', since: 1, actors: { user: ['member'] }, organization: 'required',
    resource: ['membership'], subject: NO_SUBJECT, outcomes: OK,
    changes: { invitation_id: { type: 'uuid', shape: 'value', required: true } },
    purpose: 'An administrator invitation is consumed: a new organization administrator exists.',
  },
  'join_code.created': {
    producer: 'auth-service', category: 'administrative', since: 1, actors: { user: USERS_ALL }, organization: 'required',
    resource: ['join_code'], subject: NO_SUBJECT, outcomes: OK, changes: { authority: AUTHORITY },
    purpose: 'A new way to enter an organization is opened.',
  },
  'join_code.revoked': {
    producer: 'auth-service', category: 'administrative', since: 1, actors: { user: USERS_ALL }, organization: 'required',
    resource: ['join_code'], subject: NO_SUBJECT, outcomes: OK, changes: { authority: AUTHORITY },
    purpose: 'A way to enter an organization is closed.',
  },
  'admin_invitation.created': {
    producer: 'auth-service', category: 'administrative', since: 1, actors: { user: ['member', 'owner'] }, organization: 'required',
    resource: ['admin_invitation'], subject: NO_SUBJECT, outcomes: OK,
    changes: { authority: { type: 'code', shape: 'value', required: true, values: ['owner', 'org_admin'] } },
    purpose: 'An invitation that will mint an organization administrator is issued.',
  },
  'admin_invitation.revoked': {
    producer: 'auth-service', category: 'administrative', since: 1, actors: { user: ['member', 'owner'] }, organization: 'required',
    resource: ['admin_invitation'], subject: NO_SUBJECT, outcomes: OK,
    changes: { authority: { type: 'code', shape: 'value', required: true, values: ['owner', 'org_admin'] } },
    purpose: 'A pending administrator invitation is withdrawn.',
  },
  'operator.created': {
    producer: 'auth-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'none',
    resource: ['user'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'An owner creates a platform operator account (privileged, cross-organization staff).',
  },
  // Stage 19.2 (ADR-0050 decisions 5, 6): also an owner's suspension / restoration of a MEMBER of the owner's Company. The optional
  // `reason` is the closed D6 set: present on a member suspension, absent on the (unchanged) operator block. Additive under A50.
  'account.disabled': {
    producer: 'auth-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'none',
    resource: ['user'], subject: NO_SUBJECT, outcomes: OK,
    changes: { reason: { type: 'code', shape: 'value', required: false, values: ['compromised_account', 'security_incident', 'policy_violation'] } },
    purpose: 'An owner blocks an operator account, or suspends a member account of the owner\'s Company (every session revoked).',
  },
  'account.enabled': {
    producer: 'auth-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'none',
    resource: ['user'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'An owner unblocks an operator account, or restores a suspended member account of the owner\'s Company.',
  },
  'platform_assignment.granted': {
    producer: 'auth-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'none',
    resource: ['platform_assignment'], subject: SUBJECT_USER, outcomes: OK,
    changes: { platform_id: { type: 'uuid', shape: 'value', required: true } },
    purpose: 'An operator gains authority over a platform and its organizations.',
  },
  'platform_assignment.revoked': {
    producer: 'auth-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'none',
    resource: ['platform_assignment'], subject: SUBJECT_USER, outcomes: OK,
    changes: { platform_id: { type: 'uuid', shape: 'value', required: true } },
    purpose: 'An operator loses authority over a platform.',
  },
  'owner.password_changed': {
    producer: 'auth-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'none',
    resource: ['user'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'The most privileged credential changes.',
  },
  'owner.secret_key_rotated': {
    producer: 'auth-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'none',
    resource: ['user'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'The owner recovery secret is replaced.',
  },
  'owner.factor_enrolled': {
    producer: 'auth-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'none',
    resource: ['factor'], subject: NO_SUBJECT, outcomes: OK,
    changes: { method: { type: 'code', shape: 'value', required: true, values: ['totp', 'webauthn'] } },
    purpose: 'A second factor is added to an owner account.',
  },
  'owner.factor_removed': {
    producer: 'auth-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'none',
    resource: ['factor'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'A second factor is removed from an owner account.',
  },
  'owner.recovery_started': {
    producer: 'auth-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'none',
    resource: ['user'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'Account recovery (factor reset) begins for an owner: the start of a takeover window.',
  },
  'owner.recovery_completed': {
    producer: 'auth-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'none',
    resource: ['user'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'Owner recovery completes: every factor and session is revoked and re-enrollment starts.',
  },
  'owner.recovery_cancelled': {
    producer: 'auth-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'none',
    resource: ['user'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'A pending owner recovery is cancelled from a working session.',
  },
  'session.refresh_reuse_detected': {
    producer: 'auth-service', category: 'security', since: 1, actors: { system: ['refresh_reuse_detection'] }, organization: 'none',
    resource: ['user'], subject: NO_SUBJECT, outcomes: DENIED, changes: NONE,
    purpose: 'A rotated refresh token was replayed: a likely stolen session; the whole session family is revoked.',
  },
  'owner.webauthn_clone_suspected': {
    producer: 'auth-service', category: 'security', since: 1, actors: { system: ['webauthn_clone_detection'] }, organization: 'none',
    resource: ['factor'], subject: SUBJECT_USER, outcomes: DENIED, changes: NONE,
    purpose: 'A security key reported a signature counter that went backwards: a likely cloned authenticator, revoked.',
  },
  // A5.4-AC1 (ADR-0061 §4, §6; docs/architecture/core-v2-a5-4-ac1-repair-audit-contract.md): declared consumer-first, with NO producer
  // yet. The repair success covers a placement and an already-present reference (`placed` false), in the repair's own transaction. The
  // denial never names an organization: the requested id may be unknown or belong to another Company (ADR-0061 §5, §8). Additive (A50).
  'hierarchy.reference_repaired': {
    producer: 'auth-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'resource',
    resource: ['company', 'platform', 'organization'], subject: NO_SUBJECT, outcomes: OK,
    changes: { placed: { type: 'boolean', shape: 'value', required: true } },
    purpose: 'The active Company owner repaired a hierarchy reference in Auth: a validated reference row was placed, or it was already present.',
  },
  'hierarchy.reference_repair_denied': {
    producer: 'auth-service', category: 'security', since: 1, actors: { user: USERS_ALL }, organization: 'none',
    resource: ['company', 'platform', 'organization'], subject: NO_SUBJECT, outcomes: DENIED,
    changes: { reason: { type: 'code', shape: 'value', required: true, values: ['no_authority', 'step_up_required'] } },
    purpose: 'A verified user was refused a hierarchy reference repair (no authority, or no valid fresh step-up).',
  },
  // A5.4-AC1 batch 2 (ADR-0064; docs/architecture/core-v2-a5-4-ac1-batch2-decisions.md): declared consumer-first, with NO producer yet.
  // D1: a repair answered with the collapsed 404 after the step-up was consumed. One reason for the nonexistent, out-of-scope and
  // other-Company cases, and never an organization, so the record cannot tell them apart. D3: a cached parent link (anchor) that
  // disagrees with the authority, seen by the repair or by a first touch; a Company has no anchor. Additive (A50).
  'hierarchy.reference_repair_unresolved': {
    producer: 'auth-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'none',
    resource: ['company', 'platform', 'organization'], subject: NO_SUBJECT, outcomes: DENIED,
    changes: { reason: { type: 'code', shape: 'value', required: true, values: ['unresolved'] } },
    purpose: 'The active Company owner\'s hierarchy reference repair did not resolve: the requested id is unknown, outside Auth\'s scope or in another Company, and the record does not say which.',
  },
  'hierarchy.reference_anchor_mismatch_detected': {
    producer: 'auth-service', category: 'security', since: 1, actors: { system: ['hierarchy_anchor_detection'] }, organization: 'none',
    resource: ['platform', 'organization'], subject: NO_SUBJECT, outcomes: DENIED,
    changes: {
      operation: { type: 'code', shape: 'value', required: true, values: ['reference_repair', 'join_code_creation', 'invitation_creation', 'platform_assignment_grant'] },
    },
    purpose: 'A cached hierarchy parent link disagreed with the authority (a reused id or tampered data): the operation failed closed and nothing was overwritten.',
  },

  // Core V2 S2-Audit.2 (ADR-0067 decision 7; Owner decisions D1 to D5): the authorization receipts' lifecycle. Version 2 only (D2), the
  // Company always (D3), the receipt as the resource; never a secret, a digest, a step-up proof, a binding or an amount (D4). A REFUSED
  // consumption has no central action (D1): it stays an Auth-local record.
  'authorization_receipt.issued': {
    producer: 'auth-service', category: 'security', since: 2, actors: { user: ['owner'] }, organization: 'none',
    resource: ['authorization_receipt'], subject: NO_SUBJECT, outcomes: OK, changes: NONE, scope: RECEIPT_SCOPE,
    purpose: 'An Owner, after a fresh factor-only step-up, issued a single-use authorization receipt approving one exact refund of their Company.',
  },
  'authorization_receipt.consumed': {
    producer: 'auth-service', category: 'security', since: 2, actors: { service: true }, organization: 'none',
    resource: ['authorization_receipt'], subject: NO_SUBJECT, outcomes: OK, changes: NONE, scope: RECEIPT_SCOPE,
    approval: { required: true, userKinds: ['owner'] },
    purpose: 'The bound service consumed an authorization receipt: the commit point of the Owner\'s refund approval (approvedBy: the issuing Owner, verified by Auth).',
  },
  'authorization_receipt.voided': {
    producer: 'auth-service', category: 'security', since: 2, actors: { system: ['authorization_receipt_replay'] }, organization: 'none',
    resource: ['authorization_receipt'], subject: NO_SUBJECT, outcomes: OK, changes: NONE, scope: RECEIPT_SCOPE,
    purpose: 'A replayed issue request (its response possibly lost) voided an unconsumed receipt automatically, so a secret that may have leaked can never be used.',
  },

  // ----------------------------------------------------------------------------------------------------------------------- organization-service
  'company.created': {
    producer: 'organization-service', category: 'administrative', since: 1, actors: { service: true }, organization: 'none',
    resource: ['company'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'A top-level tenant hierarchy root is created.',
  },
  'company.updated': {
    producer: 'organization-service', category: 'administrative', since: 1, actors: { service: true }, organization: 'none',
    resource: ['company'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'A company record is changed.',
  },
  'platform.created': {
    producer: 'organization-service', category: 'administrative', since: 1, actors: { user: ['owner', 'operator'], service: true },
    organization: 'none', resource: ['platform'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'A platform is created in the hierarchy.',
  },
  'platform.updated': {
    producer: 'organization-service', category: 'administrative', since: 1, actors: { user: ['owner', 'operator'], service: true },
    organization: 'none', resource: ['platform'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'A platform record is changed.',
  },
  'organization.created': {
    producer: 'organization-service', category: 'administrative', since: 1, actors: { user: ['owner', 'operator'], service: true },
    organization: 'self', resource: ['organization'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'A tenant organization comes into existence.',
  },
  'organization.updated': {
    // Catalog correction G5 (Stage 18.7.3): Organization's authorization lets a `member` who is an admin of THIS organization update it
    // (organization-service authorization-evaluator: kind 'member' + organizationAdminMemberships → org_admin). Only this action.
    producer: 'organization-service', category: 'administrative', since: 1, actors: { user: USERS_ALL, service: true },
    organization: 'self', resource: ['organization'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'A tenant organization record is changed.',
  },
  'hierarchy.admin_operation_denied': {
    producer: 'organization-service', category: 'security', since: 1, actors: { user: USERS_ALL }, organization: 'resource',
    resource: ['company', 'platform', 'organization'], subject: NO_SUBJECT, outcomes: DENIED,
    changes: {
      operation: { type: 'code', shape: 'value', required: true, values: ['platform.create', 'platform.update', 'organization.create', 'organization.update'] },
      reason: { type: 'code', shape: 'value', required: true, values: ['no_authority', 'step_up_required'] },
    },
    purpose: 'A human was refused a hierarchy administration operation (no authority, or no fresh step-up).',
  },

  // ---------------------------------------------------------------------------------------------------------------------------- billing-service
  'subscription.activated': {
    producer: 'billing-service', category: 'commercial', since: 1, actors: { system: ['payment_event_consumer', 'payment_reconciler'] },
    organization: 'required', resource: ['subscription'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      product_id: { type: 'uuid', shape: 'value', required: true },
      price_id: { type: 'uuid', shape: 'value', required: true },
    },
    purpose: 'An organization first gains a paid entitlement (its subscription becomes active after a settled payment).',
  },
  'subscription.renewed': {
    producer: 'billing-service', category: 'commercial', since: 1, actors: { system: ['payment_event_consumer', 'payment_reconciler'] },
    organization: 'required', resource: ['subscription'], subject: NO_SUBJECT, outcomes: OK,
    changes: { period_end: { type: 'timestamp', shape: 'transition', required: true } },
    purpose: 'A paid entitlement is extended by a settled payment.',
  },
  'invoice.issued': {
    // 18.7 G3: an invoice may have no organization (its seller / payer is a user or company): the organization recorded on the invoice.
    producer: 'billing-service', category: 'commercial', since: 1, actors: { user: USERS_ALL, service: true }, organization: 'optional',
    resource: ['invoice'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'An invoice becomes a legal claim (numbered, immutable).',
  },
  'invoice.discarded': {
    // 18.7 G3: an invoice may have no organization (its seller / payer is a user or company): the organization recorded on the invoice.
    producer: 'billing-service', category: 'commercial', since: 1, actors: { user: USERS_ALL, service: true }, organization: 'optional',
    resource: ['invoice'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'A draft invoice is abandoned before issue.',
  },
  'invoice.paid': {
    producer: 'billing-service', category: 'commercial', since: 1, actors: { system: ['payment_event_consumer', 'payment_reconciler'] },
    organization: 'optional', resource: ['invoice'], subject: NO_SUBJECT, outcomes: OK, changes: NONE, // 18.7 G3
    purpose: 'An issued invoice is settled.',
  },
  'payment_request.created': {
    producer: 'billing-service', category: 'commercial', since: 1, actors: { user: USERS_ALL, service: true }, organization: 'optional', // 18.7 G3
    resource: ['payment_request'], subject: NO_SUBJECT, outcomes: OK,
    changes: { invoice_id: { type: 'uuid', shape: 'value', required: true } },
    purpose: 'Collection of an invoice is requested.',
  },
  'payment_request.cancelled': {
    // 18.7 G2: a REQUESTED payment's cancellation completes when Payment's event (or the reconciler) confirms it; 18.7 G3: organization optional.
    producer: 'billing-service', category: 'commercial', since: 1,
    actors: { user: USERS_ALL, service: true, system: ['payment_event_consumer', 'payment_reconciler'] }, organization: 'optional',
    resource: ['payment_request'], subject: NO_SUBJECT, outcomes: OK,
    changes: { invoice_id: { type: 'uuid', shape: 'value', required: true } },
    purpose: 'A pending collection is withdrawn.',
  },
  'product.created': {
    // 18.7 G4: a product's seller may be an organization: that organization, else null (a user- or company-sold product).
    // Core V2 S3g (D-CAT-9): additively, the verified Owner of the Platform's Company (the Owner catalog; Billing records organization null for it).
    producer: 'billing-service', category: 'administrative', since: 1, actors: { user: ['owner'], service: true }, organization: 'optional',
    resource: ['product'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'A sellable product enters the platform catalog.',
  },
  'product.archived': {
    // 18.7 G4: a product's seller may be an organization: that organization, else null (a user- or company-sold product).
    // Core V2 S3g (D-CAT-9): additively, the verified Owner of the Platform's Company (the Owner catalog; Billing records organization null for it).
    producer: 'billing-service', category: 'administrative', since: 1, actors: { user: ['owner'], service: true }, organization: 'optional',
    resource: ['product'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'A product stops being sellable.',
  },
  'price.created': {
    // 18.7 G4: a product's seller may be an organization: that organization, else null (a user- or company-sold product).
    // Core V2 S3g (D-CAT-9): additively, the verified Owner of the Platform's Company (the Owner catalog; Billing records organization null for it).
    producer: 'billing-service', category: 'administrative', since: 1, actors: { user: ['owner'], service: true }, organization: 'optional',
    resource: ['price'], subject: NO_SUBJECT, outcomes: OK,
    changes: { product_id: { type: 'uuid', shape: 'value', required: true } },
    purpose: 'A price (what an organization will be charged) is published.',
  },
  'price.retired': {
    // 18.7 G4: a product's seller may be an organization: that organization, else null (a user- or company-sold product).
    // Core V2 S3g (D-CAT-9): additively, the verified Owner of the Platform's Company (the Owner catalog; Billing records organization null for it).
    producer: 'billing-service', category: 'administrative', since: 1, actors: { user: ['owner'], service: true }, organization: 'optional',
    resource: ['price'], subject: NO_SUBJECT, outcomes: OK,
    changes: { product_id: { type: 'uuid', shape: 'value', required: true } },
    purpose: 'A price stops being offered.',
  },
  // Core V2 S5a (register BIL-13 to BIL-15; the Owner's D-9): an Organization assistance request, consented by its beneficiary with frozen
  // terms, declined, or its physical cash collection reported. The actor is always the Auth-verified ordinary member (the beneficiary or
  // the Organization actor); the Organization is the request's own. A cash-collection report is evidence, never settlement.
  'assistance_request.created': {
    producer: 'billing-service', category: 'commercial', since: 1, actors: { user: ['member'] }, organization: 'required',
    resource: ['assistance_request'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      product_id: { type: 'uuid', shape: 'value', required: true },
      price_id: { type: 'uuid', shape: 'value', required: true },
      base_amount: { type: 'integer', shape: 'value', required: true, min: 1, max: 9007199254740991 },
      fee_amount: { type: 'integer', shape: 'value', required: true, min: 0, max: 9007199254740991 },
      fee_proposal_id: { type: 'uuid', shape: 'value', required: false },
    },
    purpose: 'A member consented to have an Organization pay for a personal product, on frozen financial terms (base price and approved fee).',
  },
  'assistance_request.declined': {
    producer: 'billing-service', category: 'commercial', since: 1, actors: { user: ['member'] }, organization: 'required',
    resource: ['assistance_request'], subject: NO_SUBJECT, outcomes: OK,
    changes: { declined_by: { type: 'code', shape: 'value', required: true, values: ['beneficiary', 'organization_actor'] } },
    purpose: 'A pending assistance request was finally declined, by its beneficiary or by an administrator of the Organization.',
  },
  'assistance_request.cash_collection_reported': {
    producer: 'billing-service', category: 'commercial', since: 1, actors: { user: ['member'] }, organization: 'required',
    resource: ['assistance_request'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      cash_collected_at: { type: 'timestamp', shape: 'value', required: true },
      settle_by: { type: 'timestamp', shape: 'value', required: true },
    },
    purpose: 'An Organization administrator declared the physical cash collection, starting the 72-hour settlement deadline (not a settlement).',
  },
  // Core V2 S5b (register BIL-16, BIL-17; the Owner's E-13): the Organization's electronic settlement of an assistance request is requested
  // (an invoice and a payment request, never a settlement: only Payment's verified success settles); the cash-return obligation opens past
  // the deadline without a settlement (Billing's own sweep); the Organization reports the full cash return (which does not discharge it).
  'assistance_request.settlement_requested': {
    producer: 'billing-service', category: 'commercial', since: 1, actors: { user: ['member'] }, organization: 'required',
    resource: ['assistance_request'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      invoice_id: { type: 'uuid', shape: 'value', required: true },
      payment_request_id: { type: 'uuid', shape: 'value', required: true },
    },
    purpose: 'An Organization administrator started the electronic settlement of an assistance request (an invoice and a payment request; not yet paid).',
  },
  'cash_return_obligation.opened': {
    // Core V2 S6d (R6D-2, R6D-5): also opened by the refund effect worker when a completed refund reverses an assisted purchase; `origin`
    // (optional, absent on the deadline origin's existing evidence) says which
    producer: 'billing-service', category: 'commercial', since: 1, actors: { system: ['assistance_sweep', 'refund_effect_worker'] }, organization: 'required',
    resource: ['cash_return_obligation'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      assistance_request_id: { type: 'uuid', shape: 'value', required: true },
      amount: { type: 'integer', shape: 'value', required: true, min: 1, max: 9007199254740991 },
      origin: { type: 'code', shape: 'value', required: false, values: ['deadline', 'refund_completion'] },
    },
    purpose: 'The Organization owes the beneficiary the full cash collected, fee included: the settlement deadline passed with no electronic settlement, or a completed refund reversed the assisted purchase.',
  },
  'cash_return_obligation.return_reported': {
    producer: 'billing-service', category: 'commercial', since: 1, actors: { user: ['member'] }, organization: 'required',
    resource: ['cash_return_obligation'], subject: NO_SUBJECT, outcomes: OK,
    changes: { returned_at: { type: 'timestamp', shape: 'value', required: true } },
    purpose: 'An Organization administrator declared the full cash returned to the beneficiary (awaiting the beneficiary\'s confirmation).',
  },
  // Core V2 S5c (register BIL-18 to BIL-22; the Owner's H-1 to H-7, J-1 to J-6): the beneficiary confirms the reported cash return (the
  // obligation's only discharge in S5c), opens a dispute (no cutoff), the Organization answers it (evidence only), and the Owner, with a
  // dedicated factor step-up each, appends a correction of an Organization-asserted time or closes a timestamp dispute on such a
  // correction (nonfinancial: no Owner action discharges, confirms, pays or reverses anything).
  'cash_return_obligation.confirmed': {
    producer: 'billing-service', category: 'commercial', since: 1, actors: { user: ['member'] }, organization: 'required',
    resource: ['cash_return_obligation'], subject: NO_SUBJECT, outcomes: OK,
    changes: { assistance_request_id: { type: 'uuid', shape: 'value', required: true } },
    purpose: 'The beneficiary confirmed receiving the full cash back: the obligation is discharged and the assistance request is returned.',
  },
  'assistance_dispute.opened': {
    producer: 'billing-service', category: 'commercial', since: 1, actors: { user: ['member'] }, organization: 'required',
    resource: ['assistance_dispute'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      assistance_request_id: { type: 'uuid', shape: 'value', required: true },
      reason_code: { type: 'code', shape: 'value', required: true, values: ['cash_not_returned', 'collection_not_made', 'collection_time_incorrect', 'return_time_incorrect'] },
    },
    purpose: 'The beneficiary disputed the cash evidence of an assistance request (it blocks the confirmation of a cash return while open).',
  },
  'assistance_dispute.responded': {
    producer: 'billing-service', category: 'commercial', since: 1, actors: { user: ['member'] }, organization: 'required',
    resource: ['assistance_dispute'], subject: NO_SUBJECT, outcomes: OK,
    changes: { position: { type: 'code', shape: 'value', required: true, values: ['accepts', 'contests'] } },
    purpose: 'An Organization administrator answered a dispute (evidence only: no state changes).',
  },
  'assistance_dispute.resolved': {
    producer: 'billing-service', category: 'commercial', since: 1, actors: { user: ['owner'] }, organization: 'required',
    resource: ['assistance_dispute'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      outcome: { type: 'code', shape: 'value', required: true, values: ['timestamp_corrected'] },
      correction_id: { type: 'uuid', shape: 'value', required: true },
    },
    purpose: 'The Owner, with a factor step-up, closed a timestamp dispute on a correction of exactly that time (no financial effect).',
  },
  'assistance_request.corrected': {
    producer: 'billing-service', category: 'commercial', since: 1, actors: { user: ['owner'] }, organization: 'required',
    resource: ['assistance_request'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      correction_id: { type: 'uuid', shape: 'value', required: true },
      field: { type: 'code', shape: 'value', required: true, values: ['cash_collected_at', 'returned_at'] },
      corrected_value: { type: 'timestamp', shape: 'value', required: true },
      superseded_value: { type: 'timestamp', shape: 'value', required: true },
      reason_code: { type: 'code', shape: 'value', required: true, values: ['actor_entry_error', 'evidence_contradicts_report'] },
    },
    purpose: 'The Owner, with a factor step-up, appended a correction of an Organization-asserted time (the original evidence is kept; no financial term changes).',
  },

  // Core V2 S6a (register BIL-23; ADR-0067 decision 6; the Owner's R6A-1 to R6A-9): the Owner of the seller Company opens a refund case for
  // one verified captured payment, in full, or cancels it while open. No money moves and no refund attempt exists: execution is S6b. Version
  // 1: the seller Company and the Platform are recorded as changes; granting them as trusted scope stays a separate catalog decision (D3).
  'refund_case.opened': {
    producer: 'billing-service', category: 'commercial', since: 1, actors: { user: ['owner'] }, organization: 'optional',
    resource: ['refund_case'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      payment_id: { type: 'uuid', shape: 'value', required: true },
      company_id: { type: 'uuid', shape: 'value', required: true },
      platform_id: { type: 'uuid', shape: 'value', required: true },
      amount: { type: 'integer', shape: 'value', required: true, min: 1, max: 9007199254740991 },
      eligibility: { type: 'code', shape: 'value', required: true, values: ['personal_purchase', 'late_assisted_settlement', 'non_entitlement'] },
      reason: { type: 'code', shape: 'value', required: true, values: ['duplicate_charge', 'service_not_provided', 'customer_request', 'late_settlement_unapplied', 'legal_requirement'] },
      legal_override: { type: 'boolean', shape: 'value', required: true },
    },
    purpose: 'The Owner of the seller Company opened a refund case for one verified captured payment, in full (no refund attempt yet; nothing moved).',
  },
  'refund_case.cancelled': {
    producer: 'billing-service', category: 'commercial', since: 1, actors: { user: ['owner'] }, organization: 'optional',
    resource: ['refund_case'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      payment_id: { type: 'uuid', shape: 'value', required: true },
      company_id: { type: 'uuid', shape: 'value', required: true },
      platform_id: { type: 'uuid', shape: 'value', required: true },
    },
    purpose: 'The Owner of the seller Company cancelled an open refund case before any refund processing (the payment may get a new case).',
  },
  // Core V2 S6b (register BIL-24; ADR-0067 decision 5; the Owner's R6B-7, R6B-10): the Owner relayed an Auth refund authorization receipt for
  // the case to Payment, as one refund attempt Billing identified first. Version 1, no trusted scope (S2-Audit D3): the Company and Platform
  // are changes. The receipt and its secret never appear.
  'refund_case.authorization_relayed': {
    producer: 'billing-service', category: 'commercial', since: 1, actors: { user: ['owner'] }, organization: 'optional',
    resource: ['refund_case'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      payment_id: { type: 'uuid', shape: 'value', required: true },
      refund_attempt_id: { type: 'uuid', shape: 'value', required: true },
      company_id: { type: 'uuid', shape: 'value', required: true },
      platform_id: { type: 'uuid', shape: 'value', required: true },
    },
    purpose: 'The Owner of the seller Company relayed a refund authorization for a case to Payment, as one identified refund attempt (money moves only after Auth confirms the authorization).',
  },

  // Core V2 S6c (register EVT-02; S0 FC-3; the Owner's R6C-9, R6C-11): Billing completes a refund case once, from Payment's verified
  // `refund.case_completed` (or Payment's status read when that event is lost). Version 1, no trusted scope; nothing is reversed (S6d).
  'refund_case.completed': {
    producer: 'billing-service', category: 'commercial', since: 1, actors: { system: ['payment_event_consumer', 'payment_reconciler'] }, organization: 'optional',
    resource: ['refund_case'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      payment_id: { type: 'uuid', shape: 'value', required: true },
      refund_approval_id: { type: 'uuid', shape: 'value', required: true }, // Payment's refund authorization id (a key naming 'authorization' is screened as sensitive)
      refund_attempt_id: { type: 'uuid', shape: 'value', required: true },
    },
    purpose: 'Payment\'s verified evidence shows the case\'s full refund was returned: the refund case is completed (no new attempt is ever accepted).',
  },

  // Core V2 S6d (register BIL-24; ADR-0044 B5; S0 FC-4, V-1; the Owner's R6D-1, R6D-5): a completed refund reversed a Personal purchase (once,
  // K-3 Option D re-lays the later periods). Version 1, no trusted scope; no billing.* domain event (EVT-05 is not approved).
  'subscription_purchase.reversed': {
    producer: 'billing-service', category: 'commercial', since: 1, actors: { system: ['refund_effect_worker', 'dispute_loss_worker'] }, organization: 'optional',
    resource: ['subscription_purchase'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      // Core V2 S6e-D (R6E-5, R6E-8): also written by the dispute loss worker for a direct purchase's final lost chargeback; exactly one of
      // refund_case_id (cause refund_completion) or dispute_id (cause final_lost_chargeback) is present
      refund_case_id: { type: 'uuid', shape: 'value', required: false },
      dispute_id: { type: 'uuid', shape: 'value', required: false },
      cause: { type: 'code', shape: 'value', required: true, values: ['refund_completion', 'final_lost_chargeback'] },
    },
    purpose: "A completed refund, or a direct purchase's verified final lost chargeback, reversed a Personal purchase: its span is removed and later paid periods are re-laid (the purchase record itself is kept).",
  },

  // ---------------------------------------------------------------------------------------------------------------------------- payment-service
  'payment.created': {
    producer: 'payment-service', category: 'commercial', since: 1, actors: { service: true }, organization: 'optional',
    resource: ['payment'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'A service asks for money to be collected.',
  },
  'payment.cancelled': {
    producer: 'payment-service', category: 'commercial', since: 1, actors: { service: true }, organization: 'optional',
    resource: ['payment'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'A pending collection is cancelled by its requester.',
  },
  'payment.succeeded': {
    // 18.7 G1: also settled by a verified user's attempt sync and by the attempt resolver.
    producer: 'payment-service', category: 'commercial', since: 1,
    actors: { user: USERS_ALL, service: true, system: ['payment_webhook', 'payment_attempt_resolver'] },
    organization: 'optional', resource: ['payment'], subject: NO_SUBJECT, outcomes: OK,
    changes: { settled_method: { type: 'code', shape: 'value', required: true, values: ['gateway'] } },
    purpose: 'Money is accepted as settled.',
  },
  'payment.failed': {
    producer: 'payment-service', category: 'commercial', since: 1, // 18.7 G1
    actors: { user: USERS_ALL, service: true, system: ['payment_webhook', 'payment_attempt_resolver'] },
    organization: 'optional', resource: ['payment'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'A collection definitively failed.',
  },
  'payment.expired': {
    producer: 'payment-service', category: 'commercial', since: 1, actors: { system: ['payment_expiry_sweep'] }, organization: 'optional',
    resource: ['payment'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'A collection lapsed unpaid.',
  },
  // Core V2 S6b (register PAY-07; ADR-0067 decisions 5 to 7; the Owner's R6B-7): a refund attempt's authorization by Auth's consumed receipt,
  // its provider-confirmed failure and its verified full-amount success. Version 1, no trusted scope and no `approvedBy` (the approver is kept
  // on Payment's own row; S2-Audit D3, D5). Allocation, completion and reversal are later stages (S6c, S6d).
  'refund_attempt.authorized': {
    producer: 'payment-service', category: 'commercial', since: 1, actors: { service: true, system: ['payment_refund_worker'] }, organization: 'optional',
    resource: ['refund_attempt'], subject: NO_SUBJECT, outcomes: OK,
    changes: { payment_id: { type: 'uuid', shape: 'value', required: true }, refund_case_id: { type: 'uuid', shape: 'value', required: true } },
    purpose: 'Auth confirmed the Owner\'s single-use refund authorization for exactly this refund attempt: the refund may now be sent to the provider.',
  },
  'refund_attempt.failed': {
    producer: 'payment-service', category: 'commercial', since: 1, actors: { system: ['payment_webhook', 'payment_refund_worker'] }, organization: 'optional',
    resource: ['refund_attempt'], subject: NO_SUBJECT, outcomes: OK,
    changes: { payment_id: { type: 'uuid', shape: 'value', required: true }, refund_case_id: { type: 'uuid', shape: 'value', required: true } },
    purpose: 'The provider definitively refused or failed an authorized refund (a further attempt needs a new authorization).',
  },
  // Core V2 S6c (register EVT-02; S0 FC-2, FC-3; the Owner's R6C-7, R6C-11): the cumulative verified allocation of a refund authorization reached
  // its approved full amount; `refund.case_completed` is published with it. Version 1, no trusted scope, no `approvedBy`.
  // Core V2 S6e-D (register PAY-09 to PAY-11, EVT-03; the Owner's R6E-8): Payment disputes. Version 1, no trusted scope. A provider observation is
  // the verified webhook's (`payment_webhook`); evidence and decisions are the Owner's own. Identifiers and codes only: never an amount,
  // evidence content, a receipt or its secret.
  'payment_dispute.opened': {
    producer: 'payment-service', category: 'commercial', since: 1, actors: { system: ['payment_webhook'] }, organization: 'optional',
    resource: ['payment_dispute'], subject: NO_SUBJECT, outcomes: OK,
    changes: { payment_id: { type: 'uuid', shape: 'value', required: true } },
    purpose: "A verified provider dispute of a captured payment was recorded, in the exposure the provider states (it changes no entitlement).",
  },
  'payment_dispute.closed': {
    producer: 'payment-service', category: 'commercial', since: 1, actors: { system: ['payment_webhook'] }, organization: 'optional',
    resource: ['payment_dispute'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      payment_id: { type: 'uuid', shape: 'value', required: true },
      outcome: { type: 'code', shape: 'value', required: true, values: ['won', 'lost'] },
    },
    purpose: "The provider's final outcome of a dispute, once (a later contradictory notification never replaces it).",
  },
  'payment_dispute.evidence_added': {
    producer: 'payment-service', category: 'commercial', since: 1, actors: { user: ['owner'] }, organization: 'optional',
    resource: ['payment_dispute'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      payment_id: { type: 'uuid', shape: 'value', required: true },
      file_id: { type: 'uuid', shape: 'value', required: true },
      grant_id: { type: 'uuid', shape: 'value', required: true },
    },
    purpose: 'The Owner of the seller Company added a reference to a file File granted Payment as evidence of this open dispute.',
  },
  'payment_dispute.decided': {
    producer: 'payment-service', category: 'commercial', since: 1, actors: { user: ['owner'] }, organization: 'optional',
    resource: ['payment_dispute'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      payment_id: { type: 'uuid', shape: 'value', required: true },
      decision: { type: 'code', shape: 'value', required: true, values: ['contest', 'accept'] },
    },
    purpose: "The Owner's contest-or-accept decision on a dispute, authorized by a consumed Auth dispute-decision receipt (the provider still decides the outcome).",
  },
  'refund_authorization.completed': {
    producer: 'payment-service', category: 'commercial', since: 1, actors: { system: ['payment_webhook', 'payment_refund_worker'] }, organization: 'optional',
    resource: ['refund_authorization'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      payment_id: { type: 'uuid', shape: 'value', required: true },
      refund_case_id: { type: 'uuid', shape: 'value', required: true },
      refund_attempt_id: { type: 'uuid', shape: 'value', required: true },
    },
    purpose: 'Verified provider refund evidence reached the full approved refund: the refund is financially complete, once.',
  },
  'refund_attempt.succeeded': {
    producer: 'payment-service', category: 'commercial', since: 1, actors: { system: ['payment_webhook', 'payment_refund_worker'] }, organization: 'optional',
    resource: ['refund_attempt'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      payment_id: { type: 'uuid', shape: 'value', required: true },
      refund_case_id: { type: 'uuid', shape: 'value', required: true },
      fact_id: { type: 'uuid', shape: 'value', required: true },
    },
    purpose: 'The provider\'s verified evidence shows the full refund was made (money returned); its commercial effects are later stages.',
  },

  // ------------------------------------------------------------------------------------------------------------------------------- file-service
  'file.deleted': {
    producer: 'file-service', category: 'business', since: 1, actors: { service: true }, organization: 'optional',
    resource: ['file'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'A stored document is deleted at its owner service\'s request (irreversible loss of content).',
  },
  'file.integrity_incident': {
    producer: 'file-service', category: 'security', since: 1, actors: { system: ['file_download_integrity_check', 'file_reconciliation'] },
    organization: 'optional', resource: ['file'], subject: NO_SUBJECT, outcomes: OK,
    changes: { reason: { type: 'code', shape: 'value', required: true, values: ['digest_mismatch', 'size_mismatch', 'object_missing'] } },
    purpose: 'Stored content no longer matches its record (altered, truncated or missing): possible tampering or loss.',
  },
  // Core V2 S2-File.1 (OD-FILE decided by the Owner, F1 / F2 / F6): a file's owner service grants ONE other Core service (fixed by the
  // purpose) the time-bounded use of one file as evidence of one case, or revokes that grant. Written in the grant's own transaction; the
  // grant is the resource; the file and the case are uuids; the purpose names the grantee (F2: one per purpose, so it is not repeated);
  // nothing of the file's content, name or bytes travels.
  'file.grant_issued': {
    producer: 'file-service', category: 'security', since: 1, actors: { service: true }, organization: 'optional',
    resource: ['file_evidence_grant'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      file_id: { type: 'uuid', shape: 'value', required: true },
      purpose: { type: 'code', shape: 'value', required: true, values: ['dispute_evidence', 'surplus_evidence', 'settlement_evidence', 'fraud_evidence'] },
      case_ref: { type: 'uuid', shape: 'value', required: true },
      expires_at: { type: 'timestamp', shape: 'value', required: true },
    },
    purpose: 'A file\'s owner service granted another Core service the time-bounded use of that file as evidence of one case.',
  },
  'file.grant_revoked': {
    producer: 'file-service', category: 'security', since: 1, actors: { service: true }, organization: 'optional',
    resource: ['file_evidence_grant'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      file_id: { type: 'uuid', shape: 'value', required: true },
      purpose: { type: 'code', shape: 'value', required: true, values: ['dispute_evidence', 'surplus_evidence', 'settlement_evidence', 'fraud_evidence'] },
    },
    purpose: 'A file\'s owner service revoked an evidence grant: the grantee can no longer use the file for that case.',
  },
  // Core V2 S2-File.2 (OD-FILE F6): every access to a file THROUGH an evidence grant, recorded in the transaction that authorizes it,
  // before any byte or metadata leaves. `access` says what was authorized; `content_authorized` and `ticket_redemption_authorized` are
  // NOT proof of delivery (a stream can still fail or be cut after authorization). S2-File.4 adds how a single-use grant ticket's
  // reservation settled: `ticket_redemption_committed` (the server finished writing the response; still not proof of receipt),
  // `ticket_redemption_uncertain` (bytes may have been sent, or the lease ran out unsettled: consumed, never reusable) and
  // `ticket_redemption_released` (failed before any header was sent: the ticket is usable again). The grantee service is the actor; a ticket redemption
  // has no authenticated caller, so its actor is File's redemption process. No ticket, token, secret, file name or byte travels.
  'file.granted_read': {
    producer: 'file-service', category: 'security', since: 1, actors: { service: true, system: ['file_granted_ticket_redemption'] },
    organization: 'optional', resource: ['file_evidence_grant'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      file_id: { type: 'uuid', shape: 'value', required: true },
      purpose: { type: 'code', shape: 'value', required: true, values: ['dispute_evidence', 'surplus_evidence', 'settlement_evidence', 'fraud_evidence'] },
      access: {
        type: 'code', shape: 'value', required: true,
        values: ['metadata', 'content_authorized', 'ticket_issued', 'ticket_redemption_authorized',
          // S2-File.4 (OD-FILE F5), additive: how a single-use grant ticket's reservation settled
          'ticket_redemption_committed', 'ticket_redemption_uncertain', 'ticket_redemption_released'],
      },
    },
    purpose: 'A Core service was authorized, through an active evidence grant, to read a file\'s metadata or content or to issue or redeem a download ticket for it (authorization, not proof of delivery).',
  },
  // Core V2 S2-File.3 (OD-FILE F4 / F6): a file's owner service places or releases an evidence hold (while any is active, the file cannot
  // be deleted by any path). Written in the transition's own transaction, once per transition (a repeated placement or release writes
  // nothing); the hold is the resource; the file and the holder's reference are uuids; no content, token or URL travels.
  'file.hold_placed': {
    producer: 'file-service', category: 'security', since: 1, actors: { service: true }, organization: 'optional',
    resource: ['file_hold'], subject: NO_SUBJECT, outcomes: OK,
    changes: { file_id: { type: 'uuid', shape: 'value', required: true }, hold_ref: { type: 'uuid', shape: 'value', required: true } },
    purpose: 'A file\'s owner service placed an evidence hold on it: the file can no longer be deleted while the hold is active.',
  },
  'file.hold_released': {
    producer: 'file-service', category: 'security', since: 1, actors: { service: true }, organization: 'optional',
    resource: ['file_hold'], subject: NO_SUBJECT, outcomes: OK,
    changes: { file_id: { type: 'uuid', shape: 'value', required: true }, hold_ref: { type: 'uuid', shape: 'value', required: true } },
    purpose: 'A file\'s owner service released one of its evidence holds: the file may be deleted again once no other hold is active.',
  },

  // ---------------------------------------------------------------------------------------------------------------------------- release-service
  // Stage 20.3 (ADR-0051 §9): CI automation registers and publishes releases with a narrow per-product service credential; the actor is
  // that service, never a human. Platform-level evidence (organization `none`: a release belongs to no tenant). Written in the mutation's
  // transaction through the outbox, only when the row actually changed (an idempotent retry writes nothing). Additive (A50).
  // The version text is deliberately not a change fact (no free text reaches a change): the record names the release by id, and
  // release-service is the authority for what that release is.
  'release.registered': {
    producer: 'release-service', category: 'administrative', since: 1, actors: { service: true }, organization: 'none',
    resource: ['release'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      product_id: { type: 'uuid', shape: 'value', required: true },
      component_id: { type: 'uuid', shape: 'value', required: true },
      kind: { type: 'code', shape: 'value', required: true, values: ['backend', 'web', 'desktop', 'mobile_ios', 'mobile_android'] },
    },
    purpose: 'Automation declares that a build of a product component exists (a new, immutable release; not yet offered to clients).',
  },
  'release.published': {
    producer: 'release-service', category: 'administrative', since: 1, actors: { service: true }, organization: 'none',
    resource: ['release'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      product_id: { type: 'uuid', shape: 'value', required: true },
      component_id: { type: 'uuid', shape: 'value', required: true },
      kind: { type: 'code', shape: 'value', required: true, values: ['backend', 'web', 'desktop', 'mobile_ios', 'mobile_android'] },
    },
    purpose: 'Automation publishes a registered release: it may become the latest version that clients are offered or required to use.',
  },

  // Stage 20.4 (ADR-0051 decisions 8, 9; the ADR-0050 human path): the verified owner of the configured operating Company, with a factor
  // step-up verified and consumed through Auth, withdraws a release or changes a client component's minimum supported version. The actor
  // is that human, never a service. Platform-level; written in the mutation's transaction, only when something changed. Additive (A50).
  'release.withdrawn': {
    producer: 'release-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'none',
    resource: ['release'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      product_id: { type: 'uuid', shape: 'value', required: true },
      component_id: { type: 'uuid', shape: 'value', required: true },
      kind: { type: 'code', shape: 'value', required: true, values: ['backend', 'web', 'desktop', 'mobile_ios', 'mobile_android'] },
    },
    purpose: 'A published release is withdrawn: it stops being offered, and clients running it are required to update.',
  },
  // The policy row has no UUID of its own, so the resource is the component; the minimum is named by the release it designates (always a
  // published release when set), never by free version text.
  'compatibility_policy.changed': {
    producer: 'release-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'none',
    resource: ['component'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      product_id: { type: 'uuid', shape: 'value', required: true },
      kind: { type: 'code', shape: 'value', required: true, values: ['web', 'desktop', 'mobile_ios', 'mobile_android'] },
      policy_version: { type: 'integer', shape: 'transition', required: true, min: 0, max: 2_147_483_647 },
      minimum_release_id: { type: 'uuid', shape: 'value', required: true },
      previous_minimum_release_id: { type: 'uuid', shape: 'value', required: false },
    },
    purpose: 'A client component\'s minimum supported version changes: clients below it are required to update.',
  },

  // ------------------------------------------------------------------------------------------------------------------------------ audit-service
  // Stage 18.6 (A57, named `audit.platform_query` in Stage 18.1; renamed to the A13 grammar, since an action never sits in the `audit.`
  // namespace that its event type adds). Written by audit-service itself, in the same transaction as the read it records.
  // Stage 19.3 (ADR-0050 decision 6, Audit-X): also a verified Company OWNER's read of one organization of their Company, the owner as the
  // actor (never the audit service); `organization_id` names that organization (the record itself stays platform-level). Additive (A50).
  // Core V2 S2-Audit.4 (ADR-0069 decision 6; OD-13 resolved, Owner decisions H1 to H7): an Owner places / releases a legal hold on their
  // Company's TRUSTED audit evidence (records with a trusted Company scope row), optionally within an occurrence window. Written by
  // audit-service itself, in the same transaction as the hold event, never over the bus. No factor proof, token or evidence travels.
  'audit_legal_hold.placed': {
    producer: 'audit-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'none',
    resource: ['audit_legal_hold'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      company_id: { type: 'uuid', shape: 'value', required: true },
      reason_code: { type: 'token', shape: 'value', required: true },
      window_from: { type: 'timestamp', shape: 'value', required: false },
      window_to: { type: 'timestamp', shape: 'value', required: false },
    },
    purpose: 'A Company owner, after a fresh factor-only step-up, placed a legal hold on their Company\'s trusted audit evidence: retention can no longer purge it.',
  },
  'audit_legal_hold.released': {
    producer: 'audit-service', category: 'security', since: 1, actors: { user: ['owner'] }, organization: 'none',
    resource: ['audit_legal_hold'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      company_id: { type: 'uuid', shape: 'value', required: true },
      reason_code: { type: 'token', shape: 'value', required: true },
    },
    purpose: 'A Company owner, after a fresh factor-only step-up, released one legal hold of their Company: retention may purge that evidence again under its policy.',
  },
  // Core V2 S2-Audit.3 (ADR-0069 decision 5: every human read is recorded): additively, an operator may be the actor, and two targets record
  // the scoped human reads, `company` (AUD-03, the Owner's Company timeline, with `company_id`) and `operator_platform` (AUD-04, an
  // operator's assigned Platform, with `platform_id`). Written by audit-service itself only, never over the bus; nothing else changes.
  'platform_query.executed': {
    producer: 'audit-service', category: 'security', since: 1, actors: { service: true, user: ['owner', 'operator'] }, organization: 'none',
    resource: ['platform_query'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      target: { type: 'code', shape: 'value', required: true, values: ['all', 'organization', 'platform', 'company', 'operator_platform'] },
      window_days: { type: 'integer', shape: 'value', required: true, min: 1, max: 31 },
      result_count: { type: 'integer', shape: 'value', required: true, min: 0, max: 100 },
      page: { type: 'code', shape: 'value', required: true, values: ['first', 'next'] },
      filtered: { type: 'boolean', shape: 'value', required: true },
      organization_id: { type: 'uuid', shape: 'value', required: false },
      company_id: { type: 'uuid', shape: 'value', required: false },
      platform_id: { type: 'uuid', shape: 'value', required: false },
    },
    purpose: 'Audit evidence was read with a privileged scope: by a trusted service (across organizations or platform-level), by a Company owner (one organization of their Company, or their Company\'s trusted timeline), or by an operator (an assigned Platform\'s trusted records). Who, when, which scope, how broadly.',
  },
} as const satisfies Record<string, CatalogEntry>;

type Spec = typeof SPEC;
/** Every cataloged action. */
export type AuditAction = keyof Spec;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Read-only view of the catalog, keyed by action. A `Map` (never an object lookup): `constructor` or `__proto__` can never resolve. */
export const AUDIT_CATALOG: ReadonlyMap<AuditAction, Readonly<CatalogEntry>> = new Map(
  (Object.keys(SPEC) as AuditAction[]).map((a) => [a, deepFreeze(SPEC[a]) as Readonly<CatalogEntry>]),
);
export const AUDIT_ACTIONS: readonly AuditAction[] = Object.freeze([...AUDIT_CATALOG.keys()]);

export function catalogEntry(action: string): Readonly<CatalogEntry> | undefined {
  return AUDIT_CATALOG.get(action as AuditAction);
}

/** The actions a service owns (empty for a service that emits nothing). */
export function actionsOwnedBy(service: string): AuditAction[] {
  return AUDIT_ACTIONS.filter((a) => AUDIT_CATALOG.get(a)!.producer === service);
}

// ------------------------------------------------------------------------------------------------ compile-time view of one action

type ScalarOf<S> = S extends { type: 'code'; values: readonly (infer V)[] } ? V : S extends { type: 'boolean' } ? boolean : S extends { type: 'integer' } ? number : string;
type ChangeOf<S> = S extends { shape: 'transition' } ? { from: ScalarOf<S>; to: ScalarOf<S> } : ScalarOf<S>;
type ChangesSpec<A extends AuditAction> = Spec[A]['changes'];
type RequiredKeys<C> = { [K in keyof C]: C[K] extends { required: true } ? K : never }[keyof C];
type OptionalKeys<C> = Exclude<keyof C, RequiredKeys<C>>;
type ChangesOf<C> = { [K in RequiredKeys<C>]: ChangeOf<C[K]> } & { [K in OptionalKeys<C>]?: ChangeOf<C[K]> };

/** The `changes` an action accepts, typed from the catalog (runtime validation is still the authority). */
export type AuditChangesOf<A extends AuditAction> = keyof ChangesSpec<A> extends never ? never : ChangesOf<ChangesSpec<A>>;
export type AuditResourceTypeOf<A extends AuditAction> = Spec[A]['resource'][number];
export type AuditOutcomeOf<A extends AuditAction> = Spec[A]['outcomes'][number];
export type AuditSubjectOf<A extends AuditAction> = Spec[A]['subject'] extends { type: infer T } ? { type: T; id: string } : never;
