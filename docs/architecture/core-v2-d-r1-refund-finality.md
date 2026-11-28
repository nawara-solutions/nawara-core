# Core V2 D-R1: fail-closed refund finality

Status: **D-R1A merged (#548) and D-R1B implemented (migration `0037`, the Owner's GO of 2026-11-24, pending the Owner's merge review);
both for development and simulation only.** DO-76 and OD-RLSC-1 stay OPEN. No real provider is certified; no provider is activated;
nothing here is a production change.

Source: the Owner's D-R1 direction of 2026-11-23 (Q1 to Q6). Related: S6b (PAY-07, R6B-3, R6B-4), RLSC-1 (`0033`), DO-76 S1 (`0032`),
G3 (`0034`), D-R3 (`0035`), FDR-10 (provider evidence, V3).

## 1. The problem

A `failed` refund attempt is not effective (`NOT_EFFECTIVE`, `refund_attempt_one_effective`, `refund_attempt_one_effective_capture`).
A fresh Owner receipt then authorizes a replacement. If the provider later pays the first attempt anyway, two refunds of one capture
move money (the RLSC-1 P5 and P6 reproductions). An existing `failed` status is not proof that no later success is possible. Only a
provider guarantee can establish that, and none is certified.

## 2. Part A: architecture

1. **Authoritative source of capabilities.** One reviewed registry in code:
   `apps/payment-service/src/providers/refund-capabilities.ts` (`REFUND_CAPABILITY_CERTIFICATES`).
   - A change to it is a pull request that the Owner merges.
   - An adapter only references certificates (`ProviderCapabilities.refundCapabilityCertificates`), so it can never certify itself.
   - There is no environment variable, database row or runtime path that grants a capability.
2. **Provenance, versioning and revocation.** Each certificate has:
   - an id and an integer version; a changed grant or basis is a new version, never an edit;
   - the provider id it applies to (never transferable) and a scope (`simulation` or `provider`);
   - an issue instant, and an expiry (mandatory for `provider` scope);
   - the authorization, the documentary basis and the verified adapter mapping;
   - a SHA-256 content fingerprint.

   `REFUND_CAPABILITY_REVOCATIONS` lists revoked id and version pairs. A revocation is permanent, and a malformed revocation still
   revokes.
3. **Historical attempts.** A finality decision must name the certificate, version and fingerprint it was made under
   (`refund_attempt_failure_finality`, D-R1B). Every `failed` row from before `0037` has no such record, so it is never final
   (`failureFinalityOf(null)` gives `no_finality_record`). Certification is never applied retroactively to history.
4. **Failed-attempt transitions** (unchanged in D-R1A; D-R1B refuses the second one for an attempt with its own refund fact, OD-DR1-1):
   - a definitive dispatch refusal (`RefundWorker.dispatch`, `rejected`) gives `failed`;
   - a provider-confirmed failure of an in-flight attempt (`RefundEvidenceService.applyStatus`) gives `failed`;
   - a verified success of a `failed` attempt gives `discrepancy`, or the RLSC-1 escalation while another attempt is effective.
5. **Effective-attempt unique indexes** (`0017`, `0022`) count every status except `authorization_expired`, `authorization_refused` and
   `failed`. D-R1B makes an uncertified `failed` attempt count as potentially effective for new attempts (§4). The indexes
   themselves cannot do that, because a `failed` attempt that later becomes `discrepancy` must stay representable.
6. **Capture-level evidence guard.** `refund_capture_has_evidence` (`0022`) refuses a new attempt or dispatch once the capture has refund
   evidence. It does not see an attempt that may still pay but has no evidence yet. D-R1B closes that gap.
7. **Concurrency and transactions.** Every attempt insert takes the payment row lock first (`0017`). The dispatch transition holds the
   payment's refund-dispatch advisory lock exclusively, and refund-fact writers hold it shared (`0032`). D-R1B's guard runs inside the
   insert trigger under the same payment row lock, so two workers or requests cannot both pass it.
8. **Missing capability data.** Every refusal reason is `certified: false`:
   - `not_declared`, `unknown_certificate`, `version_mismatch`, `duplicate_certificate`, `malformed_certificate`;
   - `provider_mismatch`, `simulation_scope_outside_simulation`;
   - `not_yet_valid`, `expired`, `revoked`, `not_granted`, `ambiguous`.

   An unreadable database time also certifies nothing.
9. **Escalation and Audit contracts.** Two additive kinds of `refund_safety.escalated`, in the same version, following G3's precedent
   (§3). There is no new action, so the topic grants are unchanged.
10. **Rollout.**
    - Production has no refund-capable provider and no certificate, so every evaluation there is `certified: false`.
    - The simulation's references are honoured only for provider id `simulation` in a non-production simulation environment.
    - The registry holds no `provider`-scope certificate.
    - A provider configuration change or certificate removal takes effect at the next evaluation, including for existing records.

**What a finality capability must guarantee.** No later success is possible for that attempt's key, amount and observed failure kind
(`dispatch_rejected`, `provider_failed`). A fresh status read alone never establishes this.

## 3. D-R1A: the foundation (implemented, development and simulation only)

*As merged in #548. D-R1B (§4) has since changed replacement eligibility and, under OD-DR1-1, the last transition of Q4.*

**Not changed by D-R1A:** replacement eligibility, allocation, case completion, held dispatches, the first send, and every approved state
transition. D-R1A did **not** solve double refunds; E1 of `test/dr1a-refund-capabilities.e2e-spec.ts` is now the negative control.

**Capability model (Q1, Q3)** in `refund-capabilities.ts`:

| Capability | Grant | Used in D-R1A |
| --- | --- | --- |
| `terminalFailureFinality` | `observations` (`dispatch_rejected`, `provider_failed`) | No; D-R1B uses it |
| `authoritativeNotFound` | `granted` | No: refunds never act on "no record" (Rule 3) |
| `idempotencyKeyRetention` | `lifetimeMs`, or `unbounded` (simulation scope only) | Yes: same-key resend (Q5) |
| `cancellation` | `granted` | No |
| `statusAuthority` | `webhook`, `statusRead` | No: conflicting observations are always preserved, never ranked |

**Simulation certificates (Q6):**
- `simulation-refund-contract` v1 grants unbounded key retention and both authenticated channels. Its basis is the append-only
  `simulation_refund_dispatch` table (`0017`). The simulation always references it, so R6B-4 is unchanged.
- `simulation-refund-failure-finality` v1 models terminal failure finality. It is referenced only with
  `PAYMENT_SIMULATION_REFUND_FAILURE_FINALITY=true`, which is refused without the simulation provider. Nothing reads it in D-R1A.

**Q4 conflict preservation (migration `0036`, kind `failure_after_refund_evidence`):**
- **When:** a provider-confirmed failure (a status read, a verified webhook, or a definitive dispatch refusal that races a
  success) arrives for an attempt that already has its own verified refund fact. The attempt is in flight, `succeeded`,
  `discrepancy`, or `failed` with a late verified success already kept by RLSC-1 or D-R3.
- **What is kept:** the failure is recorded once per attempt, before any transition, with its bounded code (`observedFailureCode`),
  its derived status and its audit intent. The fact is never touched.
- **What is unchanged:** the approved transitions.
  - A `succeeded` or `discrepancy` attempt stays as it is.
  - An in-flight attempt still becomes `failed`, and D-R3 then decides its fact.

  **Whether that last transition should be refused is an open Owner decision (§6, OD-DR1-1).**

**Q5 retry safeguard (kind `idempotency_retention_unproven`):**
- **Rule:** the worker sends an attempt's key again (`dispatching` after a crash, or `unknown` answered "no record") only while
  `idempotencyKeyRetention` is certified. The window is measured in database time from `authorizedAt`, which is no later than the first
  send.
- **Otherwise:** nothing is sent and the attempt stays unresolved. One escalation is kept per attempt (no fact; status `dispatching` or
  `unknown`), and the provider's status is still read and applied.
- **What it is not:** never a new key, a failure, a hold or a release. The first send from `authorized` is unchanged.

**Limit (closed by D-R1D, §4b):** a definitive dispatch refusal whose decision transaction failed after a concurrent success used to be only logged
(OD-DR1-6). It is now stored before the decision and applied by recovery (C9 is a positive test).

**Visibility:** both kinds appear in the Owner-only PAY-12 `refund_safety_escalation`. The detail carries `observedFailureCode` or
`authorizedAt`.

**Database guard (`0036`):**
- Two branches are added to the escalation insert guard; its four existing branches are textually unchanged.
- The existing kinds keep their shapes. `observedFailureCode` belongs to `failure_after_refund_evidence` only, and `factId` is null
  exactly for `dispatch_stalled` and `idempotency_retention_unproven`.
- The escalation table stays append-only. No row is rewritten and nothing is backfilled.

## 4. D-R1B: the replacement guard (implemented, development and simulation only)

**Invariant.** No replacement attempt is created or sent while another attempt of the same payment or capture could still move funds
enough to cause an unauthorized excess.

**Database contract (migration `0037`).** It is additive. No existing guard, index, row or allocation rule is edited, and nothing is
backfilled.

1. **`refund_capability_certificate`: the mirror of the code registry.**
   - Each row stores the certificate's canonical content. The fingerprint is re-computed from that content by a CHECK, and the id,
     version, provider, scope, window and covered observations are bound to it.
   - A CHECK allows the `simulation` provider and scope only. A real provider needs another reviewed migration that changes it.
   - Two certificates are seeded, exactly the code registry. A test compares them both ways (T1).
2. **`refund_capability_revocation`:** one permanent row per certificate version. A row ends that version at once.
3. **`refund_attempt_failure_finality`: at most one row per attempt.**
   - It names the attempt, its key (the attempt id), the observation and its source (`dispatch_response`, `status_check`, or `webhook`
     with the stored notification), the failure code and the exact certificate (id, version, fingerprint and provider, by foreign key).
   - Accepted only while the attempt is in flight. A deferred check then requires the same transaction to commit it as `failed` with that
     code, so an attempt that already failed (all history) can never be given one.
   - Refused when the certificate is not in force for that provider and observation, or the capture has refund evidence. Payment, capture,
     provider, key and time are derived, never taken from the caller.
   - When a claim is not admissible, the application records the failure without finality. A failure observation is never lost over it.
4. **`refund_attempt_may_still_pay`.** Everything may still pay except `authorization_expired`, `authorization_refused`, and a `failed`
   attempt for which all of these hold at this instant:
   - its finality row's certificate is registered, inside its window and not revoked;
   - it has no refund fact of its own;
   - no refund fact exists under its exact provider reference, whoever that fact is bound to. Such a fact is ambiguous and therefore not
     final. It is read only and attributes nothing (F-29 stays locked).
5. **The guard** (`refund_attempt_22_...` after insert, `refund_attempt_09b_...` at `authorized` to `dispatching`). It refuses
   (`23514`, `refund_attempt_prior_may_still_pay`) while any other attempt of the same capture may still pay, or, for an ordinary attempt,
   any other ordinary attempt of the payment. The two one-effective indexes still answer first for an effective attempt, unchanged.
6. **The last capture.** R6H-5 lets a second capture of the settling attempt be refunded only while another stays unrefunded. It used to
   count a capture whose refund attempt had failed as unrefunded. A failed attempt that may still pay no longer counts
   (`refund_attempt_last_capture_may_still_pay`).
7. **OD-DR1-1.** An attempt with its own verified refund fact never moves to `failed` (`refund_attempt_failed_after_refund_fact`).

**Application layer** (`RefundFinalityService`). It decides the same question a second time against the code registry and the adapter's
declaration (`failureFinalityOf`). An attempt is out of the way only if both layers say so.
- It also treats R3's `notification_pending` and `unknown` evidence states as not final.
- It runs at admission (refused as the existing `refund_in_progress`), at the dispatch, and before every same-key resend.
- A blocked `authorized` attempt stays `authorized`. Nothing is sent, released or reassigned, and it is re-evaluated later.
- The R6H-5 capture read reports such money as `in_progress`, so Billing does not open a case Payment would refuse.

**Lock order (always this order, all transaction-scoped):**
1. the payment's refund-dispatch advisory lock (dispatch only, `0032`);
2. the payment row;
3. the attempt row;
4. the capability advisory lock, last: shared for finality inserts, attempt inserts and dispatches; exclusive for writers of the two
   mirror tables.

A mirror writer takes no payment or attempt lock, so there is no cycle. A revocation transaction must do nothing else. Each guard reads
after its locks, in a new READ COMMITTED snapshot, and judges validity at `clock_timestamp()`. Any other isolation level is refused
(`refund_finality_isolation`).

| Race | Outcome |
| --- | --- |
| Revocation first, then a replacement insert or a dispatch | It waits, then is refused. |
| Replacement insert first, then a revocation | The revocation waits. The attempt is then refused at its dispatch. |
| Dispatch first, then a revocation | The revocation waits for `dispatching` to commit. The send is not recalled, and any resend is withheld. |
| Revocation first, then a failure being recorded | The failure is kept without finality. |
| Failure report and success report | The fact's foreign key takes KEY SHARE on the attempt row; the move to `failed` takes FOR UPDATE, so it sees the fact. |

**Boundary.** The database decides before `dispatching` commits, and the provider is called after that. A revocation that commits later
cannot recall the call. Money that the provider has not reported to Payment is visible to no rule.

**Supersession (explicit).** None is implied. Evidence belongs to the exact version it was recorded under and is never re-read under
another. A newer version neither ends nor rescues nor widens it. Ending it takes a revocation of that version, in the database and in
code. The adapter must still declare the same certificate id, so withdrawing the declaration also refuses.

**Privileges.** The migrator owns the tables and functions. The runtime role has SELECT on the two mirror tables, and SELECT and INSERT on
the finality table; every other privilege is revoked. All functions are SECURITY INVOKER with `search_path = pg_catalog, public, pg_temp`.
The runtime role is trusted for what the provider answered, as for every provider fact, but never for what a certificate says. An owner
or superuser who can disable a trigger can bypass these rules.

**Case coverage:**

| Case | Behaviour |
| --- | --- |
| Uncertified `failed` (every historical row; any real provider) | Blocks for ever. No elapsed time, receipt or status read releases it (Q2). |
| Certified simulation failure, declared and in force | The existing, separately authorized replacement is permitted (a fresh Owner receipt is still needed). |
| Expired, revoked, changed or withdrawn certificate | Blocks again at the next insert, dispatch or resend. The evidence row stays. |
| Success, then failure | Success and fact stand. The failure is kept (Q4). Never `failed`, and its key is not sent again. |
| Failure, then late success | Both are kept (S6b, RLSC-1, D-R3, unchanged). The late fact makes the attempt not final. |
| Exception path | None (OD-DR1-5 NO-GO). |

**Limits, recorded:**
- OD-DR1-6: closed for development and simulation by D-R1D (§4b): the dispatch answer is stored before its decision. A database outage between
  the provider call and that write still leaves an UNKNOWN outcome (inherent: the call is not atomic with the database).
- An `authorized` replacement blocked at its dispatch is visible in the logs (`refund_dispatch_blocked`) and as an `authorized` attempt.
  It has no escalation kind of its own.
- An in-flight attempt with its own fact whose success report never arrives again stays in flight, escalated and blocking.
- Billing's own reading of a `failed` attempt as dead (S0-C14, R3) is unchanged; R3-F2 stays OPEN.

**Tests:** `test/dr1b-replacement-guard.e2e-spec.ts` (two instances as the runtime role), `refund-capabilities.spec.ts`,
`db/tests/invariants.sql`, and the `0037` history section of `db/tests/run.sh`. Suites whose scenarios replace a failed attempt declare
the simulation's modelled finality explicitly.

## 4a. D-R1C: the dispatch-blocked escalation (implemented, development and simulation only)

The Owner's GO of 2026-11-24 (Q5, Q6), migration `0038`. ESCALATION ONLY. Nothing is sent, released, certified or reallocated, and no replacement,
finality, allocation, case or hold rule changes.

- **When:** the refund worker's dispatch transaction refuses an `authorized`, not held, attempt under D-R1B
  (`RefundFinalityService.dispatchRefusal`). In that SAME transaction it writes one `dispatch_blocked` `refund_safety_escalation` per attempt and
  cause, with its `refund_safety.escalated` audit intent. That transaction calls no provider, so a failure rolls everything back: the attempt stays
  `authorized` (the refusal stands) and the next pass decides and escalates again.
- **Causes** (`blockingCause`), each the exact D-R1B decision path; the blocker is in `competingAttemptId`, with its status:

| Cause | `causeBasis` | D-R1B path | What the database checks |
| --- | --- | --- | --- |
| `prior_may_still_pay` | `database_verified` | `0037`'s refusal is the prior check | It recomputes the refusal (exactly this cause) and that the blocker, in scope, may still pay |
| `last_capture_may_still_pay` | `database_verified` | `0037`'s refusal is the last-capture check | Same, for a failed attempt on a sibling capture of the settling attempt |
| `prior_registry_not_final` | `producer_derived` | the code registry no longer certifies the blocker's finality | Scope only, and that the blocker is `failed` |
| `last_capture_registry_not_final` | `producer_derived` | the same, on the sibling capture | Scope only, and `failed` |
| `prior_evidence_unresolved` | `producer_derived` | R3 evidence under the blocker is `notification_pending` or `unknown` | Scope only, and `failed` |
| `last_capture_evidence_unresolved` | `producer_derived` | the same, on the sibling capture | Scope only, and `failed` |

  A `producer_derived` row is the Payment worker's own decision: the database cannot recompute it, and the row permits nothing. `blockingReason` is
  the producer's bounded reason code.
- **Derived, never taken from the caller:** payment, Company, capture, both statuses and `causeBasis`.
- **Lock order:** the dispatch lock, payment, attempt (the caller), then the capability lock shared (the guard), as in `0037`.
- **Exit:** the existing exit table and `refund_safety.state_exited`, once, when the attempt is no longer `authorized` (observed by the existing sweep).
  An exit is an observation only: never provider finality, settlement, financial resolution or release.
- **Visibility:** the Owner-only PAY-12 `refund_safety_escalation` item adds `blockingCause`, `causeBasis`, `blockingReason` and `exit`.
- **Audit:** one more value of the existing `kind` field of `refund_safety.escalated` and `refund_safety.state_exited` (same version). No new action
  or field; the topic grants are unchanged.
- **Unchanged:** a held attempt (DO-76) is never escalated this way; a dispatch D-R1B permits writes nothing.

## 4b. D-R1D: durable dispatch responses (implemented, development and simulation only)

The Owner's conditional GO of 2026-11-28 (OD-DR1-6; Q1, Q2 of 2026-11-24), migration `0039`. EVIDENCE ONLY: no new send, no replacement
eligibility, no finality rule, no release, no allocation change. Three append-only tables; the runtime role may insert and read them, nothing else.

| Table | Written | Holds | Never |
| --- | --- | --- | --- |
| `refund_dispatch_send` | before each provider call: in the `authorized` -> `dispatching` transaction (`first_send`, once), or before a same-key resend the existing D-R1A rule permits (`same_key_resend`, while `dispatching` or `unknown`) | the attempt, its own payment, provider and key (checked), a derived send number and database time | proof that the provider received the call |
| `refund_dispatch_observation` | after the call, in its OWN transaction, before any decision (bounded retries with the same send) | one per send: `accepted` (with the provider reference), `rejected` (with the bounded code), `ambiguous` or `transport_error` (the call threw); a derived digest and database time | overwritten: a repeat of the same answer is idempotent; a different answer for the same send is logged and the stored one kept |
| `refund_dispatch_application` | in the deciding transaction, under the payment and attempt locks | once per observation: `transitioned` (to the status the classification names), `preserved_contradiction` (D-R1A) or `no_effect`; the statuses before and after (after checked); `appliedBy` | written twice (primary key) |

- **Decision:** exactly the approved dispatch logic (accepted -> `submitted`; rejected -> D-R1A preservation, OD-DR1-1, else `failed`;
  ambiguous or transport error -> `unknown` while `dispatching`), now applied to the STORED answer, with its application row.
- **Finality (Q1):** a new `dispatch_response` finality must name the attempt's own `rejected` observation with the same code, and at commit that
  observation must have been applied by the dispatch as the transition to `failed`. 0037's certificate, fingerprint, revocation and evidence rules
  are unchanged and still apply. Existing finality rows keep a NULL observation (no backfill).
- **Recovery** (since D-R1E the separate recovery process, below): each pass applies stored answers no transaction applied, once they are older than
  `PAYMENT_REFUND_RESPONSE_RECOVERY_AFTER_MS` (default 30 s; 1 s to 1 h): the same decision with `appliedBy = recovery`, WITHOUT calling the
  provider and WITHOUT recording finality (a recovered rejection is an uncertified failure, which D-R1B treats as possibly payable). Two instances
  apply it once (attempt lock, primary key). While an attempt has a stored answer not yet applied, it is not worked at all (no resend, no status
  read) until that answer is applied.
- **Owner visibility** (PAY-12, Owner only, Company-scoped through the payment; read-only), after `PAYMENT_REFUND_RESPONSE_ITEM_AFTER_MINUTES`
  (default 15; 1 to 1440): `refund_dispatch_send_unobserved` (a send with no stored answer: outcome UNKNOWN; the attempt's current status beside it;
  never inferred from it) and `refund_dispatch_response_unapplied` (a stored answer not yet applied). Neither window establishes provider finality
  or authorizes another dispatch (Q2).
- **The external-call boundary (limit, recorded):** the provider call is not atomic with the database. A crash or database outage after the call and
  before the observation commits leaves a send with no answer: UNKNOWN, Owner-visible, resolved only by the existing status reads (and, where D-R1A
  permits, the same-key resend). The in-memory answer survives only in the `refund_dispatch_response_unrecorded` error log.
- **Recovery authority (D-R1E, `0040`, the A1 correction):** under 0039 alone `appliedBy` was the worker's label, and a recovery mislabelled
  `dispatch` recorded certified finality (reproduced on main e03295e). Since `0040` recovery is a SEPARATE process
  (`npm run refund-recovery`, `cli/refund-response-recovery.ts`) connected ONLY as the separate recovery role (`payment_refund_recovery`), which
  has no INSERT on `refund_attempt_failure_finality`, `refund_dispatch_send` or `refund_dispatch_observation`. The database DERIVES `appliedBy`
  from the connected role's authority (`dispatch` only for a role that can record finality) and refuses a different value or a switched role.
  `payment_grant_refund_recovery(role)` refuses any role with that authority (column-level grants included), the schema owner, a superuser and any
  member of another role, and REGISTERS the role (`refund_recovery_role`, owner-written, append-only). A registered recovery role, as the current or
  the session role, is refused every insert into the finality (any source), send and answer tables and is always `recovery`, whatever it is granted
  later: its identity decides, not its privileges (Codex round 1, P1 and P2). No SECURITY DEFINER function exists.
  What a recovery session may write is bound to stored evidence (migration `0041`; the Owner's F1-F6 GO of 2026-11-28, after PR #553 merged `0040`):
  - **F2:** an attempt changes only by a status transition, with that transition's own columns at database time, matched at commit by its own
    recovery application of a stored answer of that attempt, provider and key (failure code and provider reference included).
  - **F3, both roles:** an application's effect must be the one the approved decision gives. A false `no_effect` cannot hide an applicable
    answer, and `preserved_contradiction` needs the attempt's own verified refund fact and its D-R1A row.
  - **F1:** its outbox rows are only the two audit intents of its decision (`audit.refund_attempt.failed`, `audit.refund_safety.escalated`). Each is
    byte-exact to the payload the database derives from the stored rows, unpublished, at database time, one per resource per transaction, and its
    decision must commit with it. No other event is accepted, never `payment.succeeded` or `refund.case_completed`. The deterministic event id is
    not recomputed: core PostgreSQL has no SHA-1.
  - **F4:** it never updates a payment and never writes `workAfter`.
  - **Ownership and both directions (Codex round 3):**
    - "This transaction" is proven by the row's own `xmin`, never by a time comparison.
    - A recovered failure must write its audit intent, and a new D-R1A escalation must write its own, with the stored answer's code.
    - A `transitioned` application needs the attempt row updated by the same transaction; this holds for both roles.
    - Whatever a recovery session is granted later, it never updates, deletes or truncates an outbox row.
  - **Codex review of b954a3e (PR #554):**
    - Every row a recovery session writes must belong to the top-level transaction, so a savepoint cannot hide a duplicate.
    - A login that switched INTO a recovery role writes nothing; the refusal is at write time, so `RESET ROLE` before commit gains nothing.
    - A `transitioned` application must name a real status change of the same transaction, with the same from and to. The change is recorded by
      trigger in the append-only `refund_attempt_status_change`, which nothing else may write. This holds for both roles.
  - Operations: [`docs/runbooks/refund-response-recovery.md`](../runbooks/refund-response-recovery.md). The recovery process refuses to start as such a role. The Payment service no longer runs recovery.
  Remaining trust: the runtime role (the service that made the provider call) keeps the authority D-R1B gave it.

| Crash point | Durable state | Result |
| --- | --- | --- |
| Before the send commits | nothing | not sent; the next pass sends once |
| After the send, before the call | send, no answer | UNKNOWN item; existing status read or certified same-key resend |
| After the call, before the answer commits | send, no answer | UNKNOWN (the boundary above) |
| After the answer, before its application | answer | nothing else happens to the attempt; recovery applies it once, no provider call |
| The decision transaction fails | answer | recovery applies it (C9 is now a positive test) |
| Two instances recover | answer | applied once |
| A verified success races the answer | fact and answer | `preserved_contradiction` (D-R1A); the success stands |
| Two sends, different answers | two answers | both kept, applied in order |

**Tests:** `test/dr1d-durable-dispatch-responses.e2e-spec.ts` (two instances as the runtime role), the rewritten C9 of
`test/dr1a-refund-capabilities.e2e-spec.ts`, and the `0039` history section of `db/tests/run.sh`.

## 5. Provider certification requirements (Q3)

A `provider`-scope certificate is added only by a reviewed PR that the Owner merges, with:
1. a documentary provider guarantee for the exact capability, quoted with its version and date;
2. a verified adapter mapping: the adapter code and its contract tests mapping each provider answer to Payment's result;
3. the Owner's explicit authorization, recorded in the certificate;
4. a version, an expiry and a fingerprint. Any change is a new version.

None exists. Simulation behaviour is never evidence for a real provider.

## 6. Owner decisions (2026-11-24)

- **OD-DR1-1:** GO, implemented in D-R1B. An attempt with its own verified refund fact never becomes `failed`.
- **OD-DR1-2:** approved. The simulation contract certificate models unbounded key retention, in simulation only.
- **OD-DR1-3:** approved direction, implemented. Expiry and revocation end what evidence permits; the evidence itself is never changed.
- **OD-DR1-4:** approved for a bounded development-only D-R1B, including the permanent blocking of historical `failed` rows.
- **OD-DR1-5:** NO-GO. No exception path exists and none is designed.
- **OD-DR1-6:** conditional GO of 2026-11-28 for one development-only PR, implemented as D-R1D (migration `0039`, §4b), merged as e03295e. Its
  acceptance stays PENDING until the A1 correction (D-R1E: `0040` merged in #553; `0041`, F1-F6) is reviewed and integrated. Recovery never records finality (Q1); the 30 s and 15 min windows are configurable technical defaults that authorize nothing (Q2).
