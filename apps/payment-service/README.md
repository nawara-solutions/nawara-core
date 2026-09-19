# payment-service

Answers: **how was an obligation paid, by which method, and what is the payment state?** See
[`docs/sdd/payment-service.md`](../../docs/sdd/payment-service.md) for the full design (data model,
state machines, idempotency, authorization, events) and
[`docs/architecture/financial-architecture.md`](../../docs/architecture/financial-architecture.md)
for how it fits alongside billing-service and accounting-service. It is **not** the billing or
accounting system: it never decides what is owed and keeps no ledger.

## Status: Phase 1 (technical foundation)

Gateway-settlement lifecycle only. No cash, no refunds — see the SDD's "Implementation readiness
gate" (section 22) and the `[B]`-gated decisions below. **Not production-ready**: no real gateway,
no production traffic can reach any of this (the test provider refuses to start when
`NODE_ENV=production`), and several `[B]` decisions remain open.

### Implemented in Phase 1

- Service foundation on `@nawara/service-kit`: configuration, database connection/migration wiring,
  `/health`/`/ready`, service-token authentication, a combined service-token-or-user guard, the event
  bus (in-memory locally, RabbitMQ by configuration), a generic rate limiter, OpenAPI at
  `/payment/docs` (basic auth, unmounted unless a password is configured), and raw-body capture for
  the webhook route (Nest's `rawBody: true`, no kit change needed).
- Schema: `currency`, `payment`, `payment_attempt`, `idempotency_key`, `webhook_event` — financial
  invariants FI-01, FI-02, FI-03, FI-04, FI-09, FI-11 and the late-success edge of FI-12 enforced at
  the database level (CHECK constraints, immutability and state-transition triggers), not just in
  application code.
- Payment lifecycle: `created → pending → succeeded/failed → created (retry) → expired`, natural-key
  idempotency on `(producer, paymentRequestId)`, header-based idempotency for attempts.
- Endpoints 1, 2, 3, 4, 5 of SDD section 9: create/get a payment, start/sync an attempt, provider
  webhooks. (Endpoint 9, cancel, is `[T]` — implemented at the service layer, no HTTP route; see
  "Deferred" below.)
- The deterministic test provider (`success`, `failure`, `retry`, `timeout_before_accept`,
  `timeout_after_accept`, plus signature verification), the provider port, and three background jobs
  (`AttemptResolver`, `WebhookRetrier`, `ExpirySweeper`) with the same start/stop shape as the kit's
  `OutboxRelay`.
- Financial invariants FI-13 (provider amount/currency must match the snapshot) and the late-success
  rule (an inferred failure can still succeed later; a provider-confirmed one is a real conflict, never
  silently applied) — enforced by `AttemptService.applyStatus`, the single implementation `sync`, the
  resolver and the webhook path all share.
- Transactional outbox events: `payment.created`, `payment.succeeded`, `payment.failed`,
  `payment.expired` (`payment.cancelled` exists at the service layer; cancel has no route yet). Payloads follow
  SDD section 11 (common payload, `revision`, `actor`, `cause`, correlation id).
- Baseline rate limits on payment creation (per producer) and attempts (per payer), `PAYMENT_RATE_LIMIT_*`.
- 51 unit + 96 integration/e2e tests (against a real PostgreSQL, including the service running as the restricted
  `payment_app`-style role) plus 47 database-level invariant assertions and 2 concurrency races in `db/tests/`.
  See `docs/tdd/payment-phase1-acceptance-fixes.md` for what the acceptance review found and fixed.

### Blocked by business decision (not implemented — see `docs/sdd/payment-service.md` section 19)

- Cash submissions and their confirm/reject flow — **O-4** (who may submit), **O-5** (who may
  confirm/reject).
- Refunds — **O-6** (who may refund; whether partial refunds are approved). FI-07/FI-08/FI-10/FI-14
  (the refund invariants) have no enforcement yet because there is no refund table.
- Producer service-token scopes and non-test-fixture producers — **O-13**, **O-14**.
- Organization/platform/company hierarchy validation with no user context — **O-15**.
- Any currency beyond the configured list, and a default/maximum payment lifetime — **O-10**, **O-16**.
- Who may pay on behalf of an organization, and read access beyond producer/payer — **O-18**, **O-20**.

### Deferred (`[X]`, SDD section 18)

Real gateway adapters, organization payment accounts, settlement, payouts, fees, custody/wallet,
merchant-of-record behaviour, full periodic reconciliation, admin/support tooling, the cancel HTTP
route (implemented at the service layer only — flag if you want it exposed).

### Known limitations

- The webhook route (`POST /payment/webhooks/{provider}`) has **no rate limit**: the kit limiter is
  database-backed, and an unauthenticated caller must not be able to write rows (SDD 4.6). Limit it at the
  gateway, or decide on an in-memory limiter.
- `submitted -> expired` (SDD 5.2, the attempt TTL) and the stuck-payment/alert machinery are not built:
  a payment whose attempt stays `submitted` at the provider is never expired and nothing alerts.
- Attempts resolved from `unknown` never record a `providerTransactionId` (the port's `fetchStatus` does not return
  one), so FI-09 cannot protect them. Add it to the port with the first real adapter.
- `returnUrl` is validated as a URL but ignored; the `PAYMENT_RETURN_URL_ALLOWLIST` check is not enforced yet.
- `unmatched` webhooks are retried with no upper bound and raise no alert (SDD 7 wants a bounded period).
- Webhook "out of order" handling relies on `applyStatus`'s own idempotent no-ops rather than a
  distinct `ignored_stale` outcome; functionally safe, less precisely observable than the SDD's fully
  detailed table.
- Observability (structured counters/alerts for stuck attempts, conflicts, outbox lag) is not built —
  the background jobs log via Nest's `Logger` only.

## Running locally

```bash
cp .env.example .env                  # edit AUTH_SERVICE_URL etc. for your setup
docker compose --profile db up -d --wait postgres   # from the repo root
npm run start:dev -w payment-service
```

## Migrations

```bash
MIGRATION_DATABASE_URL=postgres://payment_migrator:...@localhost:5433/payment npm run migrate -w payment-service
```

Nothing migrates automatically at service start; `/ready` fails while a migration is pending (see
`@nawara/service-kit`'s README for the full migration model).

## Tests

```bash
npm run test -w payment-service         # unit
npm run test:e2e -w payment-service      # integration, against a real PostgreSQL (needs TEST_DATABASE_ADMIN_URL)
npm run test:db -w payment-service       # database-level invariants and concurrency races (needs PGHOST/PGPORT/PGUSER/PGPASSWORD)
npm run test:all -w payment-service      # all three
```
