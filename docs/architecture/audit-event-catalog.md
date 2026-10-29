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

## auth-service (31)

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
| `account.disabled` | security | user (owner) | none (platform) | user | — | succeeded | `reason`?: compromised_account \| security_incident \| policy_violation | An owner blocks an operator account, or suspends a member account of the owner's Company (every session revoked). |
| `account.enabled` | security | user (owner) | none (platform) | user | — | succeeded | — | An owner unblocks an operator account, or restores a suspended member account of the owner's Company. |
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
| `hierarchy.reference_repaired` | security | user (owner) | the target when it is an organization, else none | company \| platform \| organization | — | succeeded | `placed`: boolean | The active Company owner repaired a hierarchy reference in Auth: a validated reference row was placed, or it was already present. |
| `hierarchy.reference_repair_denied` | security | user (member, owner, operator) | none (platform) | company \| platform \| organization | — | denied | `reason`: no_authority \| step_up_required | A verified user was refused a hierarchy reference repair (no authority, or no valid fresh step-up). |
| `hierarchy.reference_repair_unresolved` | security | user (owner) | none (platform) | company \| platform \| organization | — | denied | `reason`: unresolved | The active Company owner's hierarchy reference repair did not resolve: the requested id is unknown, outside Auth's scope or in another Company, and the record does not say which. |
| `hierarchy.reference_anchor_mismatch_detected` | security | system (`hierarchy_anchor_detection`) | none (platform) | platform \| organization | — | denied | `operation`: reference_repair \| join_code_creation \| invitation_creation \| platform_assignment_grant | A cached hierarchy parent link disagreed with the authority (a reused id or tampered data): the operation failed closed and nothing was overwritten. |
| `authorization_receipt.issued` | security | user (owner) | none (platform) | authorization_receipt | — | succeeded | — | An Owner, after a fresh factor-only step-up, issued a single-use authorization receipt approving one exact refund of their Company. |
| `authorization_receipt.consumed` | security | service | none (platform) | authorization_receipt | — | succeeded | — | The bound service consumed an authorization receipt: the commit point of the Owner's refund approval (approvedBy: the issuing Owner, verified by Auth). |
| `authorization_receipt.voided` | security | system (`authorization_receipt_replay`) | none (platform) | authorization_receipt | — | succeeded | — | A replayed issue request (its response possibly lost) voided an unconsumed receipt automatically, so a secret that may have leaked can never be used. |

## organization-service (7)

| Action | Category | Actors | Organization | Resource | Subject | Outcomes | Changes | Purpose |
|---|---|---|---|---|---|---|---|---|
| `company.created` | administrative | service | none (platform) | company | — | succeeded | — | A top-level tenant hierarchy root is created. |
| `company.updated` | administrative | service | none (platform) | company | — | succeeded | — | A company record is changed. |
| `platform.created` | administrative | user (owner, operator); service | none (platform) | platform | — | succeeded | — | A platform is created in the hierarchy. |
| `platform.updated` | administrative | user (owner, operator); service | none (platform) | platform | — | succeeded | — | A platform record is changed. |
| `organization.created` | administrative | user (owner, operator); service | the organization itself | organization | — | succeeded | — | A tenant organization comes into existence. |
| `organization.updated` | administrative | user (member, owner, operator); service | the organization itself | organization | — | succeeded | — | A tenant organization record is changed. |
| `hierarchy.admin_operation_denied` | security | user (member, owner, operator) | the target when it is an organization, else none | company \| platform \| organization | — | denied | `operation`: platform.create \| platform.update \| organization.create \| organization.update<br>`reason`: no_authority \| step_up_required | A human was refused a hierarchy administration operation (no authority, or no fresh step-up). |

## billing-service (36)

