# payment-service: Phase 1 acceptance-review fixes

- **Status:** Implemented
- **Author:** Claude (Phase 1 acceptance review), for the project owner
- **Related SDD:** [payment-service.md](../sdd/payment-service.md) (sections 4.10, 5.1, 5.2, 7, 11, 12, 16)
- **Related TDDs:** [payment-attempts-and-provider](./payment-attempts-and-provider.md), [payment-webhooks-and-events](./payment-webhooks-and-events.md)
- **Ticket/issue:** Payment Phase 1 acceptance gate. Fixes only; no feature was added and no `[B]` decision was made.

## Problem

An adversarial review of `feat/payment-service-phase1-foundation` (tests written against a real PostgreSQL before any fix)
found defects the 92 green tests did not cover. The ones with financial or contractual impact:

1. **A second success was applied silently.** After a late success on attempt A while attempt B was open, a later success
   on B was marked `succeeded` too: two succeeded attempts on one payment (FI-03/FI-06), no conflict, no event, no alert.
2. **A late success into a payment that had already ended `failed`/`cancelled`/`expired`** hit the database trigger,
   surfaced as a 500, and was retried by the provider and the retrier forever, instead of being recorded as the SDD's
   `conflict`.
3. **A stuck `initiated` attempt could never be settled** (`initiated -> succeeded` does not exist), and because the
   resolver did not isolate failures, that one attempt aborted every pass and blocked all the attempts behind it.
4. **T2 of "start attempt" was an unconditional update** without the payment lock, contradicting SDD section 12.
5. **Events did not match SDD section 11:** no `paymentRequestId`/`sourceId`/parties/`status`/`revision`/`actor`/`cause` on
   `payment.succeeded`/`failed`/`expired`; `revision` was never incremented; system events had no correlation id.
6. **The rate limiter was not attached to any route**, though SDD section 16 requires it on creation and attempts.
7. Smaller: webhook attempt matching was not scoped to the verifying provider; malformed events were retried forever;
   `refundableAmount` claimed a full amount was refundable while refunds are blocked by O-6; organization sellers
   with a non-UUID id, and an `expiresAt` such as `2026-13-45T00:00:00Z`, produced 500s; `db/tests/run.sh` leaked its scratch
   databases.

## Approach

- **Migration `0006_phase1_acceptance_hardening.sql`** (new file; 0001-0005 untouched so migrated databases upgrade):
  unique index for one succeeded attempt per payment (FI-03); `succeeded` requires a settlement method and a gateway
  settlement requires its attempt; `amount <= 9007199254740991`; the organization-seller CHECK no longer passes on a NULL
  `organizationId`; the payment trigger allows `created -> succeeded` only when the named attempt succeeded after an
  **inferred** failure (SDD 5.1's single exception); a `revision`/`updatedAt` trigger.
- **`AttemptService.applyStatus`**: success for a payment that is terminal in any way (including succeeded through
  another attempt) is `409 invalid_state_transition`, which the webhook path records as `conflict`. An `initiated`
  attempt moves through `unknown` first. "No record" no longer fails a `submitted` attempt (SDD 5.2 only allows it from
  `unknown`). Every payment event is built from the `RETURNING *` row.
- **T2** locks the payment, then the attempt, and is conditional on `initiated`/`unknown`; if a webhook or the resolver already
  settled the attempt, that result is returned untouched.
- **`events/payment-events.ts`** (the SDD's `PaymentEvents` component): the common payload, `actor`, `cause`, and a
  correlation id (request id, webhook event id, or a fresh id per job run).
- **Resolver and retrier** isolate failures per item, are batched and ordered, and the retrier no longer replays
  `malformed_body` events. Webhook matching is scoped to the provider whose signature verified.
- **Rate limits** on `POST /payment/payments` (per producer) and `POST .../attempts` (per payer), applied after
  authentication so an unauthenticated caller cannot write limiter rows. Configuration: `PAYMENT_RATE_LIMIT_*`.
- Database time is used for expiry decisions (SDD 12); the raw-body fallback that re-serialised the parsed body is gone.

## Files/components affected

`apps/payment-service/db/migrations/0006_*.sql`, `src/attempts/*`, `src/webhooks/*`, `src/payments/*`,
`src/events/payment-events.ts`, `src/config/payment-config.ts`, `db/tests/*`, `test/review-*.e2e-spec.ts`,
`test/runtime-role.e2e-spec.ts`. No service-kit change.

## Edge cases

- Late success on A while B is open: A settles the payment; B stays open and its own later success is a recorded conflict
  (money moved twice: reconciliation, outside this phase [X]). B is never closed by guess.
- Existing rows keep `revision = 0` (no history to derive it from). Phase 1 has never carried real traffic.
- Not fixed, by decision: the webhook route has no limiter (a database-backed limiter on an unauthenticated route lets an
  anonymous caller write rows; SDD 4.6 forbids that. It belongs at the gateway or needs an in-memory limiter: owner decision).

## Data migration

`0006` is additive except for three `CHECK`s that validate existing rows; verified against a database populated through
0005 (including succeeded gateway payments).

## Test plan

`test/review-adversarial.e2e-spec.ts` (27 cases: late success, conflicts, initiated resolution, lock order proof,
FI-16 rollback with a failing outbox, event payloads), `test/review-matrix.e2e-spec.ts` (20: TypeScript-vs-trigger transition
agreement over every pair, idempotency scope, authorization, rate limits, no client-asserted success),
`test/runtime-role.e2e-spec.ts` (the service as a non-owner DML-only role), 17 more assertions in `db/tests/invariants.sql`.

## Rollout

None beyond the migration; nothing here is reachable by real traffic (test provider only).
