# Core V2 S3: Billing — stage record

| | |
|---|---|
| Stage | S3 Billing, MANDATORY for development and simulation; production gated (G-2, DG-4) ([execution roadmap](./core-v2-s-execution-roadmap.md) §4.3; [ADR-0044](../adr/0044-subscription-entitlement-final-model.md) Part B; [ADR-0045](../adr/0045-commercial-entitlementkind-compatibility-fields.md); [S0](./core-v2-s0-architecture-freeze.md) §3.2, §3.6, §3.9) |
| Record created | 2026-10-30, Phase 4 of the Owner's post-S6 plan (documentation and evidence only), on `main` at `18b0089` |
| Why now | Roadmap §2.2 (5) asks for a stage record created at authorization; none was. This record assembles the evidence; it adds no test and changes no behaviour |
| **Verdict** | **CONDITIONAL PASS — development and simulation.** S3a to S3g and BIL-12 are merged and every S3 certification-gate criterion for the invariants S3 introduces has database-level and API-level evidence (§2). DB-5 (S5b), DB-6 and DB-8 (S6f) are introduced and tested by their own stages. **Open:** the catalog VALUES (OD-05), EVT-05 (`billing.subscription.*`), the production invoice legal content (B-001, B-006, B-007, B-028) and DG-4. **Operational acceptance: none in scope** (G-2) |

Evidence levels: **L** per-service tests on real PostgreSQL and the SQL invariant suite (`apps/billing-service/db/tests/invariants.sql`,
bypassing the application) in `core-ci-passed`; **I** cross-process suites; **O** an operational environment (none; none in scope).

## 1. Work packages and their merges

| Id | Content | PR (merge) |
|---|---|---|
| S3a | `product.platformId`, `subscriptionTarget`; the `invoice_entitlement` routing record; DB-1 to DB-4, DB-7; fifth purpose `non_entitlement` (Owner Option C) | #363 (`79d8d7d`) |
| S3b | direct `activate()` / `renew()` retired; Organization periods only through a recorded verified settlement; DB-9 to DB-11 | #364 (`5e84e16`) |
| S3c | Personal Subscriptions, the purchase ledger, K-3 Option D re-lay, DB-12, the B6 entitlement read | #365 (`0958b2c`) |
| S3d | `billing_platform` (Owner-verified, immutable `companyId`), live `/auth/me` and platform-access checks, currency enforcement | #366 (`a15d9c7`) |
| S3e | fixed grace: Organization exactly 24 hours, Personal none; `SUBSCRIPTION_GRACE_DAYS` retired (DOC-5 written in the Billing SDD) | #367 (`147b8ff`) |
| S3f | fee caps, delegations and proposals; direct checkout for simulation (BIL-10, Owner D1 to D6, D4 Option A) | #370 (`cdd8151`), #371 (`645023c`) |
| S3g | Owner catalog administration for personal products (BIL-02, BIL-03; D-CAT-1 to D-CAT-10) | #372 (`a181639`) |
| BIL-12 | the member's own personal subscriptions, `GET /billing/me/platforms/:platformId/personal-subscriptions` (the Owner's D-B1 to D-B7, 2026-11-01); development and simulation only | contract #423 (`b5614e1`), implementation #424 (`65aaaf1`) |

## 2. Certification gate (roadmap §4.3)