| Action | Category | Actors | Organization | Resource | Subject | Outcomes | Changes | Purpose |
|---|---|---|---|---|---|---|---|---|
| `subscription.activated` | commercial | system (`payment_event_consumer`, `payment_reconciler`) | required | subscription | — | succeeded | `product_id`: uuid<br>`price_id`: uuid | An organization first gains a paid entitlement (its subscription becomes active after a settled payment). |
| `subscription.renewed` | commercial | system (`payment_event_consumer`, `payment_reconciler`) | required | subscription | — | succeeded | `period_end`: {from, to} of timestamp | A paid entitlement is extended by a settled payment. |
| `invoice.issued` | commercial | user (member, owner, operator); service | as recorded (UUID or null) | invoice | — | succeeded | — | An invoice becomes a legal claim (numbered, immutable). |
| `invoice.discarded` | commercial | user (member, owner, operator); service | as recorded (UUID or null) | invoice | — | succeeded | — | A draft invoice is abandoned before issue. |
| `invoice.paid` | commercial | system (`payment_event_consumer`, `payment_reconciler`) | as recorded (UUID or null) | invoice | — | succeeded | — | An issued invoice is settled. |
| `payment_request.created` | commercial | user (member, owner, operator); service | as recorded (UUID or null) | payment_request | — | succeeded | `invoice_id`: uuid | Collection of an invoice is requested. |
| `payment_request.cancelled` | commercial | user (member, owner, operator); service; system (`payment_event_consumer`, `payment_reconciler`) | as recorded (UUID or null) | payment_request | — | succeeded | `invoice_id`: uuid | A pending collection is withdrawn. |
| `product.created` | administrative | user (owner); service | as recorded (UUID or null) | product | — | succeeded | — | A sellable product enters the platform catalog. |
| `product.archived` | administrative | user (owner); service | as recorded (UUID or null) | product | — | succeeded | — | A product stops being sellable. |
| `price.created` | administrative | user (owner); service | as recorded (UUID or null) | price | — | succeeded | `product_id`: uuid | A price (what an organization will be charged) is published. |
| `price.retired` | administrative | user (owner); service | as recorded (UUID or null) | price | — | succeeded | `product_id`: uuid | A price stops being offered. |
| `assistance_request.created` | commercial | user (member) | required | assistance_request | — | succeeded | `product_id`: uuid<br>`price_id`: uuid<br>`base_amount`: integer 1–9007199254740991<br>`fee_amount`: integer 0–9007199254740991<br>`fee_proposal_id`?: uuid | A member consented to have an Organization pay for a personal product, on frozen financial terms (base price and approved fee). |
| `assistance_request.declined` | commercial | user (member) | required | assistance_request | — | succeeded | `declined_by`: beneficiary \| organization_actor | A pending assistance request was finally declined, by its beneficiary or by an administrator of the Organization. |
| `assistance_request.cash_collection_reported` | commercial | user (member) | required | assistance_request | — | succeeded | `cash_collected_at`: timestamp<br>`settle_by`: timestamp | An Organization administrator declared the physical cash collection, starting the 72-hour settlement deadline (not a settlement). |
| `assistance_request.settlement_requested` | commercial | user (member) | required | assistance_request | — | succeeded | `invoice_id`: uuid<br>`payment_request_id`: uuid | An Organization administrator started the electronic settlement of an assistance request (an invoice and a payment request; not yet paid). |
| `cash_return_obligation.opened` | commercial | system (`assistance_sweep`, `refund_effect_worker`) | required | cash_return_obligation | — | succeeded | `assistance_request_id`: uuid<br>`amount`: integer 1–9007199254740991<br>`origin`?: deadline \| refund_completion | The Organization owes the beneficiary the full cash collected, fee included: the settlement deadline passed with no electronic settlement, or a completed refund reversed the assisted purchase. |
| `cash_return_obligation.return_reported` | commercial | user (member) | required | cash_return_obligation | — | succeeded | `returned_at`: timestamp | An Organization administrator declared the full cash returned to the beneficiary (awaiting the beneficiary's confirmation). |
| `cash_return_obligation.confirmed` | commercial | user (member) | required | cash_return_obligation | — | succeeded | `assistance_request_id`: uuid | The beneficiary confirmed receiving the full cash back: the obligation is discharged and the assistance request is returned. |
| `assistance_dispute.opened` | commercial | user (member) | required | assistance_dispute | — | succeeded | `assistance_request_id`: uuid<br>`reason_code`: cash_not_returned \| collection_not_made \| collection_time_incorrect \| return_time_incorrect | The beneficiary disputed the cash evidence of an assistance request (it blocks the confirmation of a cash return while open). |
| `assistance_dispute.responded` | commercial | user (member) | required | assistance_dispute | — | succeeded | `position`: accepts \| contests | An Organization administrator answered a dispute (evidence only: no state changes). |
| `assistance_dispute.resolved` | commercial | user (owner) | required | assistance_dispute | — | succeeded | `outcome`: timestamp_corrected<br>`correction_id`: uuid | The Owner, with a factor step-up, closed a timestamp dispute on a correction of exactly that time (no financial effect). |
| `assistance_request.corrected` | commercial | user (owner) | required | assistance_request | — | succeeded | `correction_id`: uuid<br>`field`: cash_collected_at \| returned_at<br>`corrected_value`: timestamp<br>`superseded_value`: timestamp<br>`reason_code`: actor_entry_error \| evidence_contradicts_report | The Owner, with a factor step-up, appended a correction of an Organization-asserted time (the original evidence is kept; no financial term changes). |
| `refund_case.opened` | commercial | user (owner) | as recorded (UUID or null) | refund_case | — | succeeded | `payment_id`: uuid<br>`company_id`: uuid<br>`platform_id`: uuid<br>`amount`: integer 1–9007199254740991<br>`eligibility`: personal_purchase \| late_assisted_settlement \| non_entitlement \| recovery_surplus<br>`reason`: duplicate_charge \| service_not_provided \| customer_request \| late_settlement_unapplied \| legal_requirement \| recovery_surplus<br>`legal_override`: boolean | The Owner of the seller Company opened a refund case for one verified captured payment, in full (no refund attempt yet; nothing moved). |
| `refund_case.cancelled` | commercial | user (owner) | as recorded (UUID or null) | refund_case | — | succeeded | `payment_id`: uuid<br>`company_id`: uuid<br>`platform_id`: uuid | The Owner of the seller Company cancelled an open refund case before any refund processing (the payment may get a new case). |
| `refund_case.authorization_relayed` | commercial | user (owner) | as recorded (UUID or null) | refund_case | — | succeeded | `payment_id`: uuid<br>`refund_attempt_id`: uuid<br>`company_id`: uuid<br>`platform_id`: uuid | The Owner of the seller Company relayed a refund authorization for a case to Payment, as one identified refund attempt (money moves only after Auth confirms the authorization). |
| `refund_case.completed` | commercial | system (`payment_event_consumer`, `payment_reconciler`) | as recorded (UUID or null) | refund_case | — | succeeded | `payment_id`: uuid<br>`refund_approval_id`: uuid<br>`refund_attempt_id`: uuid | Payment's verified evidence shows the case's full refund was returned: the refund case is completed (no new attempt is ever accepted). |
| `subscription_purchase.reversed` | commercial | system (`refund_effect_worker`, `dispute_loss_worker`) | as recorded (UUID or null) | subscription_purchase | — | succeeded | `refund_case_id`?: uuid<br>`dispute_id`?: uuid<br>`cause`: refund_completion \| final_lost_chargeback | A completed refund, or a direct purchase's verified final lost chargeback, reversed a Personal purchase: its span is removed and later paid periods are re-laid (the purchase record itself is kept). |
| `fraud_hold.placed` | commercial | user (owner) | none (platform) | fraud_hold | — | succeeded | `product_id`: uuid<br>`reason`: account_takeover \| stolen_payment_method \| identity_fraud \| chargeback_abuse \| promotion_abuse | The Owner of the seller Company suspended one beneficiary's Personal entitlement to one product, with verified evidence, for at most 14 days. |
| `fraud_hold.released` | commercial | user (owner) | none (platform) | fraud_hold | — | succeeded | `product_id`: uuid | The Owner released a fraud hold before its 14-day review deadline; the denied paid time is compensated. |
| `fraud_hold.expired` | commercial | system (`fraud_hold_sweep`) | none (platform) | fraud_hold | — | succeeded | `product_id`: uuid | A fraud hold reached its 14-day review deadline unreleased: its restriction ended there; the denied paid time is compensated. |
| `recovery_obligation.opened` | commercial | system (`recovery_worker`) | required | recovery_obligation | — | succeeded | `dispute_id`: uuid<br>`assistance_request_id`: uuid<br>`base_amount`: integer 1–9007199254740991 | A verified full final lost chargeback of an assisted purchase: the Organization owes the base amount only; the beneficiary keeps the entitlement; new assistance is restricted (T3). |
| `recovery_payment.recorded` | commercial | system (`payment_event_consumer`, `payment_reconciler`) | required | recovery_obligation | — | succeeded | `payment_request_id`: uuid<br>`recovered_amount`: integer 0–9007199254740991<br>`surplus_amount`: integer 0–9007199254740991 | A verified recovery-settlement payment, recorded once: the part recovering the base and the surplus beyond it. |
| `recovery_obligation.recovered` | commercial | system (`payment_event_consumer`, `payment_reconciler`) | required | recovery_obligation | — | succeeded | — | Verified recoveries reached the base amount: the obligation is recovered once and its T3 restriction ends. |
| `recovery_surplus.recorded` | commercial | system (`payment_event_consumer`, `payment_reconciler`) | required | recovery_surplus | — | succeeded | `amount`: integer 1–9007199254740991 | A verified recovery payment beyond the base: a surplus owed to the Organization (not revenue, not a loss, no expiry, never offset). |
| `recovery_surplus.resolved` | commercial | user (owner); system (`refund_effect_worker`) | required | recovery_surplus | — | succeeded | `method`: full_refund \| external_execution_evidenced<br>`refund_case_id`?: uuid<br>`file_id`?: uuid | A surplus resolution: the completed full refund of an entirely surplus payment, or the Owner's evidenced record of an external repayment (which the Organization then confirms). |
| `recovery_surplus.recipient_confirmed` | commercial | user (member) | required | recovery_surplus | — | succeeded | — | The receiving Organization's administrator confirmed an external surplus repayment: the surplus is resolved. |

## payment-service (13)

| Action | Category | Actors | Organization | Resource | Subject | Outcomes | Changes | Purpose |
|---|---|---|---|---|---|---|---|---|
| `payment.created` | commercial | service | as recorded (UUID or null) | payment | — | succeeded | — | A service asks for money to be collected. |
| `payment.cancelled` | commercial | service | as recorded (UUID or null) | payment | — | succeeded | — | A pending collection is cancelled by its requester. |
| `payment.succeeded` | commercial | user (member, owner, operator); service; system (`payment_webhook`, `payment_attempt_resolver`) | as recorded (UUID or null) | payment | — | succeeded | `settled_method`: gateway | Money is accepted as settled. |
| `payment.failed` | commercial | user (member, owner, operator); service; system (`payment_webhook`, `payment_attempt_resolver`) | as recorded (UUID or null) | payment | — | succeeded | — | A collection definitively failed. |
| `payment.expired` | commercial | system (`payment_expiry_sweep`) | as recorded (UUID or null) | payment | — | succeeded | — | A collection lapsed unpaid. |
| `refund_attempt.authorized` | commercial | service; system (`payment_refund_worker`) | as recorded (UUID or null) | refund_attempt | — | succeeded | `payment_id`: uuid<br>`refund_case_id`: uuid | Auth confirmed the Owner's single-use refund authorization for exactly this refund attempt: the refund may now be sent to the provider. |
| `refund_attempt.failed` | commercial | system (`payment_webhook`, `payment_refund_worker`) | as recorded (UUID or null) | refund_attempt | — | succeeded | `payment_id`: uuid<br>`refund_case_id`: uuid | The provider definitively refused or failed an authorized refund (a further attempt needs a new authorization). |
| `payment_dispute.opened` | commercial | system (`payment_webhook`) | as recorded (UUID or null) | payment_dispute | — | succeeded | `payment_id`: uuid | A verified provider dispute of a captured payment was recorded, in the exposure the provider states (it changes no entitlement). |
| `payment_dispute.closed` | commercial | system (`payment_webhook`) | as recorded (UUID or null) | payment_dispute | — | succeeded | `payment_id`: uuid<br>`outcome`: won \| lost | The provider's final outcome of a dispute, once (a later contradictory notification never replaces it). |
| `payment_dispute.evidence_added` | commercial | user (owner) | as recorded (UUID or null) | payment_dispute | — | succeeded | `payment_id`: uuid<br>`file_id`: uuid<br>`grant_id`: uuid | The Owner of the seller Company added a reference to a file File granted Payment as evidence of this open dispute. |
| `payment_dispute.decided` | commercial | user (owner) | as recorded (UUID or null) | payment_dispute | — | succeeded | `payment_id`: uuid<br>`decision`: contest \| accept | The Owner's contest-or-accept decision on a dispute, authorized by a consumed Auth dispute-decision receipt (the provider still decides the outcome). |
| `refund_authorization.completed` | commercial | system (`payment_webhook`, `payment_refund_worker`) | as recorded (UUID or null) | refund_authorization | — | succeeded | `payment_id`: uuid<br>`refund_case_id`: uuid<br>`refund_attempt_id`: uuid | Verified provider refund evidence reached the full approved refund: the refund is financially complete, once. |
| `refund_attempt.succeeded` | commercial | system (`payment_webhook`, `payment_refund_worker`) | as recorded (UUID or null) | refund_attempt | — | succeeded | `payment_id`: uuid<br>`refund_case_id`: uuid<br>`fact_id`: uuid | The provider's verified evidence shows the full refund was made (money returned); its commercial effects are later stages. |

## file-service (7)

| Action | Category | Actors | Organization | Resource | Subject | Outcomes | Changes | Purpose |
|---|---|---|---|---|---|---|---|---|
| `file.deleted` | business | service | as recorded (UUID or null) | file | — | succeeded | — | A stored document is deleted at its owner service's request (irreversible loss of content). |
| `file.integrity_incident` | security | system (`file_download_integrity_check`, `file_reconciliation`) | as recorded (UUID or null) | file | — | succeeded | `reason`: digest_mismatch \| size_mismatch \| object_missing | Stored content no longer matches its record (altered, truncated or missing): possible tampering or loss. |
| `file.grant_issued` | security | service | as recorded (UUID or null) | file_evidence_grant | — | succeeded | `file_id`: uuid<br>`purpose`: dispute_evidence \| surplus_evidence \| settlement_evidence \| fraud_evidence<br>`case_ref`: uuid<br>`expires_at`: timestamp | A file's owner service granted another Core service the time-bounded use of that file as evidence of one case. |
| `file.grant_revoked` | security | service | as recorded (UUID or null) | file_evidence_grant | — | succeeded | `file_id`: uuid<br>`purpose`: dispute_evidence \| surplus_evidence \| settlement_evidence \| fraud_evidence | A file's owner service revoked an evidence grant: the grantee can no longer use the file for that case. |
| `file.granted_read` | security | service; system (`file_granted_ticket_redemption`) | as recorded (UUID or null) | file_evidence_grant | — | succeeded | `file_id`: uuid<br>`purpose`: dispute_evidence \| surplus_evidence \| settlement_evidence \| fraud_evidence<br>`access`: metadata \| content_authorized \| ticket_issued \| ticket_redemption_authorized \| ticket_redemption_committed \| ticket_redemption_uncertain \| ticket_redemption_released | A Core service was authorized, through an active evidence grant, to read a file's metadata or content or to issue or redeem a download ticket for it (authorization, not proof of delivery). |
| `file.hold_placed` | security | service | as recorded (UUID or null) | file_hold | — | succeeded | `file_id`: uuid<br>`hold_ref`: uuid | A file's owner service placed an evidence hold on it: the file can no longer be deleted while the hold is active. |
| `file.hold_released` | security | service | as recorded (UUID or null) | file_hold | — | succeeded | `file_id`: uuid<br>`hold_ref`: uuid | A file's owner service released one of its evidence holds: the file may be deleted again once no other hold is active. |

## audit-service (3)

| Action | Category | Actors | Organization | Resource | Subject | Outcomes | Changes | Purpose |
|---|---|---|---|---|---|---|---|---|
| `audit_legal_hold.placed` | security | user (owner) | none (platform) | audit_legal_hold | — | succeeded | `company_id`: uuid<br>`reason_code`: token<br>`window_from`?: timestamp<br>`window_to`?: timestamp | A Company owner, after a fresh factor-only step-up, placed a legal hold on their Company's trusted audit evidence: retention can no longer purge it. |
| `audit_legal_hold.released` | security | user (owner) | none (platform) | audit_legal_hold | — | succeeded | `company_id`: uuid<br>`reason_code`: token | A Company owner, after a fresh factor-only step-up, released one legal hold of their Company: retention may purge that evidence again under its policy. |
| `platform_query.executed` | security | user (owner, operator); service | none (platform) | platform_query | — | succeeded | `target`: all \| organization \| platform \| company \| operator_platform<br>`window_days`: integer 1–31<br>`result_count`: integer 0–100<br>`page`: first \| next<br>`filtered`: boolean<br>`organization_id`?: uuid<br>`company_id`?: uuid<br>`platform_id`?: uuid | Audit evidence was read with a privileged scope: by a trusted service (across organizations or platform-level), by a Company owner (one organization of their Company, or their Company's trusted timeline), or by an operator (an assigned Platform's trusted records). Who, when, which scope, how broadly. |

## release-service (4)

| Action | Category | Actors | Organization | Resource | Subject | Outcomes | Changes | Purpose |
|---|---|---|---|---|---|---|---|---|
| `release.registered` | administrative | service | none (platform) | release | — | succeeded | `product_id`: uuid<br>`component_id`: uuid<br>`kind`: backend \| web \| desktop \| mobile_ios \| mobile_android | Automation declares that a build of a product component exists (a new, immutable release; not yet offered to clients). |
| `release.published` | administrative | service | none (platform) | release | — | succeeded | `product_id`: uuid<br>`component_id`: uuid<br>`kind`: backend \| web \| desktop \| mobile_ios \| mobile_android | Automation publishes a registered release: it may become the latest version that clients are offered or required to use. |
| `release.withdrawn` | security | user (owner) | none (platform) | release | — | succeeded | `product_id`: uuid<br>`component_id`: uuid<br>`kind`: backend \| web \| desktop \| mobile_ios \| mobile_android | A published release is withdrawn: it stops being offered, and clients running it are required to update. |
| `compatibility_policy.changed` | security | user (owner) | none (platform) | component | — | succeeded | `product_id`: uuid<br>`kind`: web \| desktop \| mobile_ios \| mobile_android<br>`policy_version`: {from, to} of integer 0–2147483647<br>`minimum_release_id`: uuid<br>`previous_minimum_release_id`?: uuid | A client component's minimum supported version changes: clients below it are required to update. |

## notification-service (0)

No action: no privileged Notification capability exists (Stage 18.1 A64). Delivery history stays in
notification-service.

**Total: 101 actions.**
