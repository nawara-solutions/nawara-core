# Core V2 S1e-5: integrated consumer provenance certification

| | |
|---|---|
| Status | **CERTIFIED for local evidence (2026-10-30)**: 2 broker tests and 32 integrated tests pass on the real built processes. Not a production certification: S1-R, AP-R, NP-K, C-4, G-7 and OD-BRK-2b-2 / 3 / 4 / 5 stay open and separately authorized |
| Baseline | `main` at `b31f496` (S1a to S1e-4, OD-BRK-1, OD-BRK-2a, OD-BRK-2b-1/R/I/A/W merged) |
| Authorization | The Owner's "CONTINUE WITHOUT LAB 01 — LOCAL DEVELOPMENT AND CERTIFICATION ONLY", Phase 1 (2026-10-30) |
| Environment | Local Docker only: a disposable RabbitMQ 3.13.7 provisioned by the AUTHENTIC `infra/rabbitmq/provision.sh` on an internal network, and a disposable PostgreSQL 16. **Nawara Lab 01 was not used** (hardware maintenance); nothing in production was read or changed |
| History | The first S1e-5 run (2026-10-23, baseline `c1e5ad9`) was **BLOCKED** by one certification failure: broker-driven dead-lettering copied a code-bearing Notification body RAW into every consumer's dead-letter queue through the shared fanout (§4). The remediation decided by OD-BRK-0 (ADR-0057) and implemented by OD-BRK-1 (#344) and OD-BRK-2a (#345) is now merged; this run certifies it |

## 1. How it runs

`npm run test:deploy:real-broker` (on demand; local Docker only; not part of `core-ci-passed`). `scripts/deploy-tests/real-broker-consumers.mjs`:

- provisions an isolated broker with the authentic `provision.sh`, in a test-only variant that re-renders only the generated block with
  Auth's domain events active (the production activation file is unchanged and asserted unchanged);
- provisions Notification only through its real topology gate (OD-BRK-2a/2b), with a TEST-ONLY, root-owned, inactive containment latch in
  the run's own directory (`scripts/deploy-tests/lib/test-latch.mjs`), exactly as the topic-grant certification does;
- reads every identity's effective grants back with `rabbitmqctl`: each equals the S1d-1 generator's output and its role's resource
  permissions (Notification: the ISOLATED consumer role, no configure, write or read on `nawara.events.dlx`), with no `.*` and no bare
  `audit\.`;
- runs `test/e2e-real-broker/certification/s1e5-integrated-provenance.cert-spec.ts` against the **real built processes**: Billing with a
  real Payment publishing as `payment-service` through a severable proxy; Audit first in compatibility, then strict on the same database;
  Notification strict and keyed;
- removes exactly the resources it created, by recorded id, and verifies they are gone.

Attacks use only existing capabilities: a consumer identity's `amq.default` and (Billing, Audit) shared-DLX write, and the break-glass
administrator (no `user_id`).

## 2. Results

