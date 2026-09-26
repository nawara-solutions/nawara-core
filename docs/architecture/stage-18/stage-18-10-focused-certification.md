# Stage 18.10 — Focused certification and closure

- **Status:** certified on `feat/audit-focused-certification` (awaiting review; not committed). **Stage 18: CLOSED** (§9).
- **Scope:** certify every accepted Stage 18 guarantee against current evidence on real infrastructure, investigate failures, fix only
  genuine Stage 18 defects, and record what stays open. Focused on Audit only: **Final Core Validation was not run** (it stays last in the
  Core roadmap, Stage 22).
- **Not in scope (and not present):** new features, catalog actions, policy decisions (retention durations, erasure, Auth IP retention,
  alert destinations, broker credentials, backups), Stage 19+.

## 1. Baseline

`main` at `d4d49bb` (the Stage 18.9 merge, PR #123); working tree clean except the untracked `docs/reports/` (untouched); the Stage 18.1
– 18.9 records present. Infrastructure for every run: PostgreSQL 16.15 and RabbitMQ 3.13.7 (management variant) in Docker, one Linux host
(12 logical CPUs, 11 GiB).

## 2. Final architecture

```text
Producer (Payment · Billing · Organization · File · Auth)
   │
   ├── business mutation
   └── AuditEventWriter ── contract validation (fail closed), SAVEPOINT guard
          │
       SAME TRANSACTION (commit together, roll back together)
          ↓
        outbox ──── kit OutboxRelay (poll, publisher confirms, retry with backoff, drain at shutdown)
          ↓
       RabbitMQ  nawara.events  audit.<action>
          ↓
     audit-service consumer (audit-service.audit; retry; dead-letter policy: refused content redacted)
          ↓
     validate (catalog, producer admission) → insertOnce (sourceService, eventId) → sameEvidence
          ↓
     audit_record (append-only: runtime INSERT / SELECT only; retention only by a separate role past an owner-set horizon)
          ↓
     trusted query API (service token + AUDIT_SERVICE_POLICY; organization / platform scope; platform reads self-audited)
```

**Audit down:** a producer still commits — its audit intent is durable in its own outbox from that commit — and delivery resumes when
Audit returns (proven: 18.5 restart, 18.7 pipeline "audit down", 18.9 backlog). The guarantee holds exactly when the producer's local
transaction commits the intent; if the intent cannot be written, the business change rolls back.

## 3. Certification matrix

"Run" = executed in this stage on real PostgreSQL / RabbitMQ (all green, §5). Suites: `ib` ingestion-broker, `dlp` dead-letter-privacy,
`ops` operational, `ret` retention, `rl` rate-limit-janitor, `q` query, `per` persistence, `pipe` `test/e2e-audit-producers`.

| # | Guarantee | Proof | Run |
|---|---|---|---|
| G-1 | every active catalog action is wired; no producer emits an undeclared one | §4 static coverage (50 / 50) + runtime producer admission (`producer_not_admitted`) + per-producer audit suites | ✅ |
| G-2 | business change + audit intent atomic (commit both / roll back both) | producer audit suites: writer failure, contract refusal, outbox SQL failure per producer; `ingestion-pipeline` COMMIT / ROLLBACK | ✅ |
| G-3 | no synchronous HTTP to Audit; no best-effort audited mutation | static search (§4); the two documented detection writes (File integrity incident on download, Auth WebAuthn clone) are detections, never mutations | ✅ |
| G-4 | actor from verified context only (body, headers, `x-user-kind`, correlation, forged actor objects ignored or refused) | Payment "ACTOR is the authenticated caller" + G1 start/sync (header ignored); Organization spoof headers; Auth `x-user-kind` on org-admin; Billing `withVerifiedKind` | ✅ |
| G-5 | organization from persisted state; request cannot forge it; `null` = platform, never "all" | Payment seller ≠ organizationId → 400; Organization `self`; File other-org → 404; Auth other company → 404, body `organizationId` → 400; `q` platform=true only null | ✅ |
| G-6 | G1–G5 widenings narrow; refused elsewhere | contract `catalog-corrections.spec.ts` (22) incl. "exactly 16 actions accept a member" | ✅ |
| G-7 | ingestion: valid, duplicate, conflict, refusal, transient, retry, exhaustion, recovery | `ib` (35) | ✅ |
| G-8 | idempotency: same evidence → one record; different → conflict, stored record untouched | `ib` EXACT DUPLICATE, CONCURRENT DUPLICATES / CONFLICTS; `per` insertOnce; `pipe` closure (two sources, same id → two records; same source, other evidence → DLQ) | ✅ |
| G-9 | append-only: runtime cannot UPDATE / DELETE / TRUNCATE | `per` runtime-role tests; `ret` runtime boundary | ✅ |
| G-10 | refused sensitive content never survives in `audit_record`, the DLQ body / headers / ids, logs or metrics; replayability only per 18.8 | `dlp` (6: 10 hostile shapes, malformed / binary / hostile headers, retained cases, `not_replayable`); contract screen fuzz; `ops` flood (snapshot labels closed-set) | ✅ |
| G-11 | DLQ copy not confirmed → raw original never acked or dead-lettered; bounded hold; safe requeue; bounded shutdown; recovery to the redacted path | `ops` O1 + kit "held for the retry delay" (incl. a 4 s hold cut by `close()`) | ✅ (25 / 25 repeats, §6) |
| G-12 | database outage: ingestion retries, query fails closed (never an empty 200), recovery without loss | `ib` DATABASE OUTAGE; `ops` QUERY while PostgreSQL refuses connections; `health` | ✅ |
| G-13 | broker outage: outbox durable, relay / consumer recover, no loss, no tight loop | `ib` BROKER LOST / DOWN AT STARTUP / SERVICE RESTART; `pipe` Payment (broker cut by proxy, audit down); kit consumer-recovery | ✅ |
| G-14 | crash windows (commit then crash before ACK → one record; transient insert failure → retried) | `ib` CRASH AFTER COMMIT, CRASH BEFORE INSERT, A DATABASE FAILURE AT THE INSERT | ✅ |
| G-15 | retention: beyond horizon only; the **trigger itself** refuses inside the horizon; per category; runtime cannot delete; retention role restricted; owner refused with triggers on; bounded, restartable, ledger-correct, dry run | `ret` (13, deletes by `id` and requires the trigger's message + positive control); `ops` SIGKILL / connection-terminated / concurrent runs | ✅ |
| G-16 | query: exact organization, platform rows excluded, filters / cursors cannot widen, capabilities not implied, self-audit fail-closed, windows, keyset, `no-store`, bounded pages | `q` (33) | ✅ |
| G-17 | rate limits apply, cannot be spent by another caller, janitor removes only ended windows, bounded | `q` rate-limit test; `rl` (5) | ✅ |
| G-18 | observability: bounded closed-set signals; no ids or payload values | `ops` flood (every snapshot key=value from closed sets; exact counts); `BrokerNotices` / ingestion counters | ✅ |
| G-19 | log-storm protection (budgeted, counted, suppression reported) | `ops` flood: ≤ 20 lines per kind, `logs_suppressed` exact | ✅ |
| G-20 | shutdown bounded, unfinished work recoverable (idle, ingestion, DLQ hold, dependency outage) | `process` SIGTERM / SIGINT (built process, DB down); `ib` SHUTDOWN with a delivery stuck, cancelled at shutdown START; `ops` O1 shutdown during the fault; `health` DB unreachable | ✅ |
| G-21 | `/health` liveness; `/ready` database + migrations + broker + ingestion; transitions; no secret leak | `foundation`, `health`, `ib` broker tests, `ops` query test; image smoke | ✅ |
| G-22 | backlog recovery | `ops` 3 000-event backlog (observation, §5) | ✅ |
| G-23 | data minimization | §4 (catalog `changes`: identifiers, codes, booleans, integers, timestamps only); per-producer and `pipe` PROHIBITED scans | ✅ |
| G-24 | service-kit boundary: DLQ privacy opt-in; unrelated consumers unchanged; kit carries no Audit policy | kit suites (132 + 114); `real-broker` (Billing / Payment / Notification / Auth consumers, 13); the policy lives in audit-service (`auditDeadLetterPolicy`) | ✅ |

## 4. Catalog and producers

Derived from `libs/audit-contract/src/catalog.ts` (not from history): **50 actions** — Auth 24, Billing 11, Organization 7, Payment 5,
File 2, audit-service 1 (`platform_query.executed`); Notification 0 (no audit-worthy action). Static check: every action's literal appears
in its own producer's source; no producer source names another producer's action or an uncatalogued `audit.*` action; the writer refuses
at runtime any action whose catalog producer is not the writing service. No producer references an Audit URL or calls audit-service over
HTTP; no audited mutation swallows a writer failure. The 18.7 action matrix (actor source, organization source, resource, subject,
changes, transaction boundary) stands unchanged.

**Data minimization:** the catalog's `changes` keys are `authority`, `operation`, `reason`, `method`, `settled_method`, `page`,
`target` (codes), `invoice_id`, `invitation_id`, `platform_id`, `price_id`, `product_id` (UUIDs), `filtered`, `was_admin` (booleans),
`result_count`, `window_days` (integers), `period_end` (timestamp transition). No name, contact, address, IP, user agent, payment
reference, provider payload, storage key, token, secret or snapshot is expressible.

## 5. Evidence (this stage)

| Suite | Result |
|---|---|
| `@nawara/service-kit` unit / integration | 132 / 114 |
| `@nawara/audit-contract` unit / integration | 1011 / 10 |
| audit-service unit / E2E (14 files) | 224 / 376 |
| Payment / Billing / File audit suites | 12 / 12 / 8 |
| Organization audit + admin (incl. G5) | 36 |
| Auth audit (actions, outbox, WebAuthn) | 36 |
| producer pipeline + cross-producer closure (`test:e2e:audit-producers`) | 13 |
| real-broker cross-service (`test:e2e:real-broker`) | 13 |
| audit-service image smoke | passed (uid 1000, `/health` 200 stable, `/ready` 503 without a database) |
| `check:repo`, lint, typecheck | pass |

Observations (not capacity claims): backlog of 3 000 drained at ≈ 1 900–2 000 events/s (18.9 runs, re-run green here); DLQ-confirm fault:
≈ 9 deferrals per 4 s with a 400 ms hold, shutdown during the fault < 70 ms.

## 6. The 18.9 O1 flake — resolved

18.9 recorded one unexplained O1 failure and attributed it to the management API's sampled queue statistics lagging a wait of 15 s. The
timing disproves that exact hypothesis: the failed run lasted 14.0 s in total, so it cannot have been a 15 s wait timing out. It fits the
OTHER statistics-dependent wait: `rejectPublishes` polled the management API until the queue's sampled `policy` field showed the policy
(10 s budget). Both waits read **sampled, eventually consistent statistics**, not broker behavior.

**Fix (test-only, the guarantee unchanged):** whether the fault is in force is now decided by **authoritative broker behavior** — a probe
published to the DLQ on a confirm channel is nacked (policy active) or confirmed (inactive; purged) — in both the audit-service helper and
the kit test. The "not lost" assertion during the fault, which also read sampled statistics, is replaced by the authoritative one already
present: after shutdown the message is back in the work queue (an acknowledged or dead-lettered message could not be). **Repetitions after
the fix:** O1 alone **20 / 20**, the full operational suite **5 / 5** (O1 included): 25 / 25.

## 7. Final mutation campaign

| # | Mutation | Result |
|---|---|---|
| C1 | ACK before the durable insert | killed |
| C2 | duplicate protection removed | killed |
| C3 | raw DLQ fallback (broker dead-letters the untouched original) | killed (kit + audit) |
| C4 | bounded DLQ hold removed | killed (kit + audit) |
| C5 | retention allowed inside the horizon (trigger) | killed (the 18.9-corrected test) |
| C6 | organization query scope disabled | killed |
| C7 | DLQ privacy bypassed (every refused body kept) | killed |

Every mutated file restored and hash-verified (5 / 5); every `dist` rebuilt from the restored sources.

## 8. Production prerequisites — open (not closed by this stage)

| # | Item | Owner / nature |
|---|---|---|
| P-A1 | per-service RabbitMQ users, `^audit\.` write permissions, broker-validated `user-id` — until then `sourceService` is catalog-checked but **asserted**, not broker-proven | security / infrastructure |
| P-A2 | retention durations per category — the policy table ships **empty** (never purge) | legal / owner |
| P-A3 | erasure / pseudonymization policy for audit records | legal / privacy |
| P-A4 | alert routing (DLQ depth, ingestion lag, clock skew, invalid-event rate; the snapshot carries the signals) | operations |
| P-A5 | Auth local-audit raw-IP retention and minimization (a decision: 18.8 §7) | privacy / owner |
| P-A6 | RabbitMQ in production (incl. a broker for the deployed Auth, 18.7) | infrastructure |
| P-A7 | `audit` database backup / restore preserving append-only guarantees | operations |
| P-A8 | `AUDIT_SERVICE_POLICY` entries for real readers (products, the Stage 19 admin service) | Stage 19 / products |
| — | DLQ access control on the broker (who may read `*.dead`) | security / infrastructure |
| — | `AUDIT_RETENTION_PASSWORD` provisioning and a scheduler for `npm run retention`, once durations exist | operations (after P-A2) |
| — | production RabbitMQ validation (audit-service deployed before producers: A50) | release |

## 9. Verdict

Every Stage 18 guarantee of §3 is supported by passing evidence produced in this stage on real PostgreSQL and RabbitMQ; the one open
test-stability item (O1) is resolved with authoritative evidence and repeated 25 times; the final mutations are all killed; no policy was
invented; the production prerequisites above remain explicitly open and are not part of Stage 18's implementation closure.

```text
STAGE 18 — SECURITY & BUSINESS AUDIT TRAIL
18.1 Architecture & Decisions             ✅
18.2 Service Foundation                   ✅
18.3 Persistence + Append-Only Model      ✅
18.4 Canonical Audit Contract             ✅
18.5 RabbitMQ / Outbox Ingestion          ✅
18.6 Query + Authorization                ✅
18.7 Core Producer Integration            ✅
18.8 Security / Privacy / Retention       ✅
18.9 Operational Hardening                ✅
18.10 Focused Certification               ✅
STAGE 18 STATUS: CLOSED
```

Next: Stage 19 (Security / Platform Administration), on its own branch after this review.
