# Core V2 S1–S8: execution roadmap

- **Status:** PLANNING RECORD, prepared 2026-10-22 under the architecture owner's D-A1 authorization (documentation only), on `main`
  at `b33b6e47ee250611d71f1314308077bdb1562853` (the PR #320 merge of the [S0 architecture freeze](./core-v2-s0-architecture-freeze.md)).
- **Scope:** the eight Core services: Auth, Organization, Billing, Payment, File, Notification, Audit, Release, and the shared
  libraries `libs/service-kit` and `libs/audit-contract`.
- **What this record is:** the execution plan for the S0 stage list ([S0 record](./core-v2-s0-architecture-freeze.md) §7): the scope,
  work packages, prerequisites, dependencies, certification gates, production boundaries, migration and recovery rules and Owner
  approvals of each stage S1 to S8, the S-INT integration certification and the placement of Final Core Validation.
- **What it is not:** an implementation authorization, a production authorization, an ADR status change or a change to the frozen S0
  architecture. **Nothing in this record is implemented.** Where this record and the S0 record differ, the S0 record governs; this
  record only orders and gates its content.
- **Labels:** S1 to S8 and S-INT are planning labels, not directories, packages or services. Work-package ids (S1a, S2-Auth, …) are
  planning labels too. The S0 labels ([INV], [DIR], [OD], [S0], [DEF], [GATE], FC-n, DB-n, V-n, S-n, L-n, R-n, T1–T3, DN-1) keep the
  meaning the S0 record gives them.

## 1. Governance

### 1.1 Authorization model

Every stage, and every work package inside it, needs its own explicit Owner authorization before implementation starts. Approval of
this roadmap is not that authorization. Each work package is reviewed and merged as its own pull request with a green
`core-ci-passed` on an up-to-date branch (repository ruleset, V2-A.3). A merge is never a deployment.

### 1.2 G-1: ADR status

The S0 architecture content is Owner-approved and frozen ([S0 record](./core-v2-s0-architecture-freeze.md) §1.4). Several ADRs it
depends on keep the status **Proposed**: [0035](../adr/0035-financial-service-boundaries.md),
[0036](../adr/0036-money-parties-and-source-references.md), [0044](../adr/0044-subscription-entitlement-final-model.md) (Part B),
[0045](../adr/0045-commercial-entitlementkind-compatibility-fields.md), [0057](../adr/0057-messaging-conventions.md) (§13),
[0067](../adr/0067-auth-authorization-receipts-for-owner-approved-refunds.md),
[0068](../adr/0068-no-cash-settlement-for-nawara-sold-products.md) and
[0069](../adr/0069-verified-audit-producers-and-audit-contract-v2.md). The Accepted ADRs
[0007](../adr/0007-out-of-band-cash-payment-confirmation.md), [0049](../adr/0049-audit-trail-architecture.md) and
[0060](../adr/0060-company-platform-organization-lifecycle.md) are not edited and carry no reciprocal notes yet.

This record changes no ADR status. The rules are:

1. A stage that implements a Proposed ADR starts only on an explicit stage authorization that names that ADR. The authorization
   records whether the ADR's acceptance is required before, with or after the stage. The repository precedent of implementing and
   certifying under a Proposed ADR (A3M under ADR-0057) is not by itself that authorization.
2. Every ADR status change and every reciprocal note on an Accepted ADR (0007, 0049, 0060) is a separate, explicit Owner approval,
   one ADR at a time ([S0 record](./core-v2-s0-architecture-freeze.md) §6).
3. ADR-0069 is accepted with or after ADR-0057. ADR-0068's partial supersession of ADR-0007 takes effect only when ADR-0068 is
   Accepted.
4. ADR number 0066 is skipped (a draft exists on an unmerged branch); numbering is re-checked at every ADR merge.

### 1.3 G-2: V2 development versus production activation

Billing and Payment **development and simulation certification** (S3 to S6) belong to Core V2: the S0 freeze places them in the
Core V2 scope and states that Core V2 is implemented and certified against a simulation provider only
([S0 record](./core-v2-s0-architecture-freeze.md) §1.1, §7). **Production activation** of Billing and Payment stays separately
gated and is not decided by this record.

The historical roadmap decisions are preserved and not overridden here. [`CORE-ROADMAP.md`](../CORE-ROADMAP.md) (rescoped
2026-10-13) records A10 Billing as **DECISION REQUIRED (DG-4)**, A11 Payment as **MOVE V3** and the production enablement of Release
and Payment as **MOVE V3**; [`CORE-V3-ROADMAP.md`](../CORE-V3-ROADMAP.md) carries the matching A10 and A11 rows. These documents
predate S0 and do not yet describe the S1–S8 development scope. Reconciling them is documentation item DOC-3 (§8), which needs its
own authorization and must happen **before S3 and S4 start**. Until it is done:

- S3 to S6 deliver repository, CI and local certification on simulation only;
- no Billing, Payment or Release production deployment, configuration or credential is in scope of any S-stage;
- DG-4 (manual or automated billing for the pilot) remains an open Owner decision for production, not for development.

### 1.4 G-3: contracts missing from the repository

Two specifications that dependent stages need exist only in the Core V2 architecture-review packages, which are not stored in the
repository ([S0 record](./core-v2-s0-architecture-freeze.md), labels note and §3.10):

| Missing specification | Content | Required before |
|---|---|---|
| **R-6a** | the correction of the organization-administrator grant facts in Auth (S0 §3.10, Auth group) | S2-Auth's R-6a work package |
| **AR-04.6 contract register** | new and extended routes, DTOs, error codes and idempotency classes for Auth, Billing, Payment, File, Audit and Release (S0 §3.10) | the implementation review of every work package that adds or changes a route: S2 (all tracks), S3, S4, S5, S6 |

Both are documentation prerequisites (DOC-1, DOC-2 in §8). They are written into the repository under their own documentation
authorization; route and DTO names are confirmed at implementation review (S0 §3.10). No dependent work package starts while its
specification is missing.

### 1.5 Production boundaries and preserved gates

- **Production hierarchy authority** stays with Auth; organization-service stays non-authoritative. **G6** (certified) and **F7**
  (locked) are unchanged, as are G7 and F6. The production ownership track runs only in its own order (M2 → G7 → F6 → F7 → post-F7
  backup, [`CORE-ROADMAP.md`](../CORE-ROADMAP.md)) and no S-stage shortens, reorders or depends on running it.
- **No S-stage deploys.** Auth, Organization and Audit merges build revision-labelled images only; deployments are explicit,
  owner-authorized digest deployments ([`auth-service-deploy.md`](../runbooks/auth-service-deploy.md),
  [`digest-deployments.md`](../runbooks/digest-deployments.md)). Every production SSH workflow waits for approval of the protected
  `production` environment.
- **G6 baseline (gate G-7, §7).** New Auth, Organization or Audit migrations change the migration fingerprints that the G6 rehearsal
  matched against production. No S-stage Auth or Organization image is proposed for production before the M3 cutover steps complete,
  unless the Owner first authorizes the G6 baseline refresh that covers it.
- **PR #319** is on hold. Its reconciliation needs separate authorization and precedes any Organization-related implementation (S8).
- **Final Core Validation** is the absolute last full validation (§6) and is never run as part of an S-stage or of S-INT.

## 2. Rules common to every stage

### 2.1 Database migration compatibility

- Migrations are additive and expand-first: new tables, new nullable columns, new constraints that existing rows already satisfy.
  A contract step (dropping or tightening what the previous image needs) is its own later work package with its own authorization.
- The previous image of a service must run correctly against the expanded schema, so a rollback is the redeployment of the previous
  digest, never a down migration. Down migrations exist for local use only; production migrations are forward-only (pilot readiness
  gate, [`CORE-ROADMAP.md`](../CORE-ROADMAP.md)), and roles are applied before migrations.
- Append-only and immutable tables (provider facts, routing records, purchase ledger entries, provenance, scope rows, legal holds,
  receipts, corrections) are never updated or deleted by any recovery procedure; recovery appends corrections.
- Database invariants of [S0 §3.2](./core-v2-s0-architecture-freeze.md) (DB-1 to DB-17) are enforced in the database, not only in
  application code, and each has a negative test that bypasses the application.

### 2.2 Certification of a stage

Each stage is certified on its own by the [V2 per-capability validation protocol](./core-v2-a-baseline-and-change-safety.md#8-v2-per-capability-validation-protocol):

1. a negative test, at the database or API level, for every invariant the stage introduces;
2. fault injection at every transaction boundary the stage introduces ([S0 §8](./core-v2-s0-architecture-freeze.md));
3. risk-based regression of the existing contracts it touches (HTTP status, `code`, response shape, event payloads);
4. CI with `core-ci-passed`; `libs/service-kit` and `libs/audit-contract` rebuilt before dependent tests (stale `dist/` is never
   evidence);
5. a stage record (`core-v2-s<n>-<topic>.md`) created when the stage is authorized, holding its evidence; certification is closed by
   the merge of that record's certification PR.

Certification is repository, CI and local evidence. It is never production evidence and never an ADR acceptance.

### 2.3 G6 labels

Every work package carries a G6 label ([`CORE-ROADMAP.md`](../CORE-ROADMAP.md), G6). A 🔴 item stops S-stage work on that item until
the production track has run.

## 3. Dependencies and implementation order

```text
                     S0 (frozen; PR #320, b33b6e4)
                               │
   documentation prerequisites: DOC-1 / DOC-2 (G-3), DOC-3 (G-2), G-1 recorded per stage
                               ▼
     S1  event security                              code 🟢 · rollout 🟡
         S1a publisher identity ► S1b provenance (observe-only) ► S1c stored-row retries, re-emission
         S1d permission generator · S1e per-consumer enforcement switches
         S1-R production rollout, one authorization per step:
              provisioning ► narrowed permissions ► C-4 dead-letter inventory ► enforcement per consumer
                               ▼
     S2  independent foundations (four tracks, any order)
         S2-Auth   receipts, AUTH_SERVICE_POLICY, step-up purpose, R-6a ────────────┐
         S2-Audit  contract v2, verified producers, scope, holds (needs S1b) ────────┤
         S2-File   evidence grants, holds, ticket lease ─────────────────────────────┤
         S2-Rel    owner reads (leaf)                                                │
                               │                                                     │
             ┌─────────────────┴────────────────┐                                    │
             ▼                                  ▼                                    │
     S3  Billing                         S4  Payment          (parallel)             │
         routing, guards, personal           finality, facts, payer/purpose,         │
         ledger, billing_platform,           liveMode, simulation adapter,           │
         fixed grace  [catalog gate]         90-day idempotency                      │
             └─────────────────┬────────────────┘                                    │
                               ▼  S3/S4 joint checkpoint: direct purchase on simulation
     S5  assistance, cash, T1/T2, D6, restriction framework   [V-4, V-5]             │
                               ▼                                                     │
     S6  refunds, disputes, recovery (T3), reconciliation, losses ◄──────────────────┘
                               │
             ├──► S7  Notification inbox, Auth tenure      CONDITIONAL (C-3, C-6)
             ├──► S8  Organization authority changes       CONDITIONAL (PR #319, C-5; RED blocked until F7)
                               ▼
     S-INT  Core V2 integration certification
                               ▼
     production track (M2 → G7 → F6 → F7 → …), pilot gate M13 / A19       [separate, Owner-authorized]
                               ▼
     Final Core Validation (Stage 22): ABSOLUTE LAST
```

| Stage | Depends on | Unblocks |
|---|---|---|
| S1 | stage authorization (G-1); no code dependency; C-4 before production enforcement | S2-Audit, S3 (Billing ← Payment enforcement), S2 to S6 event families |
| S2-Auth | DOC-1 (R-6a), DOC-2 | S6 refunds |
| S2-Audit | S1b, DOC-2 | S6 (verified financial accountability) |
| S2-File | DOC-2 | S5 and S6 evidence |
| S2-Rel | DOC-2 | nothing |
| S3 | S1, DOC-2, DOC-3, catalog gate for S3g | S5, S6 |
| S4 | S1, DOC-2, DOC-3, simulation-adapter decision | S5, S6 |
| S5 | S3, S4, V-5, V-4 (for D6 enforcement) | S6 |
| S6 | S2-Auth, S2-Audit, S2-File, S3, S4, S5 | S-INT, S7 |
| S7 | C-3, C-6 decided; S3 | S-INT (if in scope) |
| S8 | PR #319 reconciliation, C-5, A5.4-G1 classification; F7 for RED items | S-INT (if in scope) |
| S-INT | S1 to S6; S7 and S8 if in scope | Final Core Validation (with the production track and A19) |

## 4. Stages

Each stage lists: objectives; affected services and libraries; work packages; prerequisites; security and financial invariants;
certification gate; production boundary; migration and recovery; Owner approvals before each slice.

### 4.1 S1: event security — MANDATORY

- **Objectives.** Broker-verified producer identity and durable provenance for every event family
  ([ADR-0057](../adr/0057-messaging-conventions.md) §13; [ADR-0069](../adr/0069-verified-audit-producers-and-audit-contract-v2.md)
  decision 1), structurally addressing the open A3M findings F1 (forged events to Notification) and F2 (Audit's first-writer
  residual) ([A3M record](./core-v2-a3m-messaging.md)).
- **Affected.** `libs/service-kit` (publisher, consumer, provenance); every producer (Auth, Billing, Payment and each `audit.*`
  producer) and consumer (Billing, Notification, Audit); `infra/rabbitmq/provision.sh` (code only).
- **Work packages.**

  | Id | Content | Label |
  |---|---|---|
  | S1a | publisher sets AMQP `user_id` to its own broker username, derived from its own connection so the two cannot differ (§13.1); a real-broker test proving the broker refuses a mismatch (S0 §9) | 🟢 |
  | S1b | `event_provenance` per consumer, committed in its own transaction before the handler; a failed commit holds and requeues, never `Q.retry` (§13.2, §13.3); **observe-only** | 🟢 |
  | S1b-2 | Audit provenance, observe-only, under the §13.2 Audit admission clarification (S0-C1): canonical body bytes, the Stage 18.8 confidentiality screen and complete audit-contract validation run before provenance, on event-exchange and default-exchange deliveries; a refusal (or any exception) is permanent, with no handler, no `Q.retry`, no provenance row and no persistent body digest, and keeps the privacy-safe dead-letter redaction; Audit's provenance migration follows 0004; no provenance purge; Billing's S1b behaviour unchanged | 🟢 (production: M9, G-7, AP-R) |
  | S1b-3 | Notification provenance, observe-only, under the §13.2 S0-C2 revision: for all nine Auth events Notification consumes, the body element is `bodyMac` (HMAC-SHA-256 of the complete raw body bytes under a dedicated Notification provenance key ring, separate from `NOTIFICATION_SECRET_KEYS`; `bodyMacKeyId`, `bodyCommitmentVersion`), never an unkeyed digest or fallback; comparisons under the stored row's key (no false conflict on rotation); a missing or unusable active key keeps the consumer not ready, and a commitment that cannot be computed is a failed commit (§13.3); the `check:repo` provenance guard admits Notification only with the keyed commitment; Notification's provenance migration is its next free number; no provenance purge; no event-contract, Auth, Billing or Audit change | 🟢 (production: NP-K) |
  | S1c | default-exchange deliveries processed only against a stored row (§13.4; the end state, enforced from S1e: S1c observes only, see Rollout below); de-duplication by verified source (likewise classification only until S1e); owner-authorized re-emission of one named outbox row with an audit record (§13.7); retention ≥ dead-letter retention + retry window (§13.8). An Audit delivery refused at admission (S0-C1) has no original provenance row and is never treated as a verified replay; recovering a legitimate catalog-lag Audit event needs a separately designed and authorized mechanism consistent with §13.7. For Notification (S0-C2), the §13.4 body match recomputes the keyed commitment under the stored row's version and key id; a row whose key is retired or cannot be resolved never matches and never establishes a verified replay. **Rollout (S0-C3):** S1c delivers the §13.4 rule as an observe-only, closed-set replay classification (`replay_matched_verified`, `replay_matched_unverified`, `replay_no_provenance`, `replay_mismatch`, `replay_unverifiable`, `replay_lookup_failure`) with no new refusal and no change to any consumer's existing acceptance or de-duplication behaviour; S1e enforces it. Slices: **S1c-1** the classification, with Notification conflict evidence recording `differs` or `unverifiable` through an additive Notification migration (its next free number); **S1c-3** re-emission (§13.7), only after **OD-15** (no S1c-2 is defined by this record). **OD-15 is resolved for Payment-first (S0-C4)**: S1c-3 is delivered as **R1** a shared restricted re-emission command (dry run by default; Owner authorization bound to the exact event; serialization pipeline version 1 checks; durable intent, audit evidence and outcomes), **R2** payment-service (its allow-list of the four `payment.*` version-1 events, an additive attempt-state migration, its audit action), **R3** Auth and Organization (deferred; G-7 / M3; undecided), **R4** the production execution workflow (separate CI and production authorization). Architecture approved; implementation not started | 🟢 |
  | S1d | per-producer topic-write permissions generated from the catalogs and the event-family table (§13.1), code only. **S0-C5** (2026-10-23): exact, escaped, anchored keys from each producer's event contract and audit-catalog actions, activated families only, fail closed; the `amq.default` and shared-DLX write grants stay as a documented residual (S1e stays required); Billing one identity; Billing and Payment grants defined, not provisioned. Slices: **S1d-0** the clarification (documentation); **S1d-1** the catalog-driven grant generator and its `check:repo` verification; **S1d-2** the provisioning code (generated grants in `infra/rabbitmq/provision.sh`, the Billing and Payment definitions, idempotent updates; no production run); **S1d-3** disposable real-broker certification (ADR-0057 S0-C5). Not complete; production grants are not narrowed | 🟢 |
  | S1e | per-consumer enforcement switches; financial consumers never process an unverified event, and Billing ← Payment enforcement is on from Billing's first deployment (§13.5, §13.10); production refuses missing or false `liveMode` in financial and notification consumers (§13.9). S0-C3: the only stage that acts on the S1c replay classification, per consumer, under a separately approved policy whose refusal semantics are decided here; financial consumers enforce before their production activation. S0-C4: enforcement evaluates the authoritative stored verified observation, so an earlier unverified observation never by itself invalidates a later authenticated publication (a re-emission), and conflicting verified evidence is never ignored. **S0-C6** (2026-10-23): the per-consumer policies (trust decided before any handler and any business de-duplication slot; refusals privacy-safe and permanent; transient failures held; Billing verified-only with a trusted replay tuple from an additive migration after a field-use inventory; Audit's temporary compatibility phase with its exit conditions; Notification verified-only, retired key refused, missing key held, no code retained on refusal). Slices: **S1e-0** the clarification (documentation); **S1e-1** kit trust decisions and per-consumer policy before the handler; **S1e-2** Billing; **S1e-3** Audit; **S1e-4** Notification; **S1e-5** real RabbitMQ and PostgreSQL certification. Not started beyond S1e-0; nothing enabled. **S1e-5 is blocked** (2026-10-23): its certification found a code-bearing body kept raw by broker-driven dead-lettering through the shared fanout. It resumes only after OD-BRK-2 is merged (ADR-0057 §8 "OD-BRK-0") | 🟢 |
  | OD-BRK | dead-letter privacy and isolation (ADR-0057 §8 "OD-BRK-0", owner-approved D1 to D3, 2026-10-23). **D1:** Notification has no broker dead-letter exchange, no `.dead` binding to the shared `nawara.events.dlx` and no permission on it; its application-redacted dead letters stay required. Billing follows before its first deployment, Audit's live queue only through a separate migration, and the fanout stays while anything depends on it. **D2:** no dead-letter argument, plus verification of the effective configuration (arguments, regular and operator policies, effective dead-letter settings, shared bindings, permissions). Notification fails readiness or startup on an unapproved route; the mechanism is proven on a disposable broker. **D3:** a privileged broker rejection or expiry may discard a Notification message: never a delivery, never an intake record. Slices: **OD-BRK-0** the clarification (documentation); **OD-BRK-1** the kit opt-in topology and its fail-closed verification; **OD-BRK-2** Notification; **OD-BRK-3** Billing (before its first deployment); **OD-BRK-4** Audit's production migration (S1-R, C-4); **OD-BRK-5** retirement of the shared fanout. Each is separately authorized. OD-BRK-0, OD-BRK-1 and OD-BRK-2a (#345) are merged; OD-BRK-2b-1 (scheduled verification and containment) is implemented but not installed; OD-BRK-2b-2 and OD-BRK-3 to OD-BRK-5 are not started. **Open** until OD-BRK-4 and OD-BRK-5 | 🟢 |
  | S1-R | production rollout in the §13.10 order: publisher identity → observe-only provenance → narrowed permissions (§12 production action) → retry queues drained and **C-4** dead letters inventoried → enforcement per consumer. S0-C5: narrowing needs the generated expected grants, a pre-provisioning inventory, a review of added and removed rights, a verified activation state, the protected production approval, post-provisioning verification and monitoring (outbox lag, Audit delivery, retry and dead-letter depth); restoring a broader grant is a separately authorized security exception, never a default rollback. S0-C6: Billing and Notification enter production with strict enforcement certified (Notification with its NP-K keys); Audit leaves its compatibility phase only after verified publisher identity, C-4, its gates, strict testing and Owner approval, and a return to compatibility is a separately approved exception | 🟡 |

- **Prerequisites.** Stage authorization (G-1, naming ADR-0057 §13 and ADR-0069); the stage record is created at authorization.
  C-4 before any enforcement in production.
- **Invariants.** Broker users have no impersonation tag; no historical event is labelled verified and provenance is never backfilled
  (§13.6); a stored row that differs from a delivery is a permanent `provenance_conflict`; existing `invoice.created` and `payment.*`
  version 1 stay compatible (S0 §3.7).
- **Certification gate.** S0 §8 broker cases: forged `user_id`, wrong exchange, injection through the default exchange, tampered body,
  name or source, replay without a stored row are refused; retries pass; `invoice.created` still flows; broker `user_id`
  enforcement proven. Fault injection between provenance and handler, and after the handler before acknowledgement.
- **Production boundary.** Every S1-R step is a separate Owner authorization and a production action. Any `libs/service-kit` merge
  builds an Auth image (build ≠ deploy).
- **Migration and recovery.** Provenance tables are new and append-only. Observe-only mode is the recovery position: enforcement can be
  switched off per consumer with no data loss. A production permission change is preceded by a recorded export of the broker
  definitions so it can be restored.
- **Audit provenance retention (S1b-2, S0-C1).** No automated Audit provenance purge during development, and no permanent-retention
  requirement: §13.8 is a minimum. A provenance row or digest must not undermine the lawful purge of its Audit record; authorized
  expiry, erasure and legal holds of Audit provenance need an explicit future policy (P-A2 stays OPEN; no duration is set here).
  Production is held by gate AP-R (§7).
- **Audit provenance production (S1b-2).** Production Audit is at migration 0003; 0004 is the M9 prerequisite and Audit's provenance
  migration (proposed 0005) follows it; the fingerprint change is governed by G-7. A merge builds an Audit image only: deployment,
  migration execution and image-digest activation each need separate Owner authorization.
- **Notification provenance keys and retention (S1b-3, S0-C2).** The provenance key ring is configuration held outside the database and
  never committed or logged; configuration names (for example `NOTIFICATION_PROVENANCE_KEYS` and an active key id), their format and
  the secret-management integration are proposed with S1b-3. No key is generated by this record, and development and production keys
  are provisioned only under their own authorization. Each key is kept at least for the §13.8 minimum (a minimum, not a destruction
  date) and retired only under a separately reviewed procedure; a retired key's rows stay, unverifiable. No automated provenance purge;
  Notification history retention is an open product / legal decision, to be reconciled with the keyed commitments, key retention and
  metadata before any erasure policy. Notification is not in production and is not covered by G-7 (no G6 fingerprint is affected);
  production is held by gate NP-K (§7).
- **Owner approvals.** Stage start; each of S1a to S1e; each S1-R step; the C-4 disposition.

### 4.2 S2: independent foundations — MANDATORY

Four tracks with no dependency on each other except S2-Audit on S1b. Each track is its own set of slices.

**S2-Auth** ([ADR-0067](../adr/0067-auth-authorization-receipts-for-owner-approved-refunds.md); auth-service)

- Work packages: the receipts table (new migration); issue with idempotency key, consume, lookup by `consumeRef`; Auth's first
  service-callee route behind a new deny-by-default `AUTH_SERVICE_POLICY`; the factor-only step-up purpose `refund.authorize` (TOTP
  or passkey, never the secret key) and the other new factor-only purposes of the contract register; **R-6a** (G-3).
- Prerequisites: DOC-1 (R-6a) for R-6a; DOC-2 for routes and errors; payment-service's admission as a caller recorded with the
  service-token admissions ([ADR-0042](../adr/0042-service-token-scopes-and-administrative-authorization.md)).
- Invariants: only digests of the secret and the canonical binding are stored, and the plaintext is returned once; lifetime 10
  minutes; a lost-response replay voids only an `issued` receipt; consumption is one conditional update that requires matching
  digests, `issued`, unexpired, and an issuer still active and still Owner of `companyId`; consumption is the commit point;
  `approvedBy` comes only from Auth's consumption response. Issuance, consumption and voiding are audited.
- Certification: negative tests for every refusal (`receipt_issued_response_lost`, `receipt_already_consumed`, a different
  `consumeRef`, `authority_revoked`, wrong audience, expired); fault injection between issue and response and between consumption and
  its response.
- Label 🟢 (development) / 🟡 (production: the Auth digest deployment belongs to M3 and gate G-7).

**S2-Audit** ([ADR-0069](../adr/0069-verified-audit-producers-and-audit-contract-v2.md); audit-service, `libs/audit-contract`)

- Work packages: contract v2 (additive optional fields; `producerIdentityVerified`, `replayed`); verified-producer classification
  over S1 provenance; insert-only scope rows and legal-hold events; the Owner Company timeline and the operator Platform view;
  production refuses `liveMode = false`.
- Prerequisites: S1b; DOC-2.
- Invariants: versions 1 and 2 accepted, a version-1 event for a version-2 action refused; history never rewritten, new columns
  nullable; scope applied before any limit; cursors bound to actor, scope, filters and window; `correlationId` and resource filters
  never widen scope; ownership never inferred; every human read recorded, `503` when it cannot be; the retention role skips held
  records and no normal role deletes.
- Certification: scope-widening negative tests; contract-version tests; append-only controls on `audit_record` unchanged.
- Label 🟢 / 🟡. Production Audit still needs the deployment that applies migration 0004 (M9); S2-Audit migrations stack after it.

**S2-File** (file-service)

- Work packages: evidence grants, granted reads and tickets; holds; the ticket reservation lease.
- Prerequisites: DOC-2. DG-2 (storage provider) does not block development.
- Invariants: a grant never widens Organization scope; a held file cannot be deleted; tickets are single-purpose and bounded.
- Label 🟢 (production enablement stays M8).

**S2-Rel** (release-service)

- Work packages: three Owner reads (products, releases, policy history), verified live under
  [ADR-0050](../adr/0050-platform-administration-and-verified-human-authority.md).
- Prerequisites: DOC-2. Leaf: nothing depends on it. Release production enablement stays MOVE V3 (G-2).

**S2 migration and recovery.** All four tracks add tables and routes and change no existing row; a route is withdrawn by caller
policy or by redeploying the previous image. **Owner approvals:** stage start; each track; each slice; any ADR-0049 reciprocal note
(separately, G-1).

### 4.3 S3: Billing — MANDATORY (development and simulation; production gated, G-2)

- **Objectives.** Explicit settlement routing, the Organization settlement guard, the Personal Subscription and its purchase ledger,
  the commercial-configuration projection and the fixed Core V2 grace ([ADR-0044](../adr/0044-subscription-entitlement-final-model.md)
  Part B, [ADR-0045](../adr/0045-commercial-entitlementkind-compatibility-fields.md); S0 §3.2, §3.6, §3.9).
- **Affected.** billing-service.
- **Work packages.**

  | Id | Content |
  |---|---|
  | S3a | `product.platformId` and `subscriptionTarget` (B1); the `invoice_entitlement` routing record (B2) and DB-1 to DB-10 |
  | S3b | retire the direct `activate()` and `renew()` operations and the "organization + one recurring line" settlement rule, **then** add the DB-11 Organization settlement guard (S-4, B3) |
  | S3c | `PersonalSubscription`, the `SubscriptionPurchase` ledger, K-3 Option D re-lay (B4, B5), DB-12; the personal entitlement read (B6) |
  | S3d | `billing_platform` (immutable `companyId`, written by the Owner after a live `/auth/platform-access` check); live `/auth/me` membership checks; fail closed with `503` |
  | S3e | the fixed grace policy (B13): Organization exactly 24 hours, Personal none; replaces `SUBSCRIPTION_GRACE_DAYS`; same-row check |
  | S3f | fee caps, delegations and proposals (owner approves, operators propose); direct checkout (FC-12) |
  | S3g | Owner catalog administration; **catalog gate** (§7) before any catalog configuration |

- **Prerequisites.** S1 (provenance enforcement for `payment.*` from Billing's first deployment); DOC-2; DOC-3; DOC-5 (Billing SDD
  grace) before S3e.
- **Invariants.** S-4, S-5, S-6; `entitlementKind` never a routing input; a personal or recovery invoice never changes
  `subscription` on any path; an invoice carries at most one entitlement-bearing line; malformed routing refused at issue, and settled
  money on a malformed invoice changes no entitlement and opens reconciliation (B9); one currency per Platform.
- **Certification gate.** A negative test for each of DB-1 to DB-12 through direct SQL and through the API; personal and recovery
  invoices proven inert for `subscription`; grace at exactly 24 hours and at none; Option D re-lay property tests; existing V1
  `invoice.created` compatibility.
- **Production boundary.** None in scope (G-2, DG-4).
- **Migration and recovery.** Billing is not in production; the schema is still expand-first so that a later production activation
  inherits a forward-only history. S3b's retirement of `activate()` / `renew()` precedes the trigger in the same or an earlier
  migration set, never after.
- **Owner approvals.** Stage start; each work package; the catalog gate before S3g configuration.

### 4.4 S4: Payment — MANDATORY (development and simulation; production gated, G-2); in parallel with S3

- **Objectives.** Payment finality, immutable provider facts, payer and purpose, live-mode separation and a simulation provider
  ([ADR-0068](../adr/0068-no-cash-settlement-for-nawara-sold-products.md); [ADR-0035](../adr/0035-financial-service-boundaries.md)
  C1, C2, C4; S0 §3.1, §3.2, §3.7, §3.8).
- **Affected.** payment-service.
- **Work packages.**

  | Id | Content |
  |---|---|
  | S4a | payer, purpose, `liveMode` and scope on payments; DB-15 pairing; immutability of payer, purpose, beneficiary, amount, currency and seller (S-6) |
  | S4b | DB-16: no `settledMethod = 'cash'` with a Company seller (S-7, FC-11) |
  | S4c | `closing` and finality; no second checkout while a payment is uncertain |
  | S4d | `provider_transaction_fact`, committed in its own transaction independently of allocation (FC-1, V-2) |
  | S4e | Organization-payer attempts (assisted and recovery purposes only, B7) |
  | S4f | simulation adapter and harness (non-production only); production refuses to boot with the test or simulation provider or harness; no client-chosen outcomes (FC-10); **simulation-adapter decision** (§7) first |
  | S4g | class-M idempotency of 90 days ([OD] D7) replacing the current `IDEMPOTENCY_TTL_HOURS` ceiling, backed by permanent uniqueness keys (S0 §3.7) |

- **Prerequisites.** S1; DOC-2; DOC-3; DOC-6 (Payment SDD and ADD) before the S4 implementation review.
- **Invariants.** Payment never calls Billing back (C4); facts are never refused, edited or deleted, and identical redeliveries are
  the same fact; every money record and event carries `liveMode`; production refuses non-live events.
- **Certification gate.** Fault injection after a fact commit; identical redelivery yields one fact; DB-15 and DB-16 negative tests
  bypassing the application; production configuration refuses simulation; `payment.*` version 1 compatibility.
- **S3/S4 joint checkpoint.** A direct purchase end to end on simulation: checkout → attempt → fact → `payment.*` → verified
  consumption (S1) → purchase → personal entitlement read. It is evidence for both stages, not a separate certification.
- **Production boundary.** None in scope (G-2; A11 MOVE V3).
- **Migration and recovery.** As S3. DB-16 is added as a CHECK that existing rows satisfy (no code path sets `cash` today).
- **Owner approvals.** Stage start; the simulation-adapter decision; each work package.

### 4.5 S5: assistance and cash obligations — MANDATORY

- **Objectives.** Pay with School assistance requests, cash obligations and restrictions (S0 §3.3, FC-8, FC-9; DN-1).
- **Affected.** billing-service; payment-service (assisted channels from S4e).
- **Work packages.**

  | Id | Content |
  |---|---|
  | S5a | assistance requests: consent, decline, cash collection with `consentAt ≤ cashCollectedAt ≤ reportedAt`, `settleBy = cashCollectedAt + 72h`, a late report born overdue |
  | S5b | the assisted settlement channel (DB-5, DB-13) and the full cash-return obligation, including the school's fee, on a failed settlement |
  | S5c | append-only, Owner-only corrections with step-up (`superseded_by_correction`); student disputes without cutoff (7 days is an escalation target only); the school's dispute response |
  | S5d | the restriction framework: T1, T2 and D6 inactivity block **new** requests only; each clears on verified resolution when no other restriction applies; no persistent repeat-violation state. T3's source arrives in S6. **Status (2026-10-28): T1/T2 implemented for simulation (PR #384); the D6 `inactive` restriction is not active until V-4; T3 deferred to S6f** |
  | S5e | the DN-1 closed set of discharge actions in inactive scopes, with live authority per request and fail-closed behaviour. **V-5 policy Owner-approved (V5-1 to V5-9, 2026-10-28; [register](./core-v2-d-a2-contract-register.md) §7.1); runtime implementation deferred until V-4 and OD-R6a (V5-9)** |

- **Prerequisites.** S3, S4; **V-5** (school actor set) before S5e; **V-4** (effective-state contract) before D6 enforcement; DOC-2.
- **Invariants.** Cash alone never activates and never settles a payment (ADR-0068, ADR-0035 C1); violations are never erased;
  restrictions never block discharge; lifecycle never changes, cancels or derives from commercial state (DN-1.5).
- **Certification gate.** Inactive scopes refuse new requests while every discharge action works for its authorized actors; an Auth
  outage gives `503` with no mutation; FC-8 time-order negative tests; restriction clearing rules.
- **Production boundary.** None in scope. The effective lifecycle state must reach Billing in the release that first allows a scope to
  become inactive (S-9); until then no scope can be inactive (DN-1.4).
- **Migration and recovery.** As S3; corrections are append-only, so recovery never rewrites an obligation.
- **Owner approvals.** Stage start; V-4 and V-5; each work package.

### 4.6 S6: refunds, disputes, recovery, reconciliation and losses — MANDATORY

- **Objectives.** The full post-settlement financial lifecycle (S0 §3.1, §3.4, §3.5; V-1 to V-3; L-1 to L-6; R-1 to R-5;
  ADR-0067 §5–§7; ADR-0044 B5, B8, B10, B11, B14).
- **Affected.** billing-service, payment-service; auth-service (receipt consumption from S2-Auth); file-service (evidence from
  S2-File); audit-service (verified accountability from S2-Audit).
- **Work packages.**

  | Id | Content |
  |---|---|
  | S6a | refund cases: full purchase only ([OD] D4); no new case while a dispute is open (D3) |
  | S6b | Payment's durable refund intent (`consumeRef` = attempt id) → receipt consumption → `authorized`; asynchronous provider dispatch with a stable idempotency key; `authorization_expired` recovery. **Status (2026-10-28): implemented for simulation under the Owner's R6B-1 to R6B-10 (register BIL-24 F, PAY-07 F, PAY-08 F); `authorization_expired` only from Auth's definitive answer (R6B-9, Q8: no margin); no `refund.*` event until S6c** |
  | S6c | allocation (FC-2: lock order, bounded counter, deferred sum check, DB-17) and completion (FC-3, V-3). **Status (2026-10-29): implemented for simulation under the Owner's R6C-1 to R6C-12 (register PAY-07 G, PAY-08 G, BIL-24 G, BIL-25 H, EVT-02)** |
  | S6d | reversal (FC-4, V-1): at most one per purchase, causes appended separately; an assisted purchase lost at final stage is never reversed |
  | S6e | disputes: Owner reads, evidence, decision; fraud holds (evidence-based, step-up, 14-day review, exact-duration compensation) |
  | S6f | recovery obligations and settlement (DB-6, DB-8, B8); `recovery_surplus` R-1 to R-5; T3 wired into the S5 framework |
  | S6g | late assisted settlement L-1 to L-6, with L-4's five evidence conditions |
  | S6h | reconciliation cases and items; fact association; balances (FC-5); `FinancialLoss` (FC-6) |

- **Prerequisites.** S2-Auth, S2-Audit, S2-File, S3, S4, S5; DOC-2; DOC-4 (financial architecture) before the S6 implementation
  review.
- **Invariants.** Facts survive allocation failure; a completed case refuses every new attempt (`409 refund_case_completed`);
  balances are never clamped; a loss only from evidence facts or an owner write-off; a surplus never re-opens or extends T3 and is
  never revenue, loss or access; never two purchases for one assistance request; recovery never creates a purchase or touches
  entitlement.
- **Certification gate.** S0 §8: facts survive allocation failure; a duplicate success becomes excess with no second reversal; a
  refund plus a chargeback on one purchase reverses once; fault injection between intent, consumption and `authorized`; L-4 refused
  when the cash return is confirmed or a purchase exists; R-5.
- **Production boundary.** None in scope. Refunds, write-offs and L-4 decisions are runtime Owner actions, not plan approvals.
- **Migration and recovery.** As S3. Recovery from any partial failure goes through reconciliation; no financial fact is discarded.
- **Owner approvals.** Stage start; each work package.

### 4.7 S7: Notification inbox and Auth tenure — CONDITIONAL

- Starts only if **C-3** (commercial IN_APP notifications) is approved, together with **C-6** (administrator tenure during
  suspension). It is in the S0 deferral register; an amendment of the Accepted
  [ADR-0046](../adr/0046-notification-service-architecture.md) (separately approved) would precede it.
- Affected: notification-service, auth-service. Notification receives no route in Core V2 otherwise (S0 §3.10).
- Independent of S7: DG-3 ([`CORE-ROADMAP.md`](../CORE-ROADMAP.md)) decides whether Notification production work is V2.
- Certification, migration and approval rules: as §2, specified in its stage record if authorized.

### 4.8 S8: Organization authority-dependent changes — CONDITIONAL

- Prerequisites: **PR #319** reconciled under separate authorization; **C-5** (operator Organization creation) decided before any
  operator step-up work; each task classified under A5.4-G1 ([A5 record](./core-v2-a5-organization.md) §9.1): RED tasks stay
  blocked until F7.
- Affected: organization-service, auth-service.
- No production cutover; organization-service stays non-authoritative; human hierarchy reads stay deferred until authority
  activation (S0 §5); G6 and F7 unchanged.
- Certification, migration and approval rules: as §2, specified in its stage record if authorized.

## 5. S-INT: Core V2 integration certification

- **When.** After S1 to S6 are individually certified, and after S7 and S8 if they are in scope.
- **What.** The cross-service paths certified together in a disposable environment, on simulation: direct purchase; assisted
  purchase with cash collection, settlement, failure and cash return; refund with an Owner receipt; dispute and chargeback (direct and
  assisted); recovery and surplus; late settlement; inactive scope; Auth outage; broker forgery and replay across every family;
  production-configuration refusal of simulation.
- **Not.** A production certification, a replacement for any stage's own certification, or Final Core Validation.
- **Approval.** Its own Owner authorization and its own record.

## 6. Final Core Validation

Final Core Validation (Stage 22) stays the absolute last full Core validation ([`CORE-ROADMAP.md`](../CORE-ROADMAP.md), Final Core
Validation): after S-INT, the production track and the pilot or A19 certification as the Owner decides (DG-7). It is never run as
part of an S-stage, a work package or S-INT.

## 7. Gate register

| Gate | Question | Blocks |
|---|---|---|
| G-1 | Stage authorization names each Proposed ADR it implements and the timing of its acceptance; ADR status changes and reciprocal notes approved separately (§1.2) | every stage start |
| G-2 | DOC-3 reconciliation of A10 (DG-4), A11 (MOVE V3) and Release / Payment production (MOVE V3) with the S3–S6 development scope (§1.3) | S3, S4 |
| G-3 | R-6a specification (DOC-1) and AR-04.6 contract register (DOC-2) in the repository (§1.4) | S2-Auth R-6a; route-changing packages of S2 to S6 |
| C-4 | historical Auth → Audit dead letters: inventory and disposition, separately authorized | S1-R enforcement |
| V-4 | effective-state contract to Billing; the ADR-0060 lifecycle runtime is MOVE V3 in the current roadmap, so D6 has no inactive scope to enforce until it exists (DN-1.4, S-9) | S5 D6 enforcement; first lifecycle release |
| V-5 | school actor set for discharge in inactive Organizations. **Policy Owner-approved (V5-1 to V5-9, 2026-10-28; register §7.1); S5e runtime deferred** | S5e |
| Catalog | Premium catalog products, plan durations and prices | S3g and any catalog configuration |
| Simulation adapter | whether the simulation adapter is new beside the existing `test` provider or replaces it; both are refused in production (FC-10) | S4f |
| G-7 | G6 baseline: new Auth, Organization or Audit migrations change the fingerprints G6 matched; no such image reaches production before M3, or the Owner authorizes the G6 baseline refresh first | any Auth, Organization or Audit production deployment of S-stage code |
| AP-R | **OPEN.** Audit provenance retention (S0-C1, P-A2): Audit provenance is not deployed into an environment that has any `audit_retention_policy` row, and enabling a retention rule after provenance is deployed must not bypass this, until provenance retention, erasure and legal-hold behaviour compatible with the Audit purge is approved and implemented. This record states the gate; it does not enforce it, and the enforcement mechanism is itself open | any production deployment of Audit provenance; any `audit_retention_policy` row where Audit provenance is deployed |
| NP-K | **OPEN.** Notification provenance keys (S0-C2): Notification provenance reaches production only after the provenance key ring is provisioned under its own authorization, and after the rotation and retirement procedure (which must keep each key for at least the §13.8 minimum and tell a recoverable key outage from a retired key) and the reconciliation with any Notification history erasure policy are approved. This record states the gate; it does not enforce it | any production deployment of Notification provenance; any retirement of a Notification provenance key |
| OD-15 | **RESOLVED for Payment-first (S0-C4, 2026-10-23); OPEN for every other producer.** Re-emission (ADR-0057 §13.7, register EVT-09): the mechanism (route or command), its authorized caller and producer identity, the eligible event families, preservation of the original event id and body, the recovery evidence and audit record, de-duplication and financial safety, and its relation to Audit catalog-lag recovery (S0-C1). Before S0-C4 nothing here approved any of them; nothing approves re-publishing a published outbox row through the relay, or re-emitting a code-bearing event whose outbox row was purged. S0-C4 decides these for payment-service only (Owner authority bound to the exact event; four `payment.*` version-1 events; pipeline version 1; durable intent and audit before publication; code-bearing events never) | R1–R2 implementation (separately authorized); every other producer's re-emission (R3), including recovery under S1e of an Audit event refused at admission; R4 production |
| G6 / F7 | production hierarchy authority unchanged; G7, F6, F7 locked, each behind its own authorization | S8 RED items; every 🔴 item |
| C-3, C-6, DG-3 | commercial IN_APP; administrator tenure during suspension; pilot channels | S7 |
| C-5 | operator Organization creation | S8 operator step-up work |
| PR #319 | on hold; reconciliation separately authorized | S8 and any Organization-related implementation |
| ADR 0066 | numbering re-checked at every ADR merge | any new ADR |

## 8. Documentation alignment register

Separate from implementation; each item needs its own documentation authorization. This record changes none of these documents.

| Id | Document | Change | Before |
|---|---|---|---|
| DOC-1 | new record (location decided at authorization) | the R-6a specification (G-3) | S2-Auth R-6a |
| DOC-2 | new record (location decided at authorization) | the AR-04.6 contract register: routes, DTOs, errors, idempotency classes (G-3) | route-changing packages of S2 to S6 |
| DOC-3 | [`CORE-ROADMAP.md`](../CORE-ROADMAP.md), [`CORE-V3-ROADMAP.md`](../CORE-V3-ROADMAP.md) | an S-track entry in the current checkpoint; reconciliation of A10, A11 and Release / Payment dispositions with S3–S6 development (G-2), preserving the historical decisions | S3, S4 |
| DOC-4 | [`financial-architecture.md`](./financial-architecture.md) | remove Nawara cash settlement; explicit routing (S0 §6.1). **Written 2026-10-28: its §0 (Core V2, with implementation status)** | S6 review (and S4 for cash) |
| DOC-5 | [Billing SDD](../sdd/billing-service.md) | fixed Core V2 grace versus `SUBSCRIPTION_GRACE_DAYS` (S0 §6.1) | S3e |
| DOC-6 | [Payment SDD](../sdd/payment-service.md), [Payment ADD](../add/payment-service.md) | no trust-based cash confirmation; payer and purpose (S0 §6.1) | S4 review |
| DOC-7 | [`audit-event-catalog.md`](./audit-event-catalog.md), [`core-architecture.md`](./core-architecture.md) | new audit actions; Auth's service-callee route and payment-service as an Auth caller | S2 |
| DOC-8 | ADR-0007, ADR-0049, ADR-0060 | reciprocal notes for ADR-0068, ADR-0069 and DN-1, one ADR at a time (G-1) | ADR acceptance timing per G-1 |

## 9. Mandatory, conditional and deferred

| Class | Items |
|---|---|
| Mandatory (S0 frozen scope) | S1 code; S2 (all four tracks; Release production stays V3); S3; S4; S5; S6; S-INT |
| Mandatory, production-gated | S1-R; every Auth, Organization, Audit, Billing, Payment, File or Release production deployment |
| Conditional | S7 (C-3, C-6); S8 (PR #319, C-5, A5.4-G1; RED items after F7) |
| Deferred ([S0 §5](./core-v2-s0-architecture-freeze.md)) | commercial IN_APP notifications; partial-amount refunds, including electronic partial over-recovery refunds; cash settlement for other sellers; the persistent repeat-violation threshold; real payment-provider integration; human hierarchy reads; tax, invoicing entity, credit notes, legal refund windows, limitation periods, retention durations, execution of legal remedies, commercial e-mail and SMS, push |

## 10. First implementation slice (recommendation, not authorized)

1. The documentation prerequisites DOC-3 and, as needed, DOC-1 and DOC-2, each under its own authorization.
2. **S1a**: in `libs/service-kit`, the publisher sets AMQP `user_id` from its own connection's username, with a disposable real-broker
   test that a forged or mismatched `user_id` is refused. It is the root of the dependency graph, turns S0 §9's assumed broker
   behaviour into evidence, adds no schema and changes no consumer. No provisioning, no deployment; its merge builds an Auth image
   only.

## 11. Mapping to the Core V2 roadmap

| S-stage | Core V2 capability ([`CORE-ROADMAP.md`](../CORE-ROADMAP.md)) | Mandatory-work items touched |
|---|---|---|
| S1 | A3 (A3M.8 production steps for S1-R; F1, F2) | M9 (F2 review) |
| S2 | A4 (Auth), A7 (Audit), A9 (File), Release | M8, M9 (production enablement stays there) |
| S3, S4, S5, S6 | A10 Billing, A11 Payment (development; production per G-2) | none |
| S7 | A8 Notification | DG-3 |
| S8 | A5 Organization | M5 to M7 (production stays there) |
| S-INT | A16, A17 slices (cross-service) | input to M13 / A19 |