| Area | Evidence (all PASS) |
|---|---|
| Broker | Every identity holds exactly its generated topic grant and role permissions; Notification the isolated role; no wildcard; the production activation file unchanged |
| Billing (strict, financial) | An authenticated Payment original settles once, with a verified provenance row; the Organization subscription period is anchored on the TRUSTED original instant. A verified redelivery and ten concurrent identical copies change nothing. A real broker redelivery after the process is killed mid-handler is applied once. A verified replay with a tampered `occurredAt` settles at the stored instant. Forgeries through the default exchange (`replay_no_provenance`) or with no `user_id` (`unverified_original`) are refused before any receipt or state change. Auth publishing a Payment event is refused by the broker (403). An earlier unverified observation of the genuine id does not block the genuine publication (Payment's outbox relay severed, then restored). A contradiction is refused (`verified_conflict`); a terminal-violating event leaves the request paid. A pre-0018 replay without its origin row is refused (`origin_unavailable`). A provenance-store outage holds the delivery (never dead-lettered), which then settles once |
| Audit | Compatibility: a legacy delivery is ingested UNVERIFIED and a verified one VERIFIED, counted apart; a contradiction refused; inadmissible content fails admission first (redacted, no provenance, no digest). Strict: nothing historical promoted; verified original, duplicate and matching replay idempotent; unverified original, injection and contradiction refused; a forged first writer claims nothing; a lookup failure is held then accepted; admission still first |
| Notification (strict, keyed) | Original taken once; `bodyMac` is HMAC-SHA-256 under the active key (never an unkeyed digest), no code in provenance; duplicate and matching replay idempotent; injection, mismatched body and contradiction refused with exact sanitized dead letters; a forged first writer gets no intake identity; lookup failure held; an unavailable key held, a retired key a permanent sanitized refusal; a genuine Auth publication carries no expiry |
| Cross-consumer | One default-exchange injector reaches every work queue and no strict consumer processes anything |
| **OD-BRK-0 items 1, 2** | `notification.events` has **no** broker dead-letter exchange; `notification.events.dead` has **no** binding to `nawara.events.dlx`; no queue expires or overflows; no policy exists |
| **OD-BRK-0 item 10** | The Notification identity cannot publish into the shared dead-letter exchange (broker 403) |
| **OD-BRK-0 items 4, 5** (the former certification failure) | A broker **expiry** of a code-bearing message and a genuine code event **rejected without requeue** by a reader leave **no plaintext code** in any dead-letter queue: the stored bytes of `notification.events.dead`, `billing.payment-events.dead` and `audit-service.audit.dead` are inspected |
| Shared DLX (residual, §5) | A forged message through the shared exchange reaches Billing's and Audit's dead letters only, never Notification's; replaying it is refused before business processing |
| Observability | `nawara_event_trust_total` distinguishes accept, refuse, hold and compatibility by kind; dead letters counted; no code, destination or id in any exposition |

## 3. Changes made to the suite (test adaptations, no product change)

The suite was written before the OD-BRK and Core V2 Billing work merged; these are adaptations to merged contracts, not weakened assertions:

1. The runner provisions Notification through its real topology gate with the test latch, and expects its isolated role.
2. The Billing fixture creates an Organization subscription product with `subscriptionTarget: 'organization'` and its Platform (S3a), and
   the Platform's `billing_platform` row (S3d): since S3b the retired "organization + one recurring line" rule no longer creates a
   subscription, so the anchoring invariant needs a routed product.
3. The three topology tests now assert the OD-BRK-0 certification items (1, 2, 4, 5, 10) instead of measuring the pre-remediation raw copy.

No product defect was found.

## 4. The former certification failure, resolved

`notification.events` used to be declared with `x-dead-letter-exchange: nawara.events.dlx`, a fanout shared by every `<queue>.dead`, so an
expiry or a rejection without requeue copied a code-bearing body RAW into every consumer's dead letters, bypassing
`notificationDeadLetterPolicy`. OD-BRK-0 (owner-approved D1 to D3) removed the route for Notification: its queue now has no broker
dead-letter exchange, its `.dead` queue no fanout binding, and its identity no right on the shared exchange (OD-BRK-1 kit option,
OD-BRK-2a provisioning and topology gate). Items 4 and 5 above are the evidence.

## 5. Open, not certified here (separately authorized)

| Item | State |
|---|---|
| Billing and Audit still use the shared dead-letter exchange | OD-BRK-3 (Billing, before its first deployment) and OD-BRK-4 (Audit migration) OPEN; OD-BRK-5 (fanout retirement) OPEN |
| Production installation of the topology monitor and containment | OD-BRK-2b-2 OPEN |
| **OD-BRK-2b-L, real-systemd half** | **BLOCKED — HARDWARE MAINTENANCE** (Nawara Lab 01 unavailable); its real-broker half passed locally earlier (14 / 14) |
| S1-R production rollout, C-4 dead-letter inventory, AP-R, NP-K, G-7 | OPEN, each its own production authorization |
| Real Auth and real audit-producer processes in this suite | covered by the 16.5 / 21.C real-broker suites |
| Stage 22 Final Core Validation | not run (absolute last) |
