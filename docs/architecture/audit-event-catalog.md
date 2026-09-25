# Core audit event catalog

<!-- GENERATED from libs/audit-contract/src/catalog.ts by `npm run catalog:doc -w @nawara/audit-contract`. Do not edit by hand:
     a unit test fails while this file and the code catalog differ. -->

Contract version **1** ([ADR-0049](../adr/0049-audit-trail-architecture.md),
[Stage 18.4 record](./stage-18/stage-18-4-canonical-contract-catalog.md)). Every action is emitted as the kit event
`audit.<action>` by its one owning service, through `AuditEventWriter` on the business transaction. Anything not listed here is
refused (`unknown_action`) by the producer helper and by audit-service. A new action is a reviewed catalog change justified against
the ADR-0049 A7 selection rule.

Columns: **actors** allowed (user kinds; `service` = the calling service's name; `system` = the listed process codes), **organization**
rule, **resource** type, **subject** (at most one), **outcomes**, allowed **changes** (`?` = optional; `code` values are closed
enumerations). Every resource and subject id is a lowercase UUID. No change carries a name, contact, amount, credential or free text.

## auth-service (24)

| Action | Category | Actors | Organization | Resource | Subject | Outcomes | Changes | Purpose |
|---|---|---|---|---|---|---|---|---|
| `membership.approved` | business | user (member, owner, operator) | required | membership | user (required) | succeeded | `authority`: owner \| operator \| org_admin | A person is admitted into an organization: access is granted by an identified administrator. |
| `membership.rejected` | business | user (member, owner, operator) | required | membership | user (required) | succeeded | `authority`: owner \| operator \| org_admin | A request to join an organization is refused by an identified administrator. |
| `membership.revoked` | business | user (member, owner, operator) | required | membership | user (required) | succeeded | `authority`: owner \| operator \| org_admin<br>`was_admin`: boolean | A member loses access to an organization (and any administrator capability with it). |
| `membership.admin_granted` | security | user (owner) | required | membership | user (required) | succeeded | — | An owner makes a member an organization administrator (a privilege grant, with step-up). |
| `membership.admin_revoked` | security | user (owner) | required | membership | user (required) | succeeded | — | An owner removes the administrator capability of a member. |
| `membership.admin_provisioned` | security | user (member) | required | membership | — | succeeded | `invitation_id`: uuid | An administrator invitation is consumed: a new organization administrator exists. |
| `join_code.created` | administrative | user (member, owner, operator) | required | join_code | — | succeeded | `authority`: owner \| operator \| org_admin | A new way to enter an organization is opened. |
| `join_code.revoked` | administrative | user (member, owner, operator) | required | join_code | — | succeeded | `authority`: owner \| operator \| org_admin | A way to enter an organization is closed. |
| `admin_invitation.created` | administrative | user (member, owner) | required | admin_invitation | — | succeeded | `authority`: owner \| org_admin | An invitation that will mint an organization administrator is issued. |
| `admin_invitation.revoked` | administrative | user (member, owner) | required | admin_invitation | — | succeeded | `authority`: owner \| org_admin | A pending administrator invitation is withdrawn. |
| `operator.created` | security | user (owner) | none (platform) | user | — | succeeded | — | An owner creates a platform operator account (privileged, cross-organization staff). |
| `account.disabled` | security | user (owner) | none (platform) | user | — | succeeded | — | An owner blocks an operator account. |
| `account.enabled` | security | user (owner) | none (platform) | user | — | succeeded | — | An owner unblocks an operator account. |
| `platform_assignment.granted` | security | user (owner) | none (platform) | platform_assignment | user (required) | succeeded | `platform_id`: uuid | An operator gains authority over a platform and its organizations. |
| `platform_assignment.revoked` | security | user (owner) | none (platform) | platform_assignment | user (required) | succeeded | `platform_id`: uuid | An operator loses authority over a platform. |
| `owner.password_changed` | security | user (owner) | none (platform) | user | — | succeeded | — | The most privileged credential changes. |
| `owner.secret_key_rotated` | security | user (owner) | none (platform) | user | — | succeeded | — | The owner recovery secret is replaced. |
| `owner.factor_enrolled` | security | user (owner) | none (platform) | factor | — | succeeded | `method`: totp \| webauthn | A second factor is added to an owner account. |
| `owner.factor_removed` | security | user (owner) | none (platform) | factor | — | succeeded | — | A second factor is removed from an owner account. |
| `owner.recovery_started` | security | user (owner) | none (platform) | user | — | succeeded | — | Account recovery (factor reset) begins for an owner: the start of a takeover window. |
| `owner.recovery_completed` | security | user (owner) | none (platform) | user | — | succeeded | — | Owner recovery completes: every factor and session is revoked and re-enrollment starts. |
| `owner.recovery_cancelled` | security | user (owner) | none (platform) | user | — | succeeded | — | A pending owner recovery is cancelled from a working session. |
| `session.refresh_reuse_detected` | security | system (`refresh_reuse_detection`) | none (platform) | user | — | denied | — | A rotated refresh token was replayed: a likely stolen session; the whole session family is revoked. |
| `owner.webauthn_clone_suspected` | security | system (`webauthn_clone_detection`) | none (platform) | factor | user (required) | denied | — | A security key reported a signature counter that went backwards: a likely cloned authenticator, revoked. |

## organization-service (7)

| Action | Category | Actors | Organization | Resource | Subject | Outcomes | Changes | Purpose |
|---|---|---|---|---|---|---|---|---|
| `company.created` | administrative | service | none (platform) | company | — | succeeded | — | A top-level tenant hierarchy root is created. |
| `company.updated` | administrative | service | none (platform) | company | — | succeeded | — | A company record is changed. |
| `platform.created` | administrative | user (owner, operator); service | none (platform) | platform | — | succeeded | — | A platform is created in the hierarchy. |
| `platform.updated` | administrative | user (owner, operator); service | none (platform) | platform | — | succeeded | — | A platform record is changed. |
| `organization.created` | administrative | user (owner, operator); service | the organization itself | organization | — | succeeded | — | A tenant organization comes into existence. |
| `organization.updated` | administrative | user (owner, operator); service | the organization itself | organization | — | succeeded | — | A tenant organization record is changed. |
| `hierarchy.admin_operation_denied` | security | user (member, owner, operator) | the target when it is an organization, else none | company \| platform \| organization | — | denied | `operation`: platform.create \| platform.update \| organization.create \| organization.update<br>`reason`: no_authority \| step_up_required | A human was refused a hierarchy administration operation (no authority, or no fresh step-up). |

## billing-service (11)

| Action | Category | Actors | Organization | Resource | Subject | Outcomes | Changes | Purpose |
|---|---|---|---|---|---|---|---|---|
| `subscription.activated` | commercial | system (`payment_event_consumer`, `payment_reconciler`) | required | subscription | — | succeeded | `product_id`: uuid<br>`price_id`: uuid | An organization first gains a paid entitlement (its subscription becomes active after a settled payment). |
| `subscription.renewed` | commercial | system (`payment_event_consumer`, `payment_reconciler`) | required | subscription | — | succeeded | `period_end`: {from, to} of timestamp | A paid entitlement is extended by a settled payment. |
| `invoice.issued` | commercial | user (member, owner, operator); service | required | invoice | — | succeeded | — | An invoice becomes a legal claim (numbered, immutable). |
| `invoice.discarded` | commercial | user (member, owner, operator); service | required | invoice | — | succeeded | — | A draft invoice is abandoned before issue. |
| `invoice.paid` | commercial | system (`payment_event_consumer`, `payment_reconciler`) | required | invoice | — | succeeded | — | An issued invoice is settled. |
| `payment_request.created` | commercial | user (member, owner, operator); service | required | payment_request | — | succeeded | `invoice_id`: uuid | Collection of an invoice is requested. |
| `payment_request.cancelled` | commercial | user (member, owner, operator); service | required | payment_request | — | succeeded | `invoice_id`: uuid | A pending collection is withdrawn. |
| `product.created` | administrative | service | none (platform) | product | — | succeeded | — | A sellable product enters the platform catalog. |
| `product.archived` | administrative | service | none (platform) | product | — | succeeded | — | A product stops being sellable. |
| `price.created` | administrative | service | none (platform) | price | — | succeeded | `product_id`: uuid | A price (what an organization will be charged) is published. |
| `price.retired` | administrative | service | none (platform) | price | — | succeeded | `product_id`: uuid | A price stops being offered. |

## payment-service (5)

| Action | Category | Actors | Organization | Resource | Subject | Outcomes | Changes | Purpose |
|---|---|---|---|---|---|---|---|---|
| `payment.created` | commercial | service | as recorded (UUID or null) | payment | — | succeeded | — | A service asks for money to be collected. |
| `payment.cancelled` | commercial | service | as recorded (UUID or null) | payment | — | succeeded | — | A pending collection is cancelled by its requester. |
| `payment.succeeded` | commercial | service; system (`payment_webhook`) | as recorded (UUID or null) | payment | — | succeeded | `settled_method`: gateway | Money is accepted as settled. |
| `payment.failed` | commercial | service; system (`payment_webhook`) | as recorded (UUID or null) | payment | — | succeeded | — | A collection definitively failed. |
| `payment.expired` | commercial | system (`payment_expiry_sweep`) | as recorded (UUID or null) | payment | — | succeeded | — | A collection lapsed unpaid. |

## file-service (2)

| Action | Category | Actors | Organization | Resource | Subject | Outcomes | Changes | Purpose |
|---|---|---|---|---|---|---|---|---|
| `file.deleted` | business | service | as recorded (UUID or null) | file | — | succeeded | — | A stored document is deleted at its owner service's request (irreversible loss of content). |
| `file.integrity_incident` | security | system (`file_download_integrity_check`, `file_reconciliation`) | as recorded (UUID or null) | file | — | succeeded | `reason`: digest_mismatch \| size_mismatch \| object_missing | Stored content no longer matches its record (altered, truncated or missing): possible tampering or loss. |

## audit-service (1)

| Action | Category | Actors | Organization | Resource | Subject | Outcomes | Changes | Purpose |
|---|---|---|---|---|---|---|---|---|
| `platform_query.executed` | security | service | none (platform) | platform_query | — | succeeded | `target`: all \| organization \| platform<br>`window_days`: integer 1–31<br>`result_count`: integer 0–100<br>`page`: first \| next<br>`filtered`: boolean | A trusted service read audit evidence with the privileged platform scope (across organizations or platform-level): who, when, how broadly. |

## notification-service (0)

No action: no privileged Notification capability exists (Stage 18.1 A64). Delivery history stays in
notification-service.

**Total: 50 actions.**
