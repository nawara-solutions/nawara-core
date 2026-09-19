# payment-service: payment attempts, the test provider, and the resolver

- **Status:** Implemented
- **Author:** Claude (Phase 1 implementation session), reviewed against the SDD by the project owner
- **Related SDD:** [payment-service.md](../sdd/payment-service.md)
- **Related ADRs:** [0033](../adr/0033-service-to-service-authentication-and-user-identity.md), [0034](../adr/0034-shared-service-kit-and-api-conventions.md)
- **Ticket/issue:** Payment Service Phase 1, steps 7–9, 13 (attempts, test provider, unknown/timeout handling)

## Problem

A payment (previous TDD) has no way to actually collect money yet. This adds the gateway attempt
lifecycle: starting an attempt against a provider, syncing its status, a deterministic test provider
to exercise every path without a real gateway, and a background resolver so a payment can never stay
`pending` forever because nobody happened to call sync.

## Approach

- `providers/provider.port.ts`: the provider port (SDD section 13.1) — `initiate`, `fetchStatus`,
  `verifyWebhook`. Refund methods are **deliberately absent**: refunds are not implemented (O-6), so a
  port member for them would be dead code nothing can reach.
- `providers/test-provider.ts`: in-process, deterministic, keyed by `merchantReference` (no network).
  Implements the scenarios reachable without a webhook endpoint yet — `success`, `failure`, `retry`,
  `timeout_before_accept`, `timeout_after_accept` — plus `verifyWebhook` and signing helpers
  (`signSuccessCallback`/`signFailureCallback`) that the next TDD's webhook endpoint will drive.
  `duplicate_callback`/`delayed_callback`/`out_of_order` are properties of how a test **delivers**
  webhook calls, not of the provider itself, and will be exercised end to end once that endpoint exists.
- `attempts/attempt.service.ts`:
  - `start()`: **T1** (lock payment, validate `created` and not expired, reserve the idempotency key,
    insert the attempt, move the payment to `pending`, commit) → the provider call **outside any
    transaction** → **T2** (record `submitted`/`unknown`/`failed`). Exactly the SDD's section 12.2 flow.
    `payment.status === 'pending'` gets its own error (`payment_has_open_attempt`), not the generic
    `payment_not_payable` — in this phase `pending` only ever means an open gateway attempt (no cash).
  - `applyStatus()`: shared by `sync` and the resolver. Enforces FI-13 (provider amount/currency must
    match the snapshot or the result is refused, not applied), the late-success rule (an
    **inferred** failure can still succeed later; a **provider-confirmed** failure conflicts), and
    settles the payment (attempt limit or a `paymentFatalCodes` match ends it as `failed`; otherwise
    it returns to `created` for a retry).
- `attempts/attempt-resolver.ts`: settles `initiated` (once past `timeoutMs + visibilityLagMs`),
  `unknown`, and long-`submitted` (5 minutes) attempts by asking the provider and reusing
  `applyStatus` — the exact same rules `sync` uses, so there is only one place that decides whether a
  transition is valid. Same shape as the kit's `OutboxRelay` (an interval, not a cron dependency) —
  `AttemptResolverService` starts/stops it with the app.
- `idempotency/idempotency.service.ts`: generic `reserve()` for header-based idempotency, used here for
  `start_attempt` (natural-key idempotency was covered in the payment-creation TDD).
- Module graph fix, generic: `PaymentsModule` now exports `PaymentService`/`AuthorizationService`
  instead of `AttemptsModule` re-declaring its own separate instances; a new local `AuthModule`
  provides `ServiceOrUserGuard` once instead of duplicating it per feature module.

## Files/components affected

- `apps/payment-service/src/providers/*` (port, test provider, registry, module)
- `apps/payment-service/src/attempts/*` (state machine, types, service, resolver, controller, module, DTO)
- `apps/payment-service/src/idempotency/idempotency.service.ts`
- `apps/payment-service/src/auth/auth.module.ts` (new, shared `ServiceOrUserGuard` provider)
- `apps/payment-service/src/payments/payments.module.ts` (now exports its services)

## Edge cases

- `timeout_before_accept` (ambiguous, provider never recorded it) → attempt `unknown` → `sync`/resolver
  asks the provider → `notFound` → inferred failure (`failureInferred: true`).
- `timeout_after_accept` (ambiguous from our side, provider DID record it) → attempt `unknown` →
  `sync`/resolver asks the provider → `succeeded`, and the payment settles.
- A second attempt while one is open → `409 payment_has_open_attempt` (proven under an 8-way HTTP race
  in the previous TDD's style, here as a 2-way race).
- Same Idempotency-Key, same body → replay (the attempt's current state, original `201`). Same key,
  different body → `422 idempotency_key_reused`.
- Attempt limit reached (`PAYMENT_MAX_ATTEMPTS`) → payment ends `failed`; below it → payment returns to
  `created` and a genuinely new attempt can start.
- An unconfigured/disabled provider → `422 invalid_provider`, never a silent fallback.
- The resolver never touches a fresh `submitted` attempt (younger than the long-submitted threshold) or
  an `initiated` attempt still within the provider's normal response window — proven directly.
- Running the resolver twice in a row is a no-op the second time (idempotent).

## Data migration

N/A.

## Test plan

- Unit: `attempts/attempt-state-machine.spec.ts` (exhaustive, all transitions), `providers/test-provider.spec.ts` (every scenario, signature verification including a tampered body and a valid-signature-but-malformed-body case).
- Integration/E2E: `test/attempts.e2e-spec.ts` (12 cases: idempotency-key validation, success, replay,
  idempotency-key-reused, failure below/at the limit, open-attempt conflict, both unknown/timeout
  scenarios via sync, invalid provider, collapsed 404, a 2-way concurrent-start race), and
  `test/attempt-resolver.e2e-spec.ts` (settles a stuck attempt with no client action, leaves a healthy
  one alone, and is idempotent across two runs).

## Rollout

No feature flag. `PAYMENT_TEST_PROVIDER` already gates the test provider (refused in production, per
the foundation TDD); no real gateway exists yet, so nothing in production can actually collect money
through this code path.
