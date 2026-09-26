# Stage 18.8 — Security, privacy and retention

- **Status:** implemented and validated on `feat/audit-security-privacy-retention` (awaiting review; not committed).
- **Scope:** protecting the audit system and its evidence beyond the accepted record: the rejection, retry and dead-letter paths, logs,
  the query limiter's state, and the retention mechanism of ADR-0049 A41 (separated from runtime authority, with no duration).
- **Not in scope (and not present):** new catalog actions, any change to producers or to the same-transaction guarantee, a retention
  duration, an erasure mechanism, Auth's local-audit retention (a decision, §7), per-service broker identity (P-A1), the operational
  campaign (18.9), certification (18.10), Stage 19+, Final Core Validation.
- **Frozen design followed:** [ADR-0049](../../adr/0049-audit-trail-architecture.md) decisions 7, 8, 10 (A23–A32, A41, A42, A45, A50,
  T10–T14, T23), [Stage 18.1 §13–§14, §19](./stage-18-1-decisions-and-roadmap.md). No ADR changed; one interpretation recorded (§3).

## 1. Baseline and investigation

`main` at `a814c93` (the Stage 18.7 merge, PR #121); working tree clean except the untracked `docs/reports/` (untouched). Read: ADR-0049,
the 18.1–18.7 records, the SDD, audit-service source and migrations, `@nawara/audit-contract`, the kit's RabbitMQ bus, dead-letter tools,
outbox relay, rate limiter and exception filter, the Core provisioning script, the producers' audit modules. Findings carried in:
18.4 F7 (fuzzing, log scans), 18.5 F3 (DLQ copies), 18.6 F3 / F5 (limiter purge, retention class), 18.3 (the retention hook).

| Question | Evidence (before 18.8) |
|---|---|
| What reaches the DLQ? | The kit republished the ORIGINAL body (`msg.content`) and EVERY original header (minus broker bookkeeping) plus annotations. A message refused *because* it carried a credential (`sensitive_field` / `sensitive_value`), free text, contact data or arbitrary publisher headers sat verbatim in `audit-service.audit.dead`; non-JSON garbage (`malformed`) too. If the annotated copy could not be confirmed, the kit NACKed and the broker's own dead-lettering moved the raw original. |
| Retry queue | A full copy for the retry delay (3 × 5 s by default), then the DLQ. Transient failures occur after validation (the insert), so a retried body is normally a validated one. |
| Logs | audit-service logs carry reason codes, the validated action / source and a grammar-checked event id only; the kit's notices carry grammar-checked ids and error class names; the relay redacts and bounds `lastError`; contract errors' messages equal their code; the HTTP filter logs an error's name and message, never pg `detail`. **No payload logging found.** |
| Records at rest | Contract-validated, identifiers and codes only (18.4); unchanged. |
| Runtime privileges | `audit_app`: INSERT, SELECT on `audit_record`; the trigger refuses UPDATE / DELETE / TRUNCATE for everyone (18.3). |
| Retention | Mechanism decided (A41), not built: no role, no policy, no purge; `("recordedAt")` index present. Durations: P-A2 (owner / legal), default "never purge". |
| Erasure | A42: reserved (`audit.record_redacted` by a maintenance role), not built; policy P-A3. |
| Limiter state | `kit_rate_limit` rows for `audit_query_org_caller`, `audit_query_org_pair` (per caller × organization), `audit_query_platform_caller`: no purge; grows with every organization ever read. Keys are sha256 digests. |

## 2. Threats addressed

| # | Threat | Before | After |
|---|---|---|---|
| T10 | secrets / PII smuggled in a refused event | refused, but kept verbatim in the DLQ | refused AND not retained (§3) |
| — | arbitrary publisher headers | kept on the DLQ copy | dropped; only validated kit headers survive |
| — | DLQ as a data store (18.5 F3) | yes | no: bodies kept only when every value is a grammar token |
| T12 | log injection / leakage | ids and codes only | unchanged, now proven by marker scans (§9) |
| T14 / T23 | record deletion / retention bypass | nothing could delete; no retention | runtime still cannot; only a separate role, only past a policy horizon, ledgered (§5) |
| — | limiter state growth | unbounded | bounded purge (§6) |

## 3. Dead-letter privacy (18.5 F3 — closed)

**Rule (the one interpretation of this stage).** ADR-0049 A50 requires that an event refused only for lack of catalog knowledge (an
unknown action or version during a mis-ordered rollout, or a rule a catalog correction later widens — exactly G1–G5 in 18.7) stays
replayable. Dropping every refused body would break that. So the DLQ keeps a body **iff** it passes a catalog-independent screen
(`mayRetainRefusedAuditBody`, `@nawara/audit-contract/consumer`): the validator's own sensitive-key / secret-shape / bound scan, only the
canonical top-level fields, and every value a grammar token (UUID, code, service name, timestamp, boolean, bounded integer). Such a body
cannot carry free text, contact data, a secret or a blob. Everything else is **redacted**.

| Dead-letter case | Before | After |
|---|---|---|
| valid event, insert failed (`retries_exhausted`), `event_id_conflict`, `invalid_record` | original body + all headers | original body (validated, replayable) + validated kit headers only |
| catalog-knowledge refusal whose body is grammar tokens (`unknown_action`, `unsupported_version`, a narrower actor / organization rule, another producer) | original + all headers | original (replayable after the upgrade) + validated headers only |
| `sensitive_field`, `sensitive_value`, `unknown_field`, `invalid_payload`, `payload_too_large`, free text in any field | original + all headers | **redacted**: body `{"redacted":true,"failure":…,"reason":…,"bodyBytes":n}`; validated headers only; `x-nawara-body-redacted: true` |
| `malformed` (non-JSON, binary, no id / type) | original + all headers | **redacted**; the message id and type kept only when they are safe tokens |
| copy cannot be confirmed | NACK → broker moves the raw original | requeued (redelivered, re-handled idempotently, dead-lettered through the policy once the broker confirms) |

**Kept for forensics:** which event (validated id), claimed source, correlation, occurred-at, failure class, reason code, error class,
failed-at, retry / replay counts, body size. **Not kept:** no digest of a redacted body — an unkeyed hash of a short body (a phone number
alone) can be reversed by trying candidates. **Replay:** `nawara-dlq replay` refuses a redacted copy (`not_replayable`, exit 5, the copy
stays); `list` shows `body=redacted`. **Residual:** a retained body can hold lowercase identifier-shaped tokens (`[a-z][a-z0-9_.]`, ≤ 64,
no space, `@` or `+`) in a code field, since the screen cannot know each action's allowed values without the catalog.

**Implementation.** The kit's `RabbitMqEventBus` gains an **opt-in** `deadLetterPolicy` on a subscription (audit-service's is
`auditDeadLetterPolicy`); without one, every other consumer behaves exactly as before. The kit always keeps its own validated replay
counters. A policy that throws redacts with no header (fail closed).