| Criterion | Level | Evidence | Status |
|---|---|---|---|
| DB-1 routing record immutable | L | `apps/billing-service/test/invoice-routing.e2e-spec.ts`, `runtime-role.e2e-spec.ts` (direct SQL as the runtime role) | PASS |
| DB-2 exactly one routing record per non-draft invoice | L | `invoice-routing.e2e-spec.ts`; `db/tests/invariants.sql` | PASS |
| DB-3, DB-4 valid combinations; target agrees with the product | L | `invoice-routing.e2e-spec.ts` | PASS |
| DB-7 server-determined beneficiary, references and amounts | L | `invoice-routing.e2e-spec.ts` | PASS |
| DB-9, DB-10 each effect in its own table, at most one per invoice | L | `subscription-settlement.e2e-spec.ts`, `personal-subscriptions.e2e-spec.ts`, `runtime-role.e2e-spec.ts`; `invariants.sql` | PASS |
| DB-11 no Organization period without an Organization settlement | L | `subscription-settlement.e2e-spec.ts`, `subscription-hardening.e2e-spec.ts`, `subscription-grace.e2e-spec.ts`, `migrations.e2e-spec.ts`; `invariants.sql` | PASS |
| DB-12 one purchase per assistance request | L | `personal-subscriptions.e2e-spec.ts`, `assisted-settlement.e2e-spec.ts` (S5b) | PASS |
| DB-5 (assistance agreement), DB-6 and DB-8 (recovery) | L | introduced by S5b and S6f: `assisted-settlement.e2e-spec.ts`; `recovery.e2e-spec.ts` ("the database refuses … another amount, another invoice") and the [S6 report](./core-v2-s6-financial-certification.md) §3.4 | PASS (in their stages) |
| Personal and recovery invoices inert for `subscription` on every path | L | `personal-subscriptions.e2e-spec.ts` ("an Organization subscription invoice never creates a Personal Subscription …"; "an ordinary (non_entitlement) paid invoice is inert"); `recovery.e2e-spec.ts` (routed `recovery_settlement`, no entitlement) | PASS |
| Grace exactly 24 hours (Organization) and none (Personal) | L | `subscription-grace.e2e-spec.ts`; `personal-subscriptions.e2e-spec.ts` ("no grace: the moment the last kept period ends …") | PASS |
| K-3 Option D re-lay property tests | L | `personal-subscriptions.e2e-spec.ts` "property: for random ledgers and reversals, kept periods never overlap, keep their order and full duration, and never start before their settlement" | PASS |
| V1 `invoice.created` compatibility | L, I | `invoices.e2e-spec.ts`; `libs/service-kit/test/rabbitmq-publisher-identity.int-spec.ts` | PASS |
| S3/S4 joint checkpoint: checkout → attempt → fact → `payment.*` → verified consumption (S1) → purchase → personal entitlement read | I | **one continuous cross-process run** (#410, `adb453c`): `test/e2e-real-broker/s3s4-joint-checkpoint.e2e-spec.ts` — the built auth-service, billing-service and payment-service over real HTTP, a real RabbitMQ and real PostgreSQL, on the simulation provider: the Owner's Platform and catalog → a member's checkout → Billing's dispatcher creates the payment → the payer's attempt → the provider's signed notification → one verified capture fact → `payment.succeeded` under Payment's broker identity → Billing's verified-only consumer (`event_provenance.verified`) → exactly one purchase → the Personal Subscription → the entitlement read through its service contract. Negative cases: duplicate provider notification and real broker redelivery (no second effect), a forged unverified `payment.succeeded` (refused `untrusted_unverified_original`), fail-closed checkout, attempt and entitlement read, Auth unavailable (503, nothing written). 6/6, in CI's `e2e-real-broker` job. (The earlier in-service chain `checkout.e2e-spec.ts` remains as per-service evidence) | PASS |
| BIL-12 the member's own read: the caller's own bearer verified live (`/auth/me` on every request), Owners, Operators and inactive users refused (`403 member_not_eligible`), a service token never forwarded (`401`), Auth down `503`, no membership required; only the caller's recorded Personal Subscriptions on the path's Platform (never another member's, another Platform's, an Organization Subscription or a non-personal product); `valid` and `expiresAt` equal to B6 item by item at one instant; strict unsigned cursor filtered by user and Platform independently of its content; every table unchanged by the read; no route in production | L | `member-personal-subscriptions.e2e-spec.ts` (17 tests); B6 parity at one instant (`test/support/member-read.ts`) after a completed refund, a direct and an assisted final-lost chargeback (B10), an unfinalized and a partial chargeback, a fraud hold placed and released with C-1 compensation (`refund-cases.e2e-spec.ts`), an assisted purchase (`assisted-settlement.e2e-spec.ts`) and an L-4 late settlement (`late-settlements.e2e-spec.ts`); #424 CI 24/24 | PASS |
| Protocol: CI `core-ci-passed`; S3 migrations expand-first, applying on the full chain | L | every PR above; `migrations.e2e-spec.ts` | PASS |

## 3. Open, blocked and deferred

| Item | State | Effect |
|---|---|---|
| **OD-05** catalog VALUES (product codes, names, durations, amounts, dates) | OPEN (the capability is built, D-CAT-1) | the catalog gate still holds any real catalog configuration |
| **BIL-12** `GET /billing/me/platforms/:platformId/personal-subscriptions` | IMPLEMENTED (#424), development and simulation only | none at development level; its production mounting follows DG-4 |
| **F-INV-1** Billing's invoice list (`GET /billing/invoices`, `InvoiceRepository.listForCaller`, ADR-0034) compares its millisecond cursor with the microsecond `createdAt`, so invoices created within the same millisecond can be skipped across a page boundary | OPEN, independent follow-up (found during BIL-12, 2026-11-01); Owner approval needed for a separate Billing fix | a pre-existing V1 read, not an S3 certification-gate criterion; not fixed here; BIL-12 itself compares at millisecond precision |
| **EVT-05** `billing.subscription.*` events | not approved | Billing produces only `invoice.created` |
| Invoice legal content for production: legal issuer (B-001), tax (B-006), numbering and content (B-007), who may issue (B-028) | OPEN (Billing SDD) | checkout uses simulation reference snapshots only |
| **DG-4** manual or automated billing for the pilot | OPEN (Owner decision) | Billing production disposition undecided |
| **OD-BRK-3** Billing off the shared dead-letter exchange before its first deployment | OPEN | S1 record §4 |
| Production deployment and configuration of Billing | NOT IN SCOPE (G-2) | Billing is not in production; checkout is unmounted in production and refused by the service (`checkout.e2e-spec.ts`) |

## 4. Unresolved contract decisions and their impact

- ADR-0044 Part B and ADR-0045 remain **Proposed** (G-1); this record does not accept them.
- The Option D fold (`start = max(settledAt, previous kept end)`) is the implemented interpretation of K-3 Option D, flagged at S3c and
  covered by the property test; any change to it is a contract change.
- OD-01 (checkout eligibility) is resolved by B6 for development; production eligibility follows DG-4.

## 5. Verdict

**S3: CONDITIONAL PASS (development and simulation).** The conditions are the open catalog values, EVT-05 and the production legal
and disposition decisions of §3 (BIL-12 is implemented, §7). No production claim is made.

## 6. Update (2026-10-31): joint checkpoint and S-INT entry classification

- The S3/S4 joint checkpoint is now evidenced by one continuous cross-process run (#410; §2), replacing the earlier "segmented" status.
  It is simulation-only evidence: no real provider, no production configuration.
- Under the S-INT entry rule ([roadmap](./core-v2-s-execution-roadmap.md) §5, D-3) every S3 certification-gate criterion is PASS at
  development level. Classified conditions ([condition matrix](./core-v2-stage-condition-matrix.md)): OD-05 values, DG-4, OD-BRK-3 (a); invoice legal content (c) / (a); EVT-05 (d).
- **OPEN at development level: BIL-12** (`GET /billing/me/personal-subscriptions`). Its scope is undecided (register BIL-12 E); it is not
  built and not tested, so it is not a fail-closed tested decision (d). **S3 does not meet the S-INT entry rule until the Owner records a
  disposition** (outside Core V2's initial scope, or a work package to implement and test). The verdict is unchanged (CONDITIONAL PASS,
  development and simulation).

## 7. Update (2026-11-01): BIL-12 implemented

- The Owner included BIL-12 in Core V2 and approved its contract (D-B1 to D-B7, register BIL-12, #423). #424 implements it on `main`
  (`65aaaf1`) for development and simulation only, with the §2 evidence; production mounts no route until Billing's production
  activation is separately authorized (DG-4). The read is informational: B6 (BIL-11) stays the only access-decision contract.
- The previous OPEN development-level item is therefore resolved: every S3 certification-gate criterion is PASS at development level,
  and every remaining S3 condition is classified under the S-INT entry rule ([condition matrix](./core-v2-stage-condition-matrix.md)).
  This does not authorize S-INT, which needs the Owner-approved readiness record. The verdict is unchanged (CONDITIONAL PASS,
  development and simulation).
- Recorded separately: **F-INV-1** (§3), the invoice list's millisecond cursor, an independent follow-up for the Owner's decision.
