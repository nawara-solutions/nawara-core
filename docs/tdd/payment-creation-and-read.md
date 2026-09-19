# payment-service: payment creation, read, and authorization foundations

- **Status:** Implemented
- **Author:** Claude (Phase 1 implementation session), reviewed against the SDD by the project owner
- **Related SDD:** [payment-service.md](../sdd/payment-service.md)
- **Related ADRs:** [0033](../adr/0033-service-to-service-authentication-and-user-identity.md), [0035](../adr/0035-financial-service-boundaries.md), [0036](../adr/0036-money-parties-and-source-references.md), [0037](../adr/0037-reliable-events-outbox-inbox.md)
- **Ticket/issue:** Payment Service Phase 1, step 3 (endpoints 1 and 2 of SDD section 9)

## Problem

With the schema in place ([payment-service-foundation](./payment-service-foundation.md)), payment-service
needs its first real domain behavior: accept a payment request from a producer with natural-key
idempotency (SDD section 3.3, 6), and let the producer or the payer read it back, with the collapsed
404 the SDD requires (section 8.2) — without inventing any authorization model still gated by an
unresolved `[B]` decision.

## Approach

- `payments/dto/{party,create-payment}.dto.ts`: the section 3.1 contract, validated with
  `class-validator`, every field decorated for OpenAPI (`@ApiProperty`). Unknown fields are rejected by
  the kit's global `ValidationPipe` (`whitelist`/`forbidNonWhitelisted`).
- `payments/payment-state-machine.ts`: a pure transition table mirroring the database trigger
  (`payment_status_transition_guard`, previous TDD) on purpose — the same rule lives in two places.
- `payments/payment.service.ts`:
  - `create()`: validates the configured currency list and the payer≠seller/organizationId-matches-seller
    contract rules application-side (clearer errors than a bare DB constraint violation), then inserts
    inside `db.tx()` with the outbox `payment.created` write in the same transaction. A duplicate
    `(producer, paymentRequestId)` is **not** a bare try/catch: PostgreSQL aborts the whole transaction
    once a statement errors (`25P02`), so recovering needs a `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` before
    the recovery `SELECT` can run in the same transaction. An identical snapshot replays (200,
    `Idempotent-Replayed: true`); a different one is `409 payment_request_conflict`.
  - `cancel()`: implemented at the service layer (producer-only, no open attempt) for internal
    completeness and so the state machine's `cancelled` transition is exercised — no HTTP route yet
    (not in this phase's endpoint list; flagged to the project owner as a cheap, `[T]`-gated addition
    if wanted, not silently added).
- `authorization/authorization.service.ts`: the **only** place that establishes a caller's relation
  (`producer` | `payer` | none) and applies the read/cancel operation rules of SDD section 8.4. No
  membership-based relation exists yet (payer-organization member, seller-organization member): those
  depend on O-18/O-20, which are not decided.
- `auth/service-or-user.guard.ts` (from the foundation TDD) is reused unchanged for endpoint 2; endpoint
  1 uses `ServiceTokenGuard` alone (producer only).
- `events/deterministic-id.ts`: a hand-rolled RFC 4122 version-5 UUID (Node has no built-in one) derived
  from `(paymentId, eventName)`, so the outbox's `ON CONFLICT (id) DO NOTHING` makes a retried transition
  enqueue its event at most once.
- Two DI fixes needed along the way, generic to any future feature module: `ServiceAuthModule` (kit) and
  the local `AuthClientModule`/`PaymentConfigModule` are marked `@Global()` — a guard applied via
  `@UseGuards()` resolves its dependencies from the *controller's own* module, not the root module, so a
  second feature module would otherwise need to re-import and re-configure each of these individually.

## Files/components affected

- `apps/payment-service/src/payments/*` (state machine, service, controller, module, representation, DTOs)
- `apps/payment-service/src/authorization/authorization.service.ts`
- `apps/payment-service/src/errors.ts` (SDD section 10 error codes)
- `apps/payment-service/src/events/deterministic-id.ts`
- `apps/payment-service/src/config/payment-config.module.ts` (new, `@Global()`)
- `apps/payment-service/src/auth/auth-client.module.ts` (now `@Global()`)
- `libs/service-kit/src/service-auth/service-auth.module.ts` (now `@Global()`)
- `apps/payment-service/test/payments.e2e-spec.ts`, `test/support/app.ts` (now wires `PaymentsModule`)

## Edge cases

- Same `paymentRequestId`, identical snapshot, concurrent (6-way race over HTTP) → exactly one `201`,
  the rest `200` with the same id.
- Same `paymentRequestId`, different `amount` → `409 payment_request_conflict`, original untouched.
- `payer == seller` → `400 invalid_payment_request` before any database round trip.
- `seller.type == organization` and `organizationId` provided but different from `seller.id` →
  `400 invalid_payment_request`; omitted → defaulted to `seller.id`.
- Currency not in the configured supported list → `422 unsupported_currency` (checked before the
  database's own reference-table FK, for a clearer error).
- Unknown/malformed field, non-positive amount → `400` from the global `ValidationPipe`.
- No service token on create → `401`. A *different* configured service (not this payment's producer)
  reading it → `404`, identical to a non-existent id — never `403` (no existence leak, section 8.2).
- An authenticated but inactive identity → `401`, even if its id matches the payer.

## Data migration

N/A.

## Test plan

- Unit: `payments/payment-state-machine.spec.ts` (every transition, allowed and forbidden, exhaustively over all status pairs), `events/deterministic-id.spec.ts`.
- Integration/E2E: `test/payments.e2e-spec.ts` — creation, replay, conflict, unsupported currency,
  contract-shape rejections, authentication/authorization (producer/payer/unrelated/inactive), the
  outbox-atomicity check (`payment.created` exists exactly once for a created payment), and the
  6-way concurrent-identical-create race (also proven at the database level in the foundation TDD's
  `db/tests/run.sh`).

## Rollout

No feature flag. Adds real domain behavior for the first time (`POST/GET /payment/payments`), but the
producer fixture is a test service token — no real producer service exists yet, so nothing in
production can call these routes until a service token is provisioned for one.