## 4. Retry, logs, central-record minimization

- **Retry queue:** unchanged — a retry needs the body. A transient failure follows validation, so the copy is a validated body for at
  most the retry budget (3 × 5 s), then dead-lettered through the policy. Arbitrary headers ride along for those seconds, never beyond.
- **Logs:** no change needed (§1); proven: every marker of §9 is absent from every captured log line of the DLQ and retention suites.
- **Central records (50 actions):** re-checked against the 18.7 action matrix: actors are UUIDs / service names / process codes, every
  organization / resource / subject id a UUID, `changes` catalog-keyed, typed and bounded (≤ 8 keys, ≤ 1 KiB, `audit_changes_valid` in the
  table as well), correlation / causation grammar-checked; no presentation data. No violation found; nothing changed (and nothing broadened).
  Stable identifiers stay: they are the accountability (A30, A42).

## 5. Retention (A41 — mechanism built, no duration)

Migration `0003_retention.sql`:

| Object | Who | Rule |
|---|---|---|
| `audit_retention_policy` (category → `retainDays` 1–36500, `setAt`, `setBy`) | owner (migrator) writes; retention role reads; runtime: nothing | **ships empty = never purge** (P-A2) |
| append-only trigger | everyone | UPDATE / TRUNCATE refused; DELETE admitted only if the row's category has a policy AND its `recordedAt` (Audit's database clock — never the producer-controlled `occurredAt`) is past the horizon |
| `audit_grant_retention(role)` | owner only | DELETE + SELECT(`id`, `category`, `recordedAt`) on `audit_record`, SELECT on the policy, SELECT / INSERT on the ledger; **refuses a role that can INSERT / UPDATE records** (the runtime) |
| `audit_retention_run` | retention role inserts; append-only | one row per purge batch, in the batch's own transaction |
| `audit_record_retention_idx (category, recordedAt, id)` | — | measured: without it a batch stepped over 315 015 older rows of a never-purged category (62 ms, growing forever); with it an index-only range scan (4 ms) |

`infra/postgres/init` creates the third role `audit_retention` (only when `AUDIT_RETENTION_PASSWORD` is set). The run
(`npm run retention -w audit-service`, `RETENTION_DATABASE_URL`) refuses any role that can write records (runtime or owner, checked from
the privilege catalog), purges each policy category in bounded, ordered batches (one transaction each: DELETE + ledger row), stops at
`--max-batches` and resumes on the next run, supports `--dry-run`, prints counts only. There is no HTTP deletion route and no erasure
endpoint. Setting a duration is a deliberate owner act (runbook in the service README).

**Guarantee, precisely:** the runtime can never delete or alter a record; the retention role can delete only rows past an owner-set
horizon and cannot read the evidence it deletes; the owner and a superuser remain trusted (A45; they can disable triggers). **Residual:**
purging frees an event's (`sourceService`, `eventId`), so a replay of a purged event would be stored again (horizons far exceed any replay
window; A43's receipt table is the future answer if needed).

