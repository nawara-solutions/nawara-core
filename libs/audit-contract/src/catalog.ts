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

export type ChangeType = 'code' | 'uuid' | 'boolean' | 'integer' | 'timestamp';

/**
 * One allowed change fact. `value`: a scalar. `transition`: exactly `{ from, to }` of scalars, which must differ.
 * `code` values are always a closed enumeration (`values`): no free text can reach a change.
 */
export type ChangeSpec =
  | { type: 'code'; shape: 'value' | 'transition'; required: boolean; values: readonly string[] }
  | { type: 'integer'; shape: 'value' | 'transition'; required: boolean; min: number; max: number }
  | { type: 'uuid' | 'boolean' | 'timestamp'; shape: 'value' | 'transition'; required: boolean };

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
    producer: 'billing-service', category: 'administrative', since: 1, actors: { service: true }, organization: 'optional',
    resource: ['product'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'A sellable product enters the platform catalog.',
  },
  'product.archived': {
    // 18.7 G4: a product's seller may be an organization: that organization, else null (a user- or company-sold product).
    producer: 'billing-service', category: 'administrative', since: 1, actors: { service: true }, organization: 'optional',
    resource: ['product'], subject: NO_SUBJECT, outcomes: OK, changes: NONE,
    purpose: 'A product stops being sellable.',
  },
  'price.created': {
    // 18.7 G4: a product's seller may be an organization: that organization, else null (a user- or company-sold product).
    producer: 'billing-service', category: 'administrative', since: 1, actors: { service: true }, organization: 'optional',
    resource: ['price'], subject: NO_SUBJECT, outcomes: OK,
    changes: { product_id: { type: 'uuid', shape: 'value', required: true } },
    purpose: 'A price (what an organization will be charged) is published.',
  },
  'price.retired': {
    // 18.7 G4: a product's seller may be an organization: that organization, else null (a user- or company-sold product).
    producer: 'billing-service', category: 'administrative', since: 1, actors: { service: true }, organization: 'optional',
    resource: ['price'], subject: NO_SUBJECT, outcomes: OK,
    changes: { product_id: { type: 'uuid', shape: 'value', required: true } },
    purpose: 'A price stops being offered.',
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

  // ------------------------------------------------------------------------------------------------------------------------------ audit-service
  // Stage 18.6 (A57, named `audit.platform_query` in Stage 18.1; renamed to the A13 grammar, since an action never sits in the `audit.`
  // namespace that its event type adds). Written by audit-service itself, in the same transaction as the read it records.
  // Stage 19.3 (ADR-0050 decision 6, Audit-X): also a verified Company OWNER's read of one organization of their Company, the owner as the
  // actor (never the audit service); `organization_id` names that organization (the record itself stays platform-level). Additive (A50).
  'platform_query.executed': {
    producer: 'audit-service', category: 'security', since: 1, actors: { service: true, user: ['owner'] }, organization: 'none',
    resource: ['platform_query'], subject: NO_SUBJECT, outcomes: OK,
    changes: {
      target: { type: 'code', shape: 'value', required: true, values: ['all', 'organization', 'platform'] },
      window_days: { type: 'integer', shape: 'value', required: true, min: 1, max: 31 },
      result_count: { type: 'integer', shape: 'value', required: true, min: 0, max: 100 },
      page: { type: 'code', shape: 'value', required: true, values: ['first', 'next'] },
      filtered: { type: 'boolean', shape: 'value', required: true },
      organization_id: { type: 'uuid', shape: 'value', required: false },
    },
    purpose: 'Audit evidence was read with a privileged scope: by a trusted service (across organizations or platform-level), or by a Company owner (one organization of their Company). Who, when, which organization, how broadly.',
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
