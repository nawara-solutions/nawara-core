# Core V2 D-R1: fail-closed refund finality

Status: **D-R1A implemented for development and simulation only (pending the Owner's merge review). D-R1B is a design awaiting the
Owner's approval of its database and migration contract; nothing in it is implemented.** DO-76 and OD-RLSC-1 stay OPEN. No real provider
is certified; no provider is activated; nothing here is a production change.

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
   (`RefundFailureFinalityRecord`, D-R1B). Every existing `failed` row has no such record, so it is never final
   (`failureFinalityOf(null)` gives `no_finality_record`). Certification is never applied retroactively to history.
4. **Failed-attempt transitions** (unchanged in D-R1A):
   - a definitive dispatch refusal (`RefundWorker.dispatch`, `rejected`) gives `failed`;
   - a provider-confirmed failure of an in-flight attempt (`RefundEvidenceService.applyStatus`) gives `failed`;
   - a verified success of a `failed` attempt gives `discrepancy`, or the RLSC-1 escalation while another attempt is effective.
5. **Effective-attempt unique indexes** (`0017`, `0022`) count every status except `authorization_expired`, `authorization_refused` and
   `failed`. D-R1B must make an uncertified `failed` attempt count as potentially effective for new attempts (§4). The indexes
   themselves cannot do that, because a `failed` attempt that later becomes `discrepancy` must stay representable.
6. **Capture-level evidence guard.** `refund_capture_has_evidence` (`0022`) refuses a new attempt or dispatch once the capture has refund
   evidence. It does not see an attempt that may still pay but has no evidence yet. D-R1B closes exactly that gap.
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

**Not changed:** replacement eligibility, allocation, case completion, held dispatches, the first send, and every approved state
transition. D-R1A does **not** solve double refunds: `test/dr1a-refund-capabilities.e2e-spec.ts` E1 pins that a replacement is still
authorized after an uncertified failure.

**Capability model (Q1, Q3)** in `refund-capabilities.ts`:

| Capability | Grant | Used in D-R1A |
| --- | --- | --- |
| `terminalFailureFinality` | `observations` (`dispatch_rejected`, `provider_failed`) | No (D-R1B) |
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

**Visibility:** both kinds appear in the Owner-only PAY-12 `refund_safety_escalation`. The detail carries `observedFailureCode` or
`authorizedAt`.

**Database guard (`0036`):**
- Two branches are added to the escalation insert guard; its four existing branches are textually unchanged.
- The existing kinds keep their shapes. `observedFailureCode` belongs to `failure_after_refund_evidence` only, and `factId` is null
  exactly for `dispatch_stalled` and `idempotency_retention_unproven`.
- The escalation table stays append-only. No row is rewritten and nothing is backfilled.

## 4. D-R1B: the replacement guard (design only; needs the Owner's approval of this database contract)

**Invariant.** A new refund attempt for a capture must not be inserted, and a new dispatch must not start, while any earlier attempt
for that capture could still move provider funds enough to cause an unauthorized excess.

**Schema (proposed migration `0037`):**
1. Table `refund_attempt_failure_finality`, append-only, at most one row per attempt. It holds `refundAttemptId` (PK, FK), `certificateId`,
   `certificateVersion`, `fingerprint`, `observation` (`dispatch_rejected`, `provider_failed`), `failureCode` and `recordedAt` (database
   time). It is written in the same transaction as the move to `failed`, and only when `evaluateRefundCapability(...,
   'terminalFailureFinality')` certifies that observation. Its guard requires the attempt to be `failed` in that transaction.
2. Table `refund_capability_revocation`, append-only (`certificateId`, `certificateVersion`, `revokedAt`, `reason`). It mirrors the code
   revocations so that the database guard can apply them without the application. Rows are written by a migration or an Owner-run
   operation, never by the runtime role.
3. Function `refund_attempt_may_still_pay(a refund_attempt)`. It returns true unless the status is `authorization_expired` or
   `authorization_refused`, or the attempt is `failed` with a finality row whose certificate is not revoked. Evaluating expiry in the
   database needs the certificate's `expiresAt` in the row (an added column). OD-DR1-3 decides whether expiry is retroactive.
4. An extension of the existing insert guard on `refund_attempt` (`0022` and `0017`), under the payment row lock that every insert
   already takes. Insertion is refused (`23514`, `refund_attempt_prior_may_still_pay`) when another attempt of the same capture, or of
   the same payment for an ordinary refund, satisfies `refund_attempt_may_still_pay`. The one-effective indexes are unchanged and remain
   the uniqueness backstop.
5. The 0032 dispatch rule gains the same check at `authorized` to `dispatching`, under the refund-dispatch lock. This covers an attempt
   inserted before `0037`.

**Case coverage:**

| Case | Behaviour |
| --- | --- |
| Uncertified `failed` (every historical row; any real provider) | Blocks replacement for ever. No cooling window, elapsed time, receipt or status read releases it (Q2). |
| `unknown`, in flight, `dispatching` | Already blocks today. Unchanged. |
| Late success on any attempt | Unchanged: discrepancy, RLSC-1 or D-R3 evidence. Nothing is reallocated. |
| Status and webhook conflict | Preserved (D-R1A Q4). Never resolves finality. |
| Two-worker or two-request race | The guard runs inside the insert trigger under the payment row lock, so one wins and the other is refused. |
| Restart | The finality row commits with the `failed` transition, or not at all. |
| Historical `failed` rows | No finality row, so they block. Old payments can no longer be replaced: a deliberate fail-closed effect. |
| Capability removal or revocation | A revocation row makes every finality row of that certificate non-final, so it blocks again. A removed declaration only stops new rows. |
| Capture-level and payment-level uniqueness | Guarded on capture (`captureFactId`) and on payment for ordinary refunds, mirroring the two indexes. |
| Idempotency boundary | The key is the attempt id; a replacement always has a new key. It is allowed only after certified finality of the previous key. |
| Explicit exception path | None automatic. An Owner-reviewed exception would be a separate, audited, receipt-bound operation (a later decision; not designed here). |

**Tests D-R1B must carry:**
- **Non-certified:** the old P5 and P6 reproductions become negative controls. The replacement is refused, no second dispatch
  happens, and the late success is still recorded.
- **Simulation-certified** (`PAYMENT_SIMULATION_REFUND_FAILURE_FINALITY=true`), explicitly labelled: the replacement is allowed after a
  certified dispatch refusal. A later simulated success is a modelled provider-contract violation, preserved as evidence and never
  reallocated.
- **Further cases:** revocation, a changed fingerprint, a two-instance insert race, a restart between the failure and its finality row,
  historical rows applied over migration, and mutation controls for each layer.

**Approved behaviour D-R1B keeps:** every verified provider fact, the allocation arithmetic and the receipt requirements (a replacement
still needs a fresh Owner receipt in addition to certified finality).

## 5. Provider certification requirements (Q3)

A `provider`-scope certificate is added only by a reviewed PR that the Owner merges, with:
1. a documentary provider guarantee for the exact capability, quoted with its version and date;
2. a verified adapter mapping: the adapter code and its contract tests mapping each provider answer to Payment's result;
3. the Owner's explicit authorization, recorded in the certificate;
4. a version, an expiry and a fingerprint. Any change is a new version.

None exists. Simulation behaviour is never evidence for a real provider.

## 6. Open Owner decisions

- **OD-DR1-1:** a provider failure for an in-flight attempt that already has its own verified refund fact. Should the move to `failed`
  be refused, with the attempt left in flight and escalated? D-R1A only preserves the evidence.
- **OD-DR1-2:** ratify the simulation's `simulation-refund-contract` certificate (unbounded key retention), which keeps R6B-4 unchanged
  in simulation.
- **OD-DR1-3:** is certificate expiry retroactive for recorded finality? It is fail-closed (yes) until decided. Revocation is
  retroactive.
- **OD-DR1-4:** approve the D-R1B database contract (§4), including the permanent blocking of historical `failed` rows.
- **OD-DR1-5:** whether any audited exception path for a blocked replacement should exist, and who may use it.