## 6. Query limiter state (18.6 F3 — closed)

`RateLimitJanitor` (a kit `PollLoop`, every 60 s, stopped at shutdown start): deletes only audit-service's three buckets' rows whose window
ended, ≤ 500 per statement, ≤ 20 statements per pass, `FOR UPDATE SKIP LOCKED`. An ended window carries nothing the next hit needs (the
kit resets it to 1), so a purge can never grant a request; a window still running is never touched (tested: a caller at its limit stays
refused after a purge). Keys stay sha256 digests.

## 7. Auth's local security audit (P-A5 — a decision, not built)

`auth_audit_event` is Auth's own security trail (the Core ADD keeps it in Auth): append-only, **raw IP**, session family, bounded metadata,
~37 event types, nothing purges it. Central audit never receives IP / user agent (A32; 18.7 tested). What 18.8 found:

- Its retention is P-A5 (privacy; Core validation F12) — a legal duration nobody has decided.
- *How* to minimize it is itself an architecture choice ADR-0049 does not make: (a) purge whole rows after N days (loses the security
  history), (b) null or key-hash (HMAC) the `ip` after N days while keeping the event (A32's own direction for any future central origin),
  (c) both, with different horizons. Each needs an Auth migration and a maintenance role like §5.

Per this stage's rule (a decision not covered by ADR-0049 → report, do not invent), **nothing was changed in Auth**. Recommended for the
owner: (b) with a configurable horizon, using §5's pattern.

## 8. Erasure (A42 / P-A3), broker trust (P-A1), producer semantics

- **Erasure:** unchanged and not built. Records hold pseudonymous identifiers only; erasing an identity in Auth leaves ids that resolve to
  nothing (the intended minimization). Whether a legal erasure request must also remove or re-pseudonymize audit evidence, and for how
  long evidence prevails, is legal policy (P-A3); the reserved mechanism (a maintenance-role redaction recorded as its own action) would
  need a catalog action and a decision. No generic "delete a user's records" exists.
- **Broker trust:** `sourceService` is the envelope's **claimed** `source`, checked against the catalog producer (catalog binding) — not
  proven by broker credentials. One shared broker user remains; any holder of it can claim another service's source for that service's
  actions. P-A1 (per-service users, `^audit\.` write permissions, validated `user-id`) stays a production prerequisite.
- **Producers:** unchanged. The same-transaction guarantee and its two deliberate exceptions (File integrity incidents and Auth's WebAuthn
  clone detection write in their own short transaction so evidence never undoes a protective action) are as 18.7 proved them. The 18.7
  production requirement of `RABBITMQ_URL` for Organization / File / Auth is **correct architecture**: the outbox makes evidence durable at
  commit whatever the broker does, but a process without a broker would accumulate it forever and never deliver it (A19, A47); failing
  closed at boot is the honest behavior. It stays a deployment prerequisite (P-A6), with audit-service deployed first (A50).

## 9. Evidence

| Suite | Result |
|---|---|
| `@nawara/audit-contract` (incl. dead-letter screen: every catalog event minimal / complete, catalog-dependent refusals, 13 hostile shapes, 5 000-case fuzz) | 1011 unit / 10 integration |
| `@nawara/service-kit` (incl. 3 real-broker dead-letter policy tests) | 132 unit / 113 integration |
| audit-service unit / E2E | 224 / see report |
| — DLQ privacy (real RabbitMQ 3.13 + PostgreSQL 16): 10 refusal shapes + malformed / binary / hostile ids and headers → redacted; markers absent from `audit_record`, DLQ bodies, headers, ids, and logs; retained-body cases; replay refusal | 6 |
| — retention (real roles): default never-purge, runtime / retention / owner boundaries, minute-level cutoffs, batches / restart / idempotence, concurrent inserts, failure halfway, policy re-check, index plan at 320 000 rows, the built CLI | 13 |
| — limiter purge | 5 |

Markers used (synthetic): `STAGE18_SECRET_MARKER`, `STAGE18_TOKEN_MARKER`, `privacy-marker@example.invalid`, `+99912345678`.

## 10. Deferred

- **Production prerequisites:** P-A2 retention durations (owner / legal; none set); P-A3 erasure policy; P-A5 Auth local-audit
  retention and IP minimization (§7 decision); P-A1 per-service broker identity; P-A4 alert routing; DLQ access control on the broker
  (who may read `*.dead`); `AUDIT_RETENTION_PASSWORD` and a scheduler for `npm run retention` once durations exist.
- **18.9:** the unconfirmable-copy requeue path under broker fault injection (implemented, not fault-tested here); retention at
  production volume and a purge schedule; DLQ depth / redaction counters in the ops snapshot.
- **Stage 21:** the duplicated correlation / UUID helpers (18.7) stay deferred.
