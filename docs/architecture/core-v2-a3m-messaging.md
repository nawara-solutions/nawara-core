# Core V2 A3M: messaging

- **Status:** RECORD of the **A3M.0 discovery** (read-only, owner-reviewed, 2026-10-08, on `main` at
  `e2adc20253bf1afaa41394b05b9b56e88db507b4`, the PR #233 merge that certified A15), of the A3M decision review (read-only,
  owner-reviewed), of **A3M.1: messaging records and policy** (**closed on `main`**: PR #234, merge
  `38f262e065f032fe8c792f3588874a36758e0909`; §6), of the **G7 proof** (G7 **confirmed** locally; §7) and of the **A3M.4 G7 slice**
  (R1 remediation, regression tests, one alert; **closed on `main`**: PR #235, merge `9c8d69caabdec32647c6bb11817b2c2d3decd02e`; §7) and
  of **A3M.2: event contracts and versioning** (**closed on `main`**: PR #236, merge `27d1f1c80a9a6ca3efb9bf7cf0657d335135cad4`; §11)
  and of **A3M.3: producer and consumer conventions, G11** (**closed on `main`**: PR #237, merge
  `06e471aa2ed0dca41a8abe274ac406fb38cbf842`; §12), of the **rest of A3M.4: the idempotency matrix** (**closed on `main`**: PR #239,
  merge `4c07643dd4f27a91b4d20a29c5fd92d3b50c1724`; §13) and of **A3M.5: outbox and de-duplication retention** (**implemented
  locally, pending review and merge**; §14). **A3M is OPEN.** No retention cleanup runs anywhere.
- **Scope of A3M** ([roadmap](../CORE-ROADMAP.md) stage **A3 Messaging**): broker conventions; event envelopes and versioning; retry,
  dead letters, idempotency; producer and consumer conventions; real-broker certification. The substages are named **A3M.0 to A3M.8**
  (OD-A3M-0) so they are never confused with V2-A.3's A3.1 to A3.8 ([V2-A.3 record](core-v2-a-3-ci-and-ruleset.md)), whose **A3.6
  (production access proof) and A3.7 (organization-secret restriction) stay deferred** under owner decisions D-3 and D-4 and are not A3M.
- **Conventions:** [ADR-0057](../adr/0057-messaging-conventions.md), **Proposed** (OD-A3M-1). It reconciles ADR-0018 and ADR-0037 by
  forward notes (OD-A3M-2) and follows the Accepted ADR-0046 rule 17, ADR-0049, ADR-0052, ADR-0053 and ADR-0056.
- **Not A3M:** Auth convergence (A4); Organization authority (A5, F6, F7); audit semantics and audit record retention (A7, ADR-0049 §10,
  A13); notification, billing and payment domain behaviour (A8, A10, A11); new observability capabilities (A12); production work of any
  kind unless separately authorized (§8).

## 1. A3M.0 discovery inventory

Read from `main` at `e2adc20` (code and records only; nothing was run).

| Service | Produces (outbox → `nawara.events`) | Version | Consumes (queue → bindings) | De-duplication | Deployed |
|---|---|---|---|---|---|
| auth-service | domain events, written only with `AUTH_EVENTS=on`: `user.registered`, `member.contact_verification_requested`, `admin.operator_code_issued`, `admin.operator_confirmation_code_issued`, `admin.owner_recovery_requested`, `admin.owner_recovery_completed`, `admin.owner_login_from_new_device`, `membership.requested`, `membership.approved`, `membership.rejected`, `membership.revoked`, `membership.admin_provisioned` (names found in Auth's source; the A3M.2 catalog makes the list authoritative); `audit.*` always | 1 (`AUTH_EVENT_VERSION`) | – | – | **production** (Auth → Audit relay; `AUTH_EVENTS=off` there) |
| payment-service | `payment.created`, `payment.succeeded`, `payment.failed`, `payment.cancelled`, `payment.expired`; `audit.*` | 1 | – | – | no |
| billing-service | `invoice.created`; `audit.*` | 1 | `billing.payment-events` → `payment.succeeded`, `payment.failed`, `payment.cancelled`, `payment.expired` | `payment_event_receipt` (unique `eventId`); a `source` other than `payment-service` is a conflict | no |
| organization-service, file-service, release-service | `audit.*` only | 1 | – | – | Organization in production; File and Release no |
| notification-service | – | – | `notification.events` → the names of its `EVENT_MAP` (Auth events, matched by `source` and name) | unique `(sourceService, sourceEventId)`; refuses an unsupported `version` | no |
| audit-service | – | – | `audit-service.audit` → `audit.#`, with a redacting `deadLetterPolicy` | `insertOnce` on `(sourceService, eventId)` | **production** |

- **Kit components** (`libs/service-kit/src/events/`): `OutboxService` (transactional enqueue, name grammar, 64 KiB payload bound,
  optional producer-supplied id), `OutboxRelay` (claim with `FOR UPDATE SKIP LOCKED`, confirmed publish, exponential backoff up to 15 s,
  batches of 50), `RabbitMqEventBus` (topic exchange, persistent messages, publisher confirms bounded at 5 s, prefetch, retry 3 × 5 s by
  default, annotated dead letters, optional `deadLetterPolicy`), `InMemoryEventBus`, `InboxService` (unused by every service; the kit
  migration creates its table), the `nawara-dlq`, `nawara-check-dlq` and `nawara-check-outbox-lag` CLIs, and the A12 messaging and outbox
  metrics.
- **Deterministic event ids:** Billing, File and Payment derive event ids (`deterministicEventId`), so a retried business operation
  writes its event once (the outbox ignores the second row).
- **Tests:** the kit's real-broker suites (`rabbitmq-dlq-retry`, the Stage 18.8 and 18.9 dead-letter policy and refused-copy suites, and
  the other broker integration files made deterministic and self-cleaning by A15.3), each service's consumer suites, and the
  cross-service packages under `test/`.

## 2. Messaging architecture as implemented

```text
 producer: business transaction ─┬─ state change
                                 └─ OutboxService.enqueue → outbox row
           OutboxRelay ── claim (SKIP LOCKED) → publish with confirm → stamp publishedAt  (at least once)
                                     │
                                     ▼
 RabbitMQ  nawara.events (topic, durable); routing key = event name; body = flat JSON payload;
           properties messageId/type/timestamp; headers eventId, occurredAt, correlationId, source, version
                                     │ bindings of each consumer queue Q
                                     ▼
 consumer: Q (x-dead-letter-exchange = nawara.events.dlx) ── handler → durable de-duplication + effect, one transaction → ack
           transient failure → confirmed copy in Q.retry (expires back into Q), up to maxRetries
           permanent / malformed / exhausted → confirmed annotated copy in Q.dead → ack
           copy not confirmed → held for the retry delay, then requeued to Q    (every consumer since A3M.4; before it, a consumer
                                                                                without a policy nacked without requeue: finding G7)
           nawara.events.dlx (fanout) ──▶ every Q.dead in the vhost            (no longer reached by the kit; residual, §7)
 operator: nawara-dlq inspect / replay one message → the work queue of that .dead queue; nawara-check-dlq; nawara-check-outbox-lag
```

## 3. Findings

| Id | Finding | Kind | Disposition |
|---|---|---|---|
| G1 | ADR-0018 names a client library no service uses and defers retry, dead letters and versioning, which the kit implements | records drift | reconciled by ADR-0057 and a forward note (A3M.1) |
| G2 | ADR-0037 lists event families nobody emits and says Auth publishes fire-and-forget | records drift | reconciled by ADR-0057 and a forward note (A3M.1) |
| G3 | The kit inbox is unused; every consumer de-duplicates with its own durable record | convention gap | OD-A3M-3; written in ADR-0057 §7; no table or migration change |
| G4 | No event catalog outside audit events; nothing checks that a consumer binding matches a real producer | missing convention | OD-A3M-7; ADR-0057 §11; implemented in A3M.2 |
| G5 | Versioning rule only in a code comment; only Notification refuses an unsupported version | missing convention | ADR-0057 §5; consumers adopt it in A3M.2 / A3M.3 |
| G6′ | Queue names follow no pattern; production names are fixed by ADR-0053 | missing convention | ADR-0057 §9: new queues only |
| G7 | The shared fanout dead-letter exchange copied an unannotated original into every consumer's `.dead` queue when a consumer without a dead-letter policy could not confirm its dead-letter copy | **defect, confirmed locally** (raw cross-consumer delivery; message lost to its owner) | OD-A3M-5; remedied in code by A3M.4 R1 (§7); topology residuals stay |
| G8 | S21-5: Payment, a producer, makes the broker a readiness dependency | aligned | OD-A3M-4; A3M.3 removed the check (§12) |
| G9 | F12: published outbox rows and inbox rows are never deleted (except Auth's code-bearing rows) | retention | OD-A3M-6; A3M.5, off by default |
| G10 | Ordering is not guaranteed and no convention says how consumers validate state | missing convention | ADR-0057 §7 |
| G11 | Billing's `payment_event_receipt` claimed the event id for **any** first outcome (ignored, deferred, conflict); Payment's and the reconciler's event ids are deterministic and any publisher can set any header, so a forged message carrying the genuine id stopped the genuine outcome (and the reconciler) from ever applying | **security finding, HIGH, confirmed locally** (Billing and Payment not deployed) | **remedied by A3M.3** (C + A, migration 0016; §12) |

(G6′ is written with a prime so it is not confused with the production gate G6.)

## 4. Owner decisions

| Id | Decision | Conditions |
|---|---|---|
| OD-A3M-0 | **Approved:** the messaging substages are A3M.0 to A3M.8 | V2-A.3's A3.6 and A3.7 stay deferred (D-3, D-4) and are not A3M |
| OD-A3M-1 | **Approved:** one canonical messaging ADR, ADR-0057, created **Proposed** | creating it is approved, accepting it is a separate explicit decision; it follows ADR-0046, 0049, 0052, 0053, 0056 |
| OD-A3M-2 | **Approved:** ADR-0018 and ADR-0037 are reconciled with ADR-0057 by forward notes | their text and status are unchanged; neither is marked Accepted; their final disposition stays an explicit owner review |
| OD-A3M-3 | **Approved** as the policy ADR-0057 proposes: domain-specific durable de-duplication is permitted; `InboxService` stays optional (in force as a convention only on ADR-0057's acceptance; ADR-0056 §7 stays binding until then, §6) | the identity includes the event id and a verified source; de-duplication and the business effect commit atomically; Audit's ADR-0049 requirements stay binding; no inbox table is removed and no migration is created in this phase |
| OD-A3M-4 | **Approved:** an outbox-backed producer's readiness does not depend solely on temporary broker availability while durable local acceptance works | consumers keep reporting the broker through their existing readiness; messaging health is observed through the existing A12 metrics and operator tools; no new HTTP endpoint; Payment's alignment is later A3M work |
| OD-A3M-5 | **Approved:** G7 stays an unverified potential defect until a deterministic multi-consumer broker test establishes it | if confirmed, prefer R1 (code only: remove the `nack(requeue=false)` fallback, use the bounded hold-and-requeue); keep message ownership, no cross-consumer dead-letter delivery; verify the reliability and liveness trade-offs before accepting the remedy; production topology unchanged; R2 / R3 need separate explicit authorization |
| OD-A3M-6 | **Approved:** retention is designed off by default | Auth's `CodeEventPurge` stays an active security control; producer outbox retention is coordinated with consumer de-duplication retention and the longest deterministic-event-id re-emission period; no arbitrary durations; Audit record retention is not F12; activation in production is separately authorized |
| OD-A3M-7 | **Approved:** per-service event catalogs and a repository guard | the guard checks consistency without cross-application source imports; no domain event contract in `libs/service-kit`; no shared event-contract library without its own architecture decision; catalogs and guard are A3M.2, not A3M.1 |

**Unresolved A3M decisions before A3M.2:** none. Open owner decisions that do not block A3M.2: ADR-0057's acceptance (which is also
what would put its broader de-duplication reading of ADR-0056 §7 in force, §6) and the dispositions of ADR-0018 and ADR-0037.

## 5. Phases

| Phase | Objective | Done when | Depends on | Risk | Authorization |
|---|---|---|---|---|---|
| A3M.0 | discovery | inventory, findings G1–G10 and the decision review owner-reviewed | – | – | read-only ✅ |
| A3M.1 | records and policy | ADR-0057 (Proposed) states the current behaviour and the approved conventions; forward notes on ADR-0018 and ADR-0037; this record; the roadmap and the new-service checklist point at them; no code, test or guard change | A3M.0, OD-A3M-0 to -7 | low | local, documentation |
| **G7 proof** | establish G7 | the deterministic multi-consumer broker test of §7 runs in isolation and its result (confirmed or refuted) is recorded | A3M.1 | low (test only) | local / CI; separately authorized |
| A3M.2 | event contracts and versioning | a catalog in every producing and consuming service; a `check:repo` guard (every outbox name cataloged, every consumer binding matched by a cataloged producer and version) with negative controls; consumers check `version`; no payload or name changed | A3M.1 | low to medium (Billing's version check must accept today's version 1) | local |
| A3M.3 | producer and consumer conventions | the ADR-0057 consumer rules applied (verified source, atomic de-duplication, `PermanentEventFailure` use, prefetch rule); Payment's readiness aligned with OD-A3M-4; existing queue names unchanged | A3M.1, A3M.2 | low | local (Payment is not deployed) |
| A3M.4 | retry, dead letters, idempotency | G7 remedied if the proof confirmed it (R1, its reliability and liveness trade-offs verified with broker tests) or closed with evidence if refuted; the idempotency matrix recorded | G7 proof, OD-A3M-5 | medium (kit change; builds the Auth, Organization and Audit images on merge, deploys nothing) | local; topology change separate |
| A3M.5 | outbox and de-duplication retention | a kit cleanup that is off by default, excludes Auth's code purge, and enforces the OD-A3M-6 ordering rule; proven locally | OD-A3M-6 | medium (data deletion) | local; activation separate |
| A3M.6 | deterministic broker tests | the A3M suites in Core CI: topology, the G7 regression, version refusal, catalog consumers; self-cleaning (A15.3 rules), no retries | A3M.2 to A3M.5 | low | local / CI |
| A3M.7 | local certification | the criteria of each phase met; boundaries of §9 unchanged; production untouched; certification pull request merged | A3M.1 to A3M.6 | low | local |
| A3M.8 | production messaging | each item of §8, one authorization at a time | A3M.7 and owner authorization | high | **production** |

```text
A3M.0  discovery, decision review          ✅ complete (owner-reviewed)
A3M.1  records and policy (ADR-0057)       ✅ closed on main (PR #234, merge 38f262e)
G7     isolated broker proof               ✅ G7 confirmed locally (§7)
A3M.2  event contracts and versioning      ✅ closed on main (PR #236, merge 27d1f1c)
A3M.3  producer and consumer conventions   ✅ closed on main (PR #237, merge 06e471a; G11 fixed, S21-5 aligned)
A3M.4  retry, dead letters, idempotency    ✅ closed on main (G7 slice PR #235; idempotency matrix PR #239, merge 4c07643)
A3M.5  outbox and de-duplication retention policy and manual dry-run-first CLI: implemented locally; pending review and merge (§14)
A3M.6  deterministic broker tests          not started
A3M.7  local certification                 not started
A3M.8  production messaging                not started (separately authorized)
```

## 6. A3M.1: messaging records and policy (2026-10-08; closed on `main`, PR #234, merge `38f262e`)

- **Changes:** [ADR-0057](../adr/0057-messaging-conventions.md) (new, Proposed); forward notes in
  [ADR-0018](../adr/0018-rabbitmq-as-async-message-broker.md) and [ADR-0037](../adr/0037-reliable-events-outbox-inbox.md) (text and status
  otherwise unchanged); the [ADR index](../adr/README.md); this record; the [roadmap](../CORE-ROADMAP.md); one reference in the
  [new-service checklist](../NEW-SERVICE-CHECKLIST.md) §8 (A15 is not reopened).
- **What ADR-0057 does:** labels each rule **[CURRENT]** (what `main` does), **[NEW]** (approved for later A3M work) or **[OPEN]** (G7),
  so it changes no behaviour. **De-duplication, kept apart:** (1) existing behaviour: Audit, Notification and Billing each de-duplicate
  durably with their own record, and no service uses `InboxService` (§1); (2) binding today: the Accepted ADR-0056 §7 ("consumers (by
  event id in an inbox)") and ADR-0049 §5, unchanged and not edited; (3) proposed: ADR-0057 §7's broader policy (a domain record whose
  identity includes the event id and a verified source, committed atomically with the effect) and its reading of ADR-0056's "inbox" as
  any such record; (4) **owner decision needed:** that reading takes effect only when the owner explicitly accepts ADR-0057 (or amends
  ADR-0056). Proposed ADR-0057 does not override Accepted ADR-0056.
- **Production:** none. Documentation only: Core CI, no image build, nothing deploys. No G6 dependency.

## 7. G7: proof and A3M.4 remediation (2026-10-08)

The design below was fixed in the decision review and its preflight; the results follow it.

- **Harness:** a new file, `libs/service-kit/test/rabbitmq-dead-letter-isolation.int-spec.ts` (the certified Stage 18.9 suite is left
  untouched), gated by `TEST_RABBITMQ_URL` and `TEST_RABBITMQ_MGMT_URL`; a unique exchange `nawara.events.g7<hex>`, so its `.dlx` is
  private to the test.
- **Consumers:** A (`q.g7a.<hex>`, binds `payment.#`, the handler always throws `PermanentEventFailure`, **no** dead-letter policy,
  `maxRetries: 0`); bystander B (`q.g7b.<hex>`, binds `nomatch.#`, never handles anything, Audit-like redacting `deadLetterPolicy`).
- **Fault:** the existing technique: a management policy `max-length: 0`, `overflow: reject-publish` on `A.dead` only, in force once a
  probe publish to it is refused.
- **Steps:** subscribe A and B; assert `B.dead` empty; apply the fault; publish one event with a marker field; wait (bounded) for the
  `event_dead_lettered … annotated=false` notice; inspect `B.dead` with `basic.get` in a bounded loop.
- **Verdict:** **confirmed** if `B.dead` holds the event (same `messageId`, the **raw** marker in the body, no `x-nawara-consumer`,
  `x-death[0].queue = q.g7a.<hex>`), also recording that A's own `.dead` refused it; **refuted** if `B.dead` stays empty past the bound
  after the notice.
- **Controls:** A with a dead-letter policy (expected: deferred, `B.dead` empty); after any remedy, the confirming scenario must give
  "deferred, `B.dead` empty, message still in A".
- **Determinism:** bounded waits on notices and broker state only; every queue, exchange and policy deleted afterwards (A15.3).
- **Infrastructure:** one disposable local broker per run (`rabbitmq:3.13-management-alpine`, already present locally, never pulled;
  its own container and network, a tmpfs data directory so no volume, a 512 MB limit, loopback-only ports, a throwaway credential),
  removed afterwards; the existing containers, networks and volumes were compared before and after each run and were unchanged.
- **Proof (on `main` at `38f262e`, one run): G7 CONFIRMED.** Test 1 failed with `G7_EVIDENCE`: one `annotated=false` notice; the
  bystander's dead-letter queue held the event (same `messageId`, body with the **raw** secret and marker, `x-nawara-body-redacted`
  absent although the bystander's policy redacts, no `x-nawara-consumer`, `x-death[0].queue` = A's queue, reason `rejected`); the
  bystander's handler was never called; A's work queue and A's own dead-letter queue were **both empty**: the only copy was in another
  consumer's queue. Test 2 (normal path) and test 3 (A with a policy under the same fault: deferred, isolated, kept) passed.
- **Remediation (A3M.4, R1, code only).** `RabbitMqEventBus.onFailure` no longer calls `nack(requeue = false)` when the dead-letter copy
  is not confirmed: every consumer now holds the delivery for its retry delay (cut short by a stopping consumer) and requeues it to its
  own queue, the Stage 18.9 path, reported as `dead_letter_deferred`. Publisher confirms, the topology, the queue arguments and the
  grants are unchanged. `dead_letter_unannotated` stays a declared outcome (no longer produced) so the metric labels, dashboards and
  `MessagesDeadLettered` stay unchanged. The one kit unit expectation that encoded the old behaviour
  (`metrics-messaging-semantics.spec.ts`: the no-policy case now `dead_letter_deferred`, `nack` with requeue) was updated.
- **Regression evidence (one run each, disposable broker):** the G7 file 3 of 3 passed; the existing dead-letter suite
  (`rabbitmq-dlq-retry.int-spec.ts`, which covers the changed path) 15 of 15; kit messaging unit tests 29 of 29; typecheck and lint.
  Observation: the existing Stage 18.9 suite leaves its exchange `nawara.events.m18<hex>` and its `.dlx` behind after a run (it deletes
  its queues and policy only); not changed here.
- **Reliability and liveness.** No message leaves its consumer on this path and none is lost. While a dead-letter queue keeps refusing
  copies, a failing message cycles instead of being parked: at most `prefetch` deferrals per retry delay (no busy loop), each holding one
  prefetch slot; if every in-flight delivery is such a message the consumer stalls and its queue grows, until the dead-letter queue
  accepts copies again. `retryCount` does not grow on a requeue. A copy that was stored but not confirmed in time can later appear twice
  in `.dead` (replay and consumer de-duplication handle it). Shutdown stays bounded.
- **Monitoring (narrow forward change to the certified A12 alert catalog).** R1 turns this case from `dead_letter_unannotated` (which
  `MessagesDeadLettered` alerts on) into `dead_letter_deferred` (not parked, so not that alert's concern), which would have left a broken
  dead-letter path unalerted, as it already was for Audit. One warning alert is added to the `core-messaging` group,
  **`DeadLetterCopyFailing`**: `sum by (job, instance, queue) (increase(nawara_events_consumed_total{<Core jobs>,
  outcome="dead_letter_deferred"}[2m])) > 0` for 5 minutes (the existing 2-minute and 5-minute conventions of ConsumerDetached and
  OutboxBacklogAging): one isolated deferral stays under `for`; deferrals sustained for 5 minutes fire. Existing metric family and labels
  only; `MessagesDeadLettered`, the outcome labels and the dashboards are unchanged. Its promtool test (healthy, one isolated deferral,
  other outcomes, sustained, resolution) passes with the other rule tests; `check:repo`'s alert catalog (17 alerts) and outcome matcher
  admit exactly this alert and this outcome, with two new negative cases in `test:repo` (126 passed). A12 is not reopened: no other
  rule, metric, dashboard or certification evidence changed.
- **Production:** none. Activating R1 in production is the separately authorized deployment of a later image of each consuming service
  (Audit's behaviour does not change: it already had a policy); the fanout and the DLX write grant stay as residuals (§8).

## 8. Production work, separately authorized

None of this is A3M.1 to A3M.7; each item needs its own owner authorization under ADR-0053 and the `production` environment:

- enabling `AUTH_EVENTS` in production (widens Auth's broker grant; gates Auth-triggered notifications, A8);
- broker identities and grants for Notification, Billing and Payment when they are deployed;
- any change to the production topology: the dead-letter exchange (R2, R3, the G7 residuals of §7), exchange or queue names and arguments;
- deploying images that contain A3M.4's R1 (merging builds the Auth, Organization and Audit images; nothing deploys);
- enabling outbox or de-duplication retention in a deployed service;
- the [V2-A.3](core-v2-a-3-ci-and-ruleset.md) A3.6 and A3.7 items stay deferred (D-3, D-4) and are not part of A3M.

G6 stays deferred; Final Core Validation stays the absolute last validation.

## 9. Boundaries

| Stage | Boundary |
|---|---|
| A4 Authentication | Auth's event emission, `AUTH_EVENTS` semantics and code purge are unchanged by A3M; Auth's convergence is A4 |
| A5 Organization | no organization authority or ownership event is designed in A3M |
| A7 Audit | the audit catalog, envelope validation and the redacting dead-letter policy stay ADR-0049's; A3M only checks they are respected |
| A8 Notification | intake mappings and delivery semantics are A8's; A3M supplies the conventions it follows |
| A10 Billing, A11 Payment | payment and billing event semantics are theirs; A3M adds the catalog, version check and readiness alignment only |
| A12 Observability | A3M reuses the existing messaging and outbox metrics and CLIs; it adds no endpoint (OD-A3M-4) and one alert, `DeadLetterCopyFailing` (A3M.4, §7) |
| A13 Backup | audit record retention and backups are A13 and ADR-0049 §10; F12 is A3M.5 and stays off by default |

## 9A. Later status: PR #237 blocked by the R11 test-teardown race (2026-10-08)

Appended. Core CI on PR #237 (A3M.3, head `a0e88a6`, run 37766312026) failed the `billing-service` job although all 18 e2e files and
345 tests passed (the G11 suite 8 of 8): Vitest recorded one uncaught PostgreSQL `57P01` ("terminating connection due to administrator
command"), attributed to `test/invoices.e2e-spec.ts`, a file A3M.3 did not change. Cause, pre-existing (the R11 "Billing 57P01
teardown race", [A15 record](core-v2-a15-developer-experience.md) §9): `pg.Pool#end()` resolves before its clients' sockets close, and
the kit's scratch-database `drop()` terminated every remaining session at once, so a closing test-pool client received the FATAL with
no error listener. Not an A3M.3 defect (migration 0016, the G11 fix and Payment readiness are not involved). The fix is a separate,
narrow change to the kit's test helper (`libs/service-kit/src/testing/test-db.ts`: wait, bounded, for closing sessions before
terminating what is left, and report leaks); PR #237 is unchanged and is re-run once that fix is on `main`.

## 10. Certification policy

- A3M is certified by A3M.7, against the criteria of §5, on `main`, with green Core CI for every A3M pull request.
- Evidence is reused, not repeated: merged pull-request checks, recorded local runs and the A15.3 deterministic broker suites. A broker
  campaign runs only where a phase changes broker behaviour (the G7 proof, A3M.4, A3M.6), bounded and self-cleaning.
- Certification is repository and local; it certifies nothing in production. Merge is not ADR acceptance (ADR README): ADR-0057's
  acceptance is a separate owner decision.

## 11. A3M.2: event contracts and versioning (2026-10-08; closed on `main`, PR #236, merge `27d1f1c`)

- **Owner decisions:** OD-A3M2-1 = A (a TypeScript catalog per service, rendered to a committed JSON artifact, compared by a JSON-only
  guard); OD-A3M2-2 = names, versions, payload field types and nullability; OD-A3M2-3 = A (Auth's emission typed at compile time, no
  runtime change); OD-A3M2-4 = Billing refuses an unsupported version before any receipt or decision; OD-A3M2-5 = events with no Core
  consumer are catalogued as published contracts; OD-A3M2-6 = one registration line in the new-service checklist.
- **Catalogs** (`apps/<service>/src/events/event-catalog.ts`, local types, no shared library, nothing in the kit, no cross-application
  import) and their artifacts (`apps/<service>/contracts/events.json`, rendered by `renderEventContract()`; each service's
  `event-catalog.spec.ts` compares them with `toMatchFileSnapshot`, regenerated only by `vitest -u` after a deliberate change):

  | Service | Produces | Consumes |
  |---|---|---|
  | auth-service | 12 (three code-bearing, exactly `CODE_BEARING_EVENTS`) | – |
  | payment-service | 5 (`payment.created`, `.succeeded`, `.failed`, `.cancelled`, `.expired`) | – |
  | billing-service | 1 (`invoice.created`) | 4 payment outcomes (what `parseFacts` requires) |
  | notification-service | – | 9, **rendered from the intake's `EVENT_MAP`** (no second definition) |

  18 produced events and 13 consumed entries, matching the A3M.2 inventory; every one is version 1, and no name, payload, event id,
  source or version changed. Five published events have no Core consumer (`user.registered`, `membership.requested`,
  `membership.admin_provisioned`, `payment.created`, `invoice.created`).
- **Producer typing.** Auth: `DomainEvents.emit<N>(q, name: N, payload: AuthEventPayload<N>)` is derived from the catalog, so an emit
  site with an undeclared name, an undeclared or missing field, a channel outside `email | phone` or a null where none is allowed does not
  compile (a runtime-selected name, `approved | rejected`, is checked as its union). The typing found one site whose `channel` was widened
  to `string` (`operator-code.service.ts` `contactOf`): fixed with a return type, no runtime change. Compile-time negative controls
  (`@ts-expect-error`) in Auth's `event-catalog.spec.ts` fail the typecheck if the typing loosens. Payment: `PaymentEventName` is the
  catalog's keys; a builder test checks every event, with the extras each call site passes, against its catalog entry. Billing: a
  builder test does the same for `invoice.created`; the consumer's bound names and versions come from its catalog.
- **Billing version check.** `PaymentEventConsumer` refuses a version other than the catalog's (1) **before** the payload is parsed,
  before any receipt and before any decision: a permanent failure `unsupported_version`, dead-lettered, logged without echoing a
  malformed version. Version 1 (Payment's only version; a message without the header reads as 1) is unchanged. Unit tests: versions 2, 0
  and NaN refused with `applyPaymentEvent` never called (no receipt, no effect), a malformed payload at version 2 refused for its
  version, the replay naming, and version 1 still applied.
- **Guard** (`checkEventContracts`, `npm run check:repo`; JSON only): name grammar, never `audit.*`, positive integer versions, a closed
  field-type set, one producer per name, code-bearing events only from auth-service, every consumed `(source, name, version)` published by
  that source at that version, every required field declared there with a compatible type and nullability, and a contract file for
  every application whose source writes to the outbox or subscribes to the bus (audit-service exempt: it consumes only `audit.*`).
  **Limit:** registration is a presence scan of source text, not a proof that every emit site is catalogued; emit sites are bound by
  the producers' compile-time typing and builder tests.
- **Evidence (local).** `test:repo` 127 passed (fixtures for each rule and the real contracts: 18 and 13). Eight negative controls on
  in-memory copies of the real contracts (no repository file modified; contract hashes and the working tree verified unchanged), each
  red for exactly its violation: a missing field, an incompatible version, an unknown event, a duplicate producer, an audit event, a
  missing contract, a nullability mismatch, a code-bearing event outside Auth. Unit suites with `CI=true` (artifacts compared, never
  rewritten): auth 144, payment 112, billing 356, notification 330. `tsc --noEmit` and `oxlint` on the four services; `check:repo`.
- **G11** is unchanged by A3M.2 (Billing's source verification and receipt key are untouched); the version check runs before the
  receipt, so it adds no new way to occupy one. G11 is A3M.3, HIGH.
- **Production:** none. Merging builds the Auth image (its workflow matches `apps/auth-service/**`); Billing, Payment and Notification
  have no image workflow; nothing deploys. No topology, grant, payload or `AUTH_EVENTS` change.

## 12. A3M.3: producer and consumer conventions, G11 (2026-10-08; closed on `main`, PR #237, merge `06e471a`)

- **Owner decisions:** OD-A3M3-1 = C + A (only an applied outcome claims an event id; a wrong source is refused before any receipt);
  OD-A3M3-2 = Billing migration 0016; OD-A3M3-3 = `wrong_source` is a permanent dead letter, no longer a recorded conflict;
  OD-A3M3-4 = Payment's broker readiness removed (S21-5); OD-A3M3-5 = the G11 proof before the fix; OD-A3M3-6 = broker-enforced
  publisher identity stays a separate architecture decision (P-A1 / A14).
- **G11 proof (on `main` at `27d1f1c`, one run, disposable PostgreSQL).** `apps/billing-service/test/payment-event-source.e2e-spec.ts`
  through the real consumer (in-memory bus) and the real reconciler: G11-1 (wrong-source message first), G11-2 (genuine source header,
  forged amount), G11-3 (the event before Billing recorded the paymentId, delivered again afterwards), G11-4 (a forged message carrying the
  reconciler's own deterministic id) and a forged-versus-genuine race: **all failed**, the request left `requested`, with the forged
  message's receipt holding the id (`conflict wrong_source`, `conflict amount_mismatch`, `deferred payment_id_not_recorded`,
  `conflict amount_mismatch`). The two genuine-only controls passed. The root cause was exactly the predicted one.
- **Fix (C + A).**
  - Migration `0016_payment_event_receipt_applied_claim.sql` (indexes only): the unique index on `"eventId"` becomes unique only
    `WHERE outcome = 'applied'`, plus a plain index on `"eventId"`. Existing rows are unchanged (0007 allowed one per id).
  - `applyPaymentEvent`: the replay lookup reads only `applied` receipts; the insert's conflict target is the applied-only index. The
    receipt and the state change stay in one transaction under the invoice lock; non-applied outcomes leave one append-only row per
    delivery (growth bounded by redeliveries; `payment_event_receipt_open_idx` still finds them; retention is A3M.5).
  - `PaymentEventConsumer`: a `source` other than the catalog's (`payment-service`) is a permanent failure `wrong_source` before any
    parsing, receipt or decision, logged without echoing the header. `decidePaymentEvent` keeps its own source check (the reconciler
    path).
- **After the fix:** the G11 file passes (8 of 8): the four G11 cases (each now with its exact receipt rows: the forged one recorded but
  claiming nothing, then `applied`), the race (exactly one `paid` transition), both controls, and a schema test (two `applied` rows for
  one id refused with 23505, non-applied rows repeatable, the old index gone). Existing suites on the changed paths, one run each:
  `invoices`, `payment-integration`, `payment-subscription-integration`, `subscription-hardening`, `runtime-role`, `migrations` (one
  expectation updated on purpose: the 0015 run now also applies 0016). Billing unit 357 (a new `wrong_source` test).
- **S21-5.** `apps/payment-service/src/main.ts` no longer registers a broker readiness check, and `src/health/rabbitmq-readiness.ts` is
  removed. `/ready` still checks the database and migrations. A new e2e test runs Payment with the real RabbitMQ bus pointed at a closed
  port: `/ready` is 200, a payment is accepted (201) and its `payment.created` waits unpublished in the outbox, `/ready` stays 200 after
  the failed publish; it also checks that `main.ts` registers no broker check. Payment health e2e 4 of 4, unit 112. `amqplib` stays in
  Payment's `package.json` for now (removing it changes `package-lock.json`, which triggers the Auth, Organization and Audit image builds):
  an unused-dependency follow-up.
- **Conventions recorded** (ADR-0057, still Proposed): only an applied effect claims an event id; the `source` header is asserted, not
  authenticated; the permanent-versus-transient table; producer readiness (§6); prefetch and queue naming were already stated (§7, §9).
- **Trust boundary.** A forged message can no longer block a genuine outcome, and still cannot apply one (Billing's own recorded facts
  decide). What remains: any publisher able to reach Billing's queue can add non-applied rows (bounded by what it sends) and dead letters;
  broker-enforced publisher identity is the separate P-A1 / A14 decision. Audit's asserted-source residual stays as ADR-0053 accepts it
  (A7 / P-A1).
- **Infrastructure:** one disposable PostgreSQL (`postgres:16-alpine`, already local, never pulled; its own container and network, tmpfs
  data, loopback port, throwaway credential), removed afterwards; containers, networks and volumes compared before and after: unchanged.
- **Production:** none. Billing and Payment have no image workflow and no production database; nothing deploys.

## 13. A3M.4: idempotency matrix and evidence (2026-10-08; closed on `main`, PR #239, merge `4c07643`)

- **Owner decisions:** OD-A3M4-1 = the rest of A3M.4 is closed by this matrix and existing evidence, with no runtime change;
  OD-A3M4-2 = A (one focused Notification test for F3); OD-A3M4-3 = the stale kit comments wait for the next kit change;
  OD-A3M4-4 = F1 is recorded under P-A1 / A14 and F2 under A7 / P-A1, with no A3M code; OD-A3M4-5 = the outbox retry behaviour is
  documented, no poison-row parking.
- **Two levels, kept apart.** *Transport* is **at least once**: an event can be delivered more than once and in any order. *Business
  effect* is **idempotent per consumer**: each consumer applies an event's effect at most once from its own durable record. Nothing
  here is exactly-once delivery, and **an external notification send is never claimed to be exactly once** (below).

### 13.1 Transport (the kit, shared by every service)

| Guarantee | Behaviour | Evidence |
|---|---|---|
| Outbox | the event is written in the business transaction (`OutboxService.enqueue`); it exists if and only if the change commits; a supplied id makes a retried operation write one row | `libs/service-kit/test/outbox.int-spec.ts` (same-id idempotency) |
| Relay | claims rows with `FOR UPDATE SKIP LOCKED`, publishes persistent messages with publisher confirms (bounded at 5 s), stamps a row only after its confirm; a failed or unconfirmed publish stays pending and is retried with exponential backoff up to 15 s; a row that can never be published is retried indefinitely (F4) | `async-resilience.int-spec.ts` (F4 confirm timeout, recovery), `metrics-outbox.int-spec.ts` |
| Crash between publish and stamp | the same event id is published again; consumers de-duplicate | `test/e2e-real-broker/stage21c2-auth-outbox-durability` |
| Consumer retry | a rejected delivery is retried through `Q.retry` (default 3 × 5 s), then copied, annotated, to `Q.dead`; a permanent failure skips the retries | `rabbitmq-dlq-retry.int-spec.ts`, `stage4-real-broker-dlq-replay` |
| Dead-letter copy not confirmed | held for the retry delay and requeued to the consumer's own queue, for every consumer (G7, §7) | `rabbitmq-dead-letter-isolation.int-spec.ts` |
| Shutdown and consumer loss | bounded drain; an unacknowledged delivery is redelivered; a lost consumer re-attaches | `async-resilience.int-spec.ts` (F6), `stage4-real-broker-consumer-recovery` |
| Replay | an operator replays one dead-lettered message, with its original id, into its own work queue | `rabbitmq-dlq-retry.int-spec.ts`, `stage4-real-broker-dlq-replay` |

### 13.2 Producers

| Producer | Event identity | Outbox | A retried operation | Evidence |
|---|---|---|---|---|
| auth-service, domain events | the outbox row id (random); version 1 | on the caller's transaction, only while `AUTH_EVENTS=on` | a new operation is a new event; a relay re-publish keeps the id | `apps/auth-service/test/domain-events-outbox.e2e-spec.ts`, `stage21c2`, `stage21c3` |
| auth-service, organization-service, audit events | random unless the caller supplies an id | same transaction, through `AuditEventWriter` | as above | `test/e2e-audit-producers/auth`, `organization` |
| payment-service | deterministic: `(paymentId, event name)` | same transaction as the state change | writes one row (outbox id conflict) | `payment-events.spec.ts`, `event-catalog.spec.ts` |
| billing-service, `invoice.created` and audit events | deterministic: `(invoiceId, name)`, `(resource, action, …)` | same transaction (`invoice.repository.ts`) | one row | `deterministic-id.spec.ts`, `event-catalog.spec.ts`, `test/e2e-audit-producers/billing` |
| file-service, release-service, audit events | deterministic | same transaction | one row | `test/e2e-audit-producers/file`, `release` |

### 13.3 Consumers

| Consumer | De-duplication key | Atomicity | A duplicate | A delivery that does not apply | Permanent failures | Concurrency and ordering | Crash recovery | Evidence |
|---|---|---|---|---|---|---|---|---|
| billing-service ← Payment (`billing.payment-events`) | `eventId`, claimed **only by an `applied` receipt** (migration 0016) | receipt and state change in one transaction, under the invoice and request locks | applied once; a later copy is a replay of the applied receipt | ignored, deferred, conflict: acknowledged, recorded, claim nothing; the next delivery is decided on its own merits | malformed, unsupported version, wrong source, an identifier the database refuses: dead-lettered | state validated under lock; a success racing a failure gives one applied and one conflict | a rollback writes no receipt, so the redelivery applies; the reconciler settles a missed outcome from Payment's authenticated API | `payment-event-source.e2e-spec.ts` (G11, 8), `invoices.e2e-spec.ts` (six concurrent copies, races), `payment-integration.e2e-spec.ts`, `db/tests` (251 invariants), `stage4-*`, `stage12-7` |
| notification-service ← Auth (`notification.events`) | `(sourceService, sourceEventId)`, unique | intent and delivery row in one transaction | recorded once; **identity alone decides**: the same id with different content is also a duplicate, the first intent is kept unchanged, with no conflict signal (F3) | – | unmapped event, unsupported version, malformed payload, no destination, unknown template, invalid template data: dead-lettered | every event is independent; delivery claims use `FOR UPDATE SKIP LOCKED` and a lease token | a committed but unacknowledged event is recognized as a duplicate on redelivery | `intake.e2e-spec.ts` (replay × 5, 12 concurrent copies, the F3 test), `event-intake-broker.e2e-spec.ts` (crash window, restart replay), `stage16-5`, `stage21c2`, `stage21c3` |
| audit-service ← every producer (`audit-service.audit`) | `(sourceService, eventId)`, `insertOnce` | one autocommit insert | an exact duplicate is an idempotent success; different evidence is a permanent `event_id_conflict`, the stored record is never overwritten (F2) | – | a contract refusal, a conflict, a record the schema refuses: dead-lettered through the redacting policy | records are independent | a crash before the insert is redelivered; a crash after the commit is recognized as a duplicate | `ingestion.service.spec.ts`, `ingestion-broker.e2e-spec.ts` (duplicate, conflict replay, both crash windows), `dead-letter-privacy.e2e-spec.ts` |

**The external send is at least once.** Notification's delivery worker commits a STARTED attempt before every provider call, makes
the call outside any transaction, and writes the outcome conditionally on its lease token. A worker lost after the provider accepted
the message leaves an AMBIGUOUS attempt, decided from that evidence; the provider may have delivered a message whose answer was lost
(`delivery-worker.ts`; `certification.e2e-spec.ts` "nothing lost, nothing duplicated" covers the internal processing, not the provider).
The kit's `InboxService` is tested and used by no service.

### 13.4 Findings

| Id | Severity | Finding | Owner | Disposition | Deployment implication |
|---|---|---|---|---|---|
| F1 | medium, **open** | A message forged as an Auth event makes Notification send to a destination the forger chose: the payload carries the destination and the code, `source` is asserted only, and any consumer identity can write to `notification.events` through `amq.default` (ADR-0053 §4) | **P-A1 / A14** | not resolved; no A3M runtime change (it needs publisher identity, a separate architecture decision) | **a security prerequisite to review before Notification is activated in production** (and before `AUTH_EVENTS=on`) |
| F2 | medium, **open** (accepted residual) | Audit keeps the first writer of `(sourceService, eventId)`; with deterministic producer ids a forged first message makes the genuine one a visible `event_id_conflict` dead letter | **A7 / P-A1** | not resolved; ADR-0053's accepted residual is preserved | a security review before the relevant production activation (a second audit producer identity able to forge another's source) |
| F3 | low | Notification treats a same-id event with different content as a plain duplicate, with no conflict signal (Auth's ids are random, so the id is not predictable) | A3M.4 | behaviour pinned by a focused test (§13.5); no code change (OD-A3M4-2) | none |
| F4 | low | An outbox row that can never be published is retried indefinitely (backoff up to 15 s); there is no poison-row parking | A3M.4 | intended and documented (OD-A3M4-5): the outbox stays the source of truth; `OutboxBacklogAging`, `OutboxStatsStale` and `nawara-check-outbox-lag` report it. This is ADR-0053's intended behaviour for an Auth domain event its broker grant refuses | operators watch the outbox alerts |
| F5 | low | Billing's non-applied receipts grow by one row per delivery that does not apply | **A3M.5** | tracked with retention | none before retention is designed |
| F6 | low | Kit comments still say consumers de-duplicate "via the inbox" (`outbox-relay.ts`, `types.ts`) | next kit change | deferred (OD-A3M4-3): a comment-only kit change would build three images | none |
| F7 | info | An event dead-lettered by Notification after its retries is recovered only by an operator replay (no reconciler) | A8 / operations | intentional; `MessagesDeadLettered` alerts on it | the dead-letter runbook applies |

F1 and F2 are **not resolved** by A3M.4; they are recorded so that no production activation proceeds without their review.

### 13.5 A3M.4 evidence (local)

- **New test** (`apps/notification-service/test/intake.e2e-spec.ts`, "V2 A3M.4 (F3)"): a valid `membership.approved` event is accepted;
  the same source and event id with another recipient, channel, destination and organization is classified `duplicate`; exactly one
  intent and one delivery exist and they equal the first event's rows field for field; the second payload under its own event id is
  accepted as an independent intent; the first is still unchanged. The observed behaviour matched the discovery; no runtime code changed.
  The file: 43 passed (one disposable PostgreSQL, removed afterwards; Docker state unchanged). Notification unit suite 330 passed.
- **Reused, not rerun:** every other row of §13.1 to §13.3 points at an existing test that ran green in Core CI on `main` at `06e471a`
  (PR #235 G7, PR #236 contracts, PR #237 G11, PR #238 R11).
- **Production:** none. Documentation and one Notification test: Core CI only, no image build, nothing deploys.

## 14. A3M.5: outbox and de-duplication retention (2026-10-08, local)

- **Owner decisions:** OD-A3M5-1 = B (the retention policy plus a manually invoked, dry-run-first CLI); OD-A3M5-2 = every Billing
  payment receipt is kept, non-applied outcomes included; OD-A3M5-3 = Notification intents, deliveries and attempts are kept;
  OD-A3M5-4 = the `publishedAt` index migration is deferred; OD-A3M5-5 = no built-in age, an explicit one is required;
  OD-A3M5-6 = the deterministic-id producers are verified before anything of theirs is eligible.
- **Status in one line:** a CLI capability exists; **it runs nowhere**, nothing schedules it, no duration is chosen, and running it
  against any real database needs a separate, explicit authorization.

### 14.1 Why consumer records are kept

A duplicate effect needs an event to arrive again after its consumer has forgotten it. Three things can deliver an event again: the
relay (never: it does not re-read a row it stamped published), a producer writing the same id again (below), and the broker with an
operator: a dead-lettered message is kept until someone replays it, with its original id, at any later time. That last horizon has no
bound, so **no safe deletion horizon exists for a consumer's de-duplication record**. Deleting one of Billing's applied receipts would
release its event id; deleting a Notification intent would let a replayed event create a second intent and a second external send.

### 14.2 Retention policy

| Data | Decision | Reason |
|---|---|---|
| Unpublished outbox rows | **KEEP, always** | the only copy of an undelivered event |
| Published outbox rows with a random (version 4) id, **of an approved service** (auth-service, organization-service) | may be deleted **manually**, older than an explicit age | the relay never re-reads them; these services let the outbox generate their ids, so no row is what stops an event being written twice; every consumer keeps its own record |
| Published outbox rows of any other service | **KEEP** (the CLI refuses the service) | not reviewed for retention |
| Published outbox rows with a derived (version 5) id | **KEEP** (protected by the CLI, no option includes them) | the row is what stops a repeated operation from publishing the id again (§14.3) |
| Auth code-bearing outbox rows | unchanged: `CodeEventPurge`, always on, no switch | security control (ADR-0052 decision 5), not retention |
| Billing `payment_event_receipt`, applied and non-applied | **KEEP** | de-duplication record and commercial evidence; append-only by trigger; its retention is a legal decision (retention register) |
| Notification intents, deliveries, attempts | **KEEP** | de-duplication record, the evidence the provider-ambiguity rules need, and personal-data history whose retention is a product / legal decision |
| Audit records | unchanged: the Audit retention CLI, its own role and its owner-written policy | ADR-0049 §10 / A13; never A3M |
| Broker dead letters | **KEEP** until an operator inspects and replays them | runbook; never purged unseen |
| Kit `inbox` | nothing: no service writes to it | – |

### 14.3 Producers that derive their event id (OD-A3M5-6)

| Producer | Can the same id be written again once its published row is gone? | Consumer evidence | Eligible |
|---|---|---|---|
| payment-service, `payment.*` and its audit events | not found: each event is written in the transaction of a one-way, state-guarded transition (create is an insert on a unique request id; cancel, succeed, fail and expire check the state under a row lock) | Billing's applied receipts (kept) | **no (protected)**: safe by analysis, but making it eligible is a separate decision |
| billing-service, `invoice.created` | not found: only on `draft -> open`, a re-issue of an open invoice returns without writing | no Core consumer | **no (protected)** |
| billing-service, audit events | **not proven**: twelve call sites, ids from `(resource, action[, identity])`; not every action was shown to happen once per resource | Audit records (kept by Audit's own policy) | **no (protected)** |
| file-service, audit events | **yes**: `file.integrity_incident` uses one id per file and reason and is recorded on every detection (a download check or a reconcile run), so the outbox row is what collapses repeats into one event; after a deletion a repeat would be published again, and Audit would see an exact duplicate or an `event_id_conflict` dead letter (the detector differs) | Audit records | **no (protected)** |
| release-service, audit events | not found: written only when a release is really created or changed; the policy change carries its version in the id | Audit records | **no (protected)** |
| auth-service domain and audit events, organization-service audit events | random ids: the outbox row is never what prevents a second event | Notification intents, Audit records (kept) | **yes**, the only eligible rows |

**Eligibility is all four together: an approved service AND a version-4 id AND published AND older than the explicitly selected age.**

- **A version-4 id is not in itself evidence of safety.** The outbox accepts any id a caller supplies, and the audit writer any
  well-formed uuid: a producer could supply a *stable* version-4 id (a row's own key, say) and rely on the outbox to write a repeated
  operation's event once. Deleting that row would remove a real guarantee, and nothing in the database tells such an id from a
  generated one (the retention test suite shows it).
- **So eligibility is also a reviewed list,** `OUTBOX_RETENTION_VERIFIED_SERVICES` in the kit: exactly auth-service and
  organization-service, the two services verified to let the outbox generate every event id. Every other service is refused, with no
  option that widens the list.
- **`check:repo` keeps the list honest** (`checkOutboxRetentionEligibility`): the kit's list must equal the approved one; the CLI must
  require `--service`, check the database owner and have no bypass; an approved service's source may not use `deterministicEventId`,
  supply an `id` to `.enqueue`, build an `eventId`, or pass a spread object to those calls. It reads syntax and is **not a proof of
  every data flow** (an `id` placed in an event object built elsewhere and passed in a variable is not seen): **a producer that changes
  how it makes its event ids needs a retention-safety review**, and its removal from the list first.
- Making any derived-id producer, or any further service, eligible is an **open architecture decision**, not an option of the CLI.

### 14.4 The CLI (`nawara-outbox-retention`, in the kit)

- **Manual only.** No scheduler, no worker, no service starts it. `libs/service-kit/src/cli/outbox-retention.ts` over
  `src/events/outbox-retention.ts`.
- **Scope is explicit.** One service database per run. `--service <name>` is required (a dry run included) and must be on the reviewed
  list, or the run is refused before a connection is opened. `DATABASE_URL` (or `DATABASE_URL_FILE`) comes through the kit's
  `EnvReader` (both together refused; no argument carries a URL). `--database <name>` is required and must equal the database the
  connection really opens.
- **The service is tied to the database, not trusted.** A `--service` argument is an operator's statement, **not an authenticated
  identity**. What binds it is a database fact: the database must be **owned by the role provisioned for that service**
  (`<svc>_migrator`, ADR-0032: `infra/postgres/init/01-service-databases.sh` and the provisioning scripts), which a runtime role cannot
  change. A mismatch, or a database not provisioned that way, is refused before anything is read (fail closed). **Limit:** this proves
  the database was provisioned for the service, not who is running the command; and an installation whose database predates that
  layout (the Auth deploy script mentions such installs) is refused until its ownership is aligned, which is the intended outcome.
- **No default age.** `--older-than` is required (`30d`, `12h`, `45m`).
- **Dry run unless `--apply`.** A dry run prints counts and deletes nothing.
- **What it deletes:** rows with `publishedAt` set, published before the cutoff, with a random id; oldest first.
- **Bounded:** `--batch-size` (default 500, at most 5000) and `--max-batches` (default 20, at most 1000); each batch is one statement that
  locks only what it deletes and skips rows another session holds (`FOR UPDATE SKIP LOCKED`), so it never waits for the relay or for
  Auth's purge. It says when it stopped at its limit; the next manual run continues.
- **Output:** counts only (`eligible`, `protectedDeterministic`, `retainedRecent`, `unpublished`, the oldest eligible age, `deleted`,
  `batches`, `more`): never an event id, a name, a payload, an error text or a connection string.
- **Exit codes:** 0 done; 1 the run failed (nothing is retried); 2 refused arguments or configuration, decided before any connection.
- **Not built:** an index on `publishedAt` (OD-A3M5-4): the eligibility scan reads the table, which is acceptable for a manual run on
  today's sizes; a kit migration would reach every service database, the production ones at their next authorized migration.

### 14.5 Evidence (local, one disposable PostgreSQL, removed afterwards; Docker state unchanged)

- `libs/service-kit/test/outbox-retention.int-spec.ts`, 12 passed, with the built CLI: unpublished, recent and derived-id rows are
  never deleted, even at a one-minute age; a dry run reports counts and changes nothing; `--apply` deletes exactly the eligible rows;
  a missing or malformed age, a missing, malformed or wrong database name, a `--database-url` argument, out-of-range batch settings, a
  repeated argument and `DATABASE_URL` with `DATABASE_URL_FILE` are each refused with exit 2, nothing deleted; a row held by another
  session is skipped without waiting, that session can still delete it, and a later run finds nothing; batch limits hold and a second
  run continues; a database failure exits 1 with no value printed; no output contains a payload, an event name, a password or a
  connection string.
- **Allowlist and identity:** only auth-service and organization-service are accepted; a missing service and ten other names (the six
  other Core services included) are refused before any connection (proved with a closed port); `--all-services`,
  `--include-deterministic` and `--force` are refused; an approved name on a database owned by another service's role, and on a database
  with no provisioned owner, is refused with nothing deleted.
- **Ids:** versions 5, 7, 1 and 3, the nil uuid and an all-ones uuid are protected, with `--apply`; only the version-4 row is deleted.
- **The limitation, shown on purpose:** a version-4 id *supplied* by a caller is deleted, and the same operation then writes the id
  again, unpublished: the reason for the service list and the repository guard.
- `test:repo` 128 passed: the guard's fixtures (an approved producer supplying an id at the call, through the audit writer or in an
  options object, passing a spread, or using `deterministicEventId`; an extra, a missing or a non-literal list; a CLI that no longer
  requires or checks `--service`, lost the owner check, gained a bypass; a widened id rule) and the one flow it does not see.
- Auth's own purge tests (`apps/auth-service/test/domain-events-outbox.e2e-spec.ts`, 11 passed) run unchanged; Auth's code is untouched.
- Kit unit suite 514 passed; the new CLI is in the `EnvReader` CLI guard; `check:repo`; typecheck and lint.
- **Unchanged controls:** Auth `CodeEventPurge`, the Audit retention CLI and policy, Billing's append-only receipts, Notification's
  workers. No migration, no topology or grant change.

### 14.6 Still open

- The age to use, per service: an owner decision (forensics and replay), none is suggested here.
- Eligibility of the derived-id producers, and of any service beyond the two approved (§14.3): a separate architecture decision, after
  a retention-safety review.
- Billing receipts and Notification history: legal and product decisions (retention register).
- The `publishedAt` index, and any scheduling or run against a real database: separately authorized.
