# payment-service: webhooks, the expiry sweeper, and the event catalog

- **Status:** Implemented
- **Author:** Claude (Phase 1 implementation session), reviewed against the SDD by the project owner
- **Related SDD:** [payment-service.md](../sdd/payment-service.md)
- **Related ADRs:** [0037](../adr/0037-reliable-events-outbox-inbox.md)
- **Ticket/issue:** Payment Service Phase 1, steps 10, 11 (webhook infrastructure, outbox events) plus the expiry sweeper (section 12)

## Problem

A payment can now be created, attempted, and synced (previous TDDs), but nothing lets a provider tell
payment-service about an outcome asynchronously, and nothing closes out a payment whose window has
passed. This adds the webhook pipeline (SDD section 7), a retrier for stuck deliveries, and the
expiry sweeper — the last pieces of section 12's background-job list for Phase 1.

## Approach

- `db/migrations/0005_webhook_event.sql`: the `webhook_event` table (SDD section 4.6) — durable,
  deduplicated by `(provider, providerEventId)`, immutable received-fact columns.
- `providers/provider.port.ts`: `verifyWebhook` now returns a `signatureValid`/`parsed` discriminated
  union that keeps the SDD's two distinct failure modes separate — a bad signature (401, nothing
  persisted) versus a valid signature over an undecodable body (persist as `failed`, never a 401). A
  new `parseStoredBody` method re-derives the parsed shape from bytes already verified once, for the
  retrier (which must never re-authenticate a stored, unchanged body).
- `webhooks/webhook.service.ts`: verify → **transaction A** (deduplicated insert; a conflicting row
  already at a terminal outcome is a no-op, one left mid-flight is reprocessed) → **transaction B**
  (find the attempt by `providerTransactionId`/id, apply via `AttemptService.applyStatus` — the same
  transition rules `sync` and the resolver already use). A conflict from `applyStatus` (FI-13 mismatch,
  or a provider-confirmed failure vs. a late success) is recorded as `webhook_event.state = 'conflict'`
  and answered `200`, never surfaced as an HTTP error to the provider — SDD section 5.1's documented
  safety net, not a new state.
- `webhooks/webhook-retrier.ts`: same interval-job shape as `AttemptResolver`. Reprocesses events stuck
  in `received`/`processing`/`failed`/`unmatched` past a threshold, using `parseStoredBody` (no
  re-verification).
- `payments/expiry-sweeper.ts`: sweeps payments with `expiresAt` set and passed, refusing while an
  attempt is still open (money in flight must be resolved first — the resolver's job). A payment
  without `expiresAt` is never touched (O-16 stays undecided).
- **Two real bugs found and fixed by writing the invariant tests this stage's brief required**, not by
  inspection:
  1. **Lock order.** `AttemptService.applyStatus` locked `payment_attempt` before `payment` — backwards
     from SDD section 12's fixed order ("the payment row first, then its attempt... the webhook
     processor follows the same order"). Harmless today (no other path locked the opposite way yet) but
     a live deadlock risk the moment two of `sync`/resolver/webhook race on the same pair. Fixed to:
     find the attempt without locking (to learn its `paymentId`), lock the payment, then lock the
     attempt. The `rejected`-initiate branch in `start()` had the same issue and got the same fix.
  2. **Missing transition.** SDD section 5.1's "late success" text ("the attempt moves to succeeded
     and, if the payment is not terminal, the payment moves to succeeded") implies a payment can move
     `created -> succeeded` directly, once an inferred failure has already returned it to `created`
     below the attempt limit — but neither the `payment_status_transition_guard` trigger nor the
     `payment_attempt` trigger's `failed -> succeeded` case allowed it. Added `('created','succeeded')`
     to the payment trigger and a `failureInferred`-conditioned `failed -> succeeded` case to the
     attempt trigger (never for a provider-confirmed failure — that stays a real conflict). Both pure
     TypeScript mirrors (`payment-state-machine.ts`, `attempt-state-machine.ts`) and their exhaustive
     tests were updated to match.

## Files/components affected

- `apps/payment-service/db/migrations/0005_webhook_event.sql`, `0002_payment.sql` and
  `0003_payment_attempt.sql` (transition-guard fixes, above)
- `apps/payment-service/src/webhooks/*` (types, service, retrier, controller, module)
- `apps/payment-service/src/providers/provider.port.ts`, `test-provider.ts` (`parseStoredBody`,
  `success_amount_mismatch` scenario)
- `apps/payment-service/src/attempts/attempt.service.ts` (lock-order fix)
- `apps/payment-service/src/payments/{payment-state-machine.ts,expiry-sweeper.ts,payments.module.ts}`
- `apps/payment-service/db/tests/invariants.sql` (updated for the new transition)

## Edge cases

- Invalid signature → `401`, nothing persisted.
- Same signed event delivered 3 times → one `webhook_event` row, one `payment.succeeded` outbox row —
  no second financial side effect.
- Unknown provider → `404`.
- Malformed body under a valid signature → `200`, `state = 'failed'`, `outcome = 'malformed_body'` (the
  provider stops retrying something that will never parse differently).
- A signed event for a reference nothing matches → `200`, `state = 'unmatched'`.
- A provider-confirmed failure later gets a genuine success callback for the same reference → `200`,
  `state = 'conflict'`, the attempt stays `failed` — never silently applied.
- A crash between transactions A and B (simulated by inserting a `received` row directly) → the retrier
  reprocesses it to `processed` without re-verifying the signature.
- A payment with an open attempt past its `expiresAt` → left alone (`pending`) until the attempt
  resolves; one with no `expiresAt` is never swept; sweeping twice does not re-emit `payment.expired`.

## Data migration

N/A — greenfield table.

## Test plan

- Unit: `providers/test-provider.spec.ts` (signature verification, tampered body, malformed-but-signed,
  the new `success_amount_mismatch` fixture scenario), `payments/payment-state-machine.spec.ts` and
  `attempts/attempt-state-machine.spec.ts` (updated exhaustive transition coverage including the new
  late-success edges).
- Integration/E2E: `test/webhooks.e2e-spec.ts` (8 cases: success, invalid signature, triple-duplicate
  idempotency, unknown provider, malformed body, unmatched, conflict, retrier recovery from a simulated
  crash), `test/expiry-sweeper.e2e-spec.ts` (4 cases), and `test/attempt-invariants.e2e-spec.ts` (FI-13
  mismatch refused; late success accepted after an inferred failure; late success rejected after a
  provider-confirmed one) — the tests that found the two bugs above.
- Database: `db/tests/run.sh` re-verified after the transition-guard changes (30 assertions, 2
  concurrency races, all passing).

## Rollout

No feature flag. The webhook route is public (signature-authenticated only, per SDD section 7) but only
the test provider is registered in any environment (`PAYMENT_TEST_PROVIDER`, refused in production), so
no real traffic can reach it yet.
