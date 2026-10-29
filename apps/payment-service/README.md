# payment-service

Answers: **how was an obligation paid, by which method, and what is the payment state?** See
[`docs/sdd/payment-service.md`](../../docs/sdd/payment-service.md) for the full design (data model,
state machines, idempotency, authorization, events) and
[`docs/architecture/financial-architecture.md`](../../docs/architecture/financial-architecture.md)
for how it fits alongside billing-service and accounting-service. It is **not** the billing or
accounting system: it never decides what is owed and keeps no ledger.

## Caller admission (Stage 21.C.2, ADR-0052; ADR-0042 AD-2 and Amendment 3)

- `PAYMENT_SERVICE_POLICY` (the kit caller-policy mechanism, deny by default) names each registered caller's operations and
  `allowedPlatforms`. The approved V1 content: `billing-service` with `payment.create`, `payment.read` and `payment.cancel` only.
  `auth-service` has no Payment authority. No service may start or sync an attempt (payer-only routes).
- An Organization named on a create is verified through Organization Service's reference read (`ORGANIZATION_SERVICE_URL`,
  `ORGANIZATION_REFERENCE_TOKEN`, required in production) and must be in the caller's Platforms: otherwise `403
  organization_not_permitted`; if it cannot be verified (before the 21.x cutover it cannot), `503 hierarchy_unavailable` and nothing is
  written. A replay is answered from the stored payment. `ORGANIZATION_REFERENCE_FIXTURE` is non-production only.
- **Organization payers (Core V2 S4e, register PAY-03 F; Owner A-1 to A-7).** `assisted_settlement` / `recovery_settlement` with an
  Organization payer need the default-denied operation `payment.create.organization_payer` (never implied by `payment.create`; refused in
  production configuration; no configured producer holds it, so the capability is inactive until S5b / S6f and a separate Owner decision).
  **Core V2 S5b (Owner E-2, PAY-03 G):** the grant is purpose-bound. `assisted_settlement` needs exactly `payment.create.assisted_settlement`,
  which only `billing-service` may hold, in non-production configuration only. The broad operation no longer admits it and stays
  default-denied, for `recovery_settlement` only.
  The payer is the payment's `organizationId`. Its attempts are started and synced, and its payments read, only by an **Organization actor**:
  an ordinary member whom Auth's live `/auth/me` shows active with an `active` administrator membership in that Organization, on the
  Organization's authoritative Platform (the reference read). Everyone else gets the collapsed `404`; Auth or the reference unavailable is
  `503`. Active Organizations only: V-5 and OD-R6a stay open.

## Status: Phase 1 (technical foundation)

Gateway-settlement lifecycle only. No cash, no refunds — see the SDD's "Implementation readiness
gate" (section 22) and the `[B]`-gated decisions below. **Not production-ready**: no real gateway,
no production traffic can reach any of this (the test provider refuses to start when
`NODE_ENV=production`), and several `[B]` decisions remain open.

### Implemented in Phase 1

- Service foundation on `@nawara/service-kit`: configuration, database connection/migration wiring,
  `/health`/`/ready` (readiness is the database and migrations; since V2 A3M.3 it never depends on the broker: events wait in the
  outbox while RabbitMQ is unavailable, S21-5), service-token authentication, a combined service-token-or-user guard, the event
  bus (RabbitMQ by configuration and **required when `NODE_ENV=production`**; the in-memory bus is for development and tests only), a generic rate limiter, OpenAPI at
  `/payment/docs` (basic auth, unmounted unless a password is configured), and raw-body capture for
  the webhook route (Nest's `rawBody: true`, no kit change needed).
- Schema: `currency`, `payment`, `payment_attempt`, `idempotency_key`, `webhook_event` — financial
  invariants FI-01, FI-02, FI-03, FI-04, FI-09, FI-11 and the late-success edge of FI-12 enforced at
  the database level (CHECK constraints, immutability and state-transition triggers), not just in
  application code.
- Payment lifecycle: `created → pending → succeeded/failed → created (retry) → expired`, natural-key
  idempotency on `(producer, paymentRequestId)`, header-based idempotency for attempts.
- Endpoints 1, 2, 3, 4, 5, 9 of SDD section 9: create/get a payment, start/sync an attempt, provider
  webhooks, cancel (Stage 4: producer-only, `Idempotency-Key` required, refuses a terminal state or
  an open attempt with `payment_has_open_attempt`).
- The deterministic test provider (`success`, `failure`, `retry`, `timeout_before_accept`,
  `timeout_after_accept`, plus signature verification), the provider port, and three background jobs
  (`AttemptResolver`, `WebhookRetrier`, `ExpirySweeper`) with the same start/stop shape as the kit's
  `OutboxRelay`.
- **The `simulation` provider (Core V2 S4f, register PAY-14; OD-06 F-S1 to F-S7):** beside `test`, never in production (startup is
  refused; its routes are not mounted; its service refuses if reached). Payers cannot choose its outcomes: `providerOptions` is refused
  (`422 provider_options_not_accepted`) and, when it is enabled, it is the server's default provider while the test provider must be off.
  An authorized harness caller holding `payment.simulation.resolve` **alone** (granting it is refused unless the provider is enabled)
  instructs it through `POST /payment/simulation/payments/:paymentId/initiation` (`accepted | ambiguous | rejected`),
  `POST /payment/simulation/payments/:paymentId/attempts/:attemptId/outcomes` (`succeeded | amount_mismatch | failed | expired |
  no_record | pending`, delivered `immediate` or `held`) and `POST /payment/simulation/commands/:commandId/deliver` (delayed, duplicate,
  out-of-order delivery). A command only changes the simulated provider's own append-only records (`simulation_provider_command`, migration
  0015): Payment learns through the ordinary path, a notification signed with `PAYMENT_SIMULATION_WEBHOOK_SECRET` and verified by the
  webhook pipeline, or the status read, so a command is never itself a settlement fact. Money, currency and the provider transaction are
  derived from Payment's rows. Each `commandId` is a stable identity: an identical replay answers `200` (`Idempotent-Replayed`) and changes
  nothing; other content under it is `409 simulation_command_conflict`. A provider session expiry (`expired`) is now an evidence class of
  the shared pipeline: a submitted attempt expires definitively.
- **Refund attempts (Core V2 S6b, register PAY-07, PAY-08; ADR-0067 decisions 3 to 7; the Owner's R6B-1 to R6B-10), DEVELOPMENT AND
  SIMULATION ONLY** (`src/refunds/`, migration 0017). Mounted only where `PAYMENT_SERVICE_POLICY` grants `payment.refund.create` (to
  `billing-service` alone; production configuration refuses it, and then nothing is mounted). `POST /payment/payments/:paymentId/refunds`
  (`Idempotency-Key`, class M; the fingerprint never covers the secret) `{refundAttemptId, refundCaseId, amount, currency, reason,
  legalOverride, receiptSecret}`: Payment verifies the payment itself (succeeded, `gateway`, a Company seller, a refundable purpose,
  `liveMode=false`, exactly one uncontested S4d capture fact of the full amount, the full amount and currency, no refund fact and no other
  attempt that may still refund, no dispute exposure), commits the durable intent (the attempt id is the receipt `consumeRef` and the
  provider idempotency key; the attempt is bound to its receipt by a digest, never the secret), consumes the receipt at Auth (AUTH-02, with
  `AUTH_SERVICE_TOKEN`), then commits `authorized` with Auth's approver. Only Auth's definitive answers end an authorization
  (`receipt_invalid` / `receipt_binding_invalid` → `authorization_refused`, `receipt_expired` → `authorization_expired`); anything else
  stays `authorization_pending` (503 `refund_authorization_unresolved`), recovered by the same receipt or by the worker's AUTH-03 lookup; no
  expiry margin is invented. A refusal before any attempt is permanent for that id (`refund_attempt_refusal`). The `RefundWorker` dispatches
  with the stable key (`dispatching` is durable before the call), resends an `unknown` refund only with the same key, never fails one on "no
  record", and applies provider evidence: a verified refund is first an immutable `provider_transaction_fact` of kind `refund`; only a fact of
  exactly the full amount succeeds the attempt, anything else is `discrepancy`; a provider-confirmed failure is `failed`. `GET
  /payment/payments/:paymentId/refunds` (PAY-08): the producer (with its refusals) or the payer. Audit `refund_attempt.authorized`,
  `.failed`, `.succeeded` (version 1, no scope; the approver stays on Payment's row). **Core V2 S6c** (migration 0018,
  `src/refunds/refund-allocation.service.ts`): each authorization's verified refund facts are allocated (FC-2: cumulative, excess kept,
  contested or foreign-currency facts blocked, technical failures retried with backoff) and, at the approved amount, the authorization is
  completed once with `refund.case_completed` in the outbox and audit `refund_authorization.completed`; a completed case refuses every new
  attempt (`409 refund_case_completed`). No reversal (S6d). The simulation provider gains refunds: `POST /payment/simulation/payments/:paymentId/refund-dispatch-plan`
  (`accepted | ambiguous | rejected`), `POST /payment/simulation/refunds/:refundAttemptId/outcomes` (`succeeded | amount_mismatch | failed |
  no_record | pending`, `immediate | held`) and `POST /payment/simulation/refund-commands/:commandId/deliver`, under the same harness
  authority; refund outcomes reach Payment only through the signed notification or the status read.
- **Payment disputes (Core V2 S6e-D; register PAY-09 to PAY-11, EVT-03; the Owner's R6E-1 to R6E-6, R6E-8, R6E-9) — DEVELOPMENT AND SIMULATION
  ONLY** (`src/disputes/`, migration 0019; mounted exactly where refunds are). Signed `payment.dispute.opened | won | lost` notifications,
  through the same webhook pipeline, record a `payment_dispute` (unique `(provider, providerDisputeId)`, bound to the verified capture, in the
  provider's stated exposure, `open → won | lost` once) and keep every observation (`applied`, `duplicate`, or a `conflict` preserved for
  S6h: a contradictory terminal outcome, another exposure or chargeback for the same dispute, an unverified capture). A loss moves money only
  as a verified `chargeback` fact the provider reports with it (or later), linked once. Refund admission reads this exposure under the payment
  lock (an open dispute or a chargeback: `409 refund_dispute_open`; a conflict or a loss without its chargeback: `503`, nothing written;
  attempts in flight continue). Owner routes (live `/auth/grants`): `GET /payment/admin/disputes[/:id]`, `POST …/:id/evidence`
  `{grantId, fileId}` (File's `dispute_evidence` grant for exactly this dispute; `FILE_SERVICE_URL`/`FILE_SERVICE_TOKEN`) and `POST
  …/:id/decision` `{decision, receiptSecret}` (an Auth `dispute_decision` receipt, consumed once; the provider still decides the outcome).
  Producer reads (`payment.read`): `GET /payment/payments/:id/dispute-exposure` and `GET /payment/disputes/losses`. Events
  `payment.dispute.opened` / `payment.dispute.lost` (v1, outbox); audit `payment_dispute.opened`, `.closed`, `.evidence_added`, `.decided`.
  Harness: `POST /payment/simulation/payments/:paymentId/disputes` and `POST /payment/simulation/dispute-commands/:commandId/deliver`.
- Financial invariants FI-13 (provider amount/currency must match the snapshot) and the late-success
  rule (an inferred failure can still succeed later; a provider-confirmed one is a real conflict, never
  silently applied) — enforced by `AttemptService.applyStatus`, the single implementation `sync`, the
  resolver and the webhook path all share.
- Transactional outbox events: `payment.created`, `payment.succeeded`, `payment.failed`,
  `payment.expired`, `payment.cancelled`. Payloads follow SDD section 11 (common payload, `revision`,
  `actor`, `cause`, correlation id) plus `producer` (Stage 4: additional producer-isolation evidence
  for Billing's consumer, sourced only from the payment row, never overridable via event metadata —
  never a replacement for full snapshot validation).
- **Central audit intent (Stage 18.7.1, ADR-0049; `src/audit/payment-audit.ts`):** `payment.created`, `payment.cancelled`,
  `payment.expired`, `payment.succeeded`, `payment.failed` are written through `@nawara/audit-contract`'s `AuditEventWriter` into the SAME
  outbox, in the SAME transaction as the transition, and relayed to audit-service like every other event. The actor is the
  authenticated service, the Auth-verified user with the kind Auth verified (attempt start / sync), or Payment's own process
  (`payment_attempt_resolver`, `payment_expiry_sweep`, `payment_webhook`); the organization is the payment row's. Event ids derive from
  (payment, action), so a retried transition writes its evidence once. Identifiers only: no amount, reference, description or provider
  failure code. See the [Stage 18.7 record](../../docs/architecture/stage-18/stage-18-7-core-producer-integration.md).
- Baseline rate limits on payment creation (per producer) and attempts (per payer), `PAYMENT_RATE_LIMIT_*`.
- 52 unit + 107 integration/e2e tests (against a real PostgreSQL, including the service running as the restricted
  `payment_app`-style role) plus 47 database-level invariant assertions and 2 concurrency races in `db/tests/`.
  See `docs/tdd/payment-phase1-acceptance-fixes.md` for what the acceptance review found and fixed.

### Blocked by business decision (not implemented — see `docs/sdd/payment-service.md` section 19)

- Cash submissions and their confirm/reject flow — **O-4** (who may submit), **O-5** (who may
  confirm/reject).
- Refunds beyond Core V2 S6b's simulation scope: partial refunds stay deferred (S0 D4); real provider refunds, allocation and completion
  (S6c), reversal (S6d), disputes (S6e) and reconciliation (S6h) are later stages.
- Producer service-token scopes and non-test-fixture producers — **O-13**, **O-14**.
- Organization/platform/company hierarchy validation with no user context — **O-15**.
- Any currency beyond the configured list, and a default/maximum payment lifetime — **O-10**, **O-16**.
- Who may pay on behalf of an organization, and read access beyond producer/payer — **O-18**, **O-20**.

### Deferred (`[X]`, SDD section 18)

Real gateway adapters, organization payment accounts, settlement, payouts, fees, custody/wallet,
merchant-of-record behaviour, full periodic reconciliation, admin/support tooling.

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

## Environment

Read once at startup by `src/config/payment-config.ts` (the kit's `EnvReader`); a missing or invalid value stops the process, and no
error repeats a value. This table is the reference; [`.env.example`](./.env.example) is a local-development template. **Every** value may
be given as `NAME_FILE=/path` instead of `NAME` (setting both is refused); surrounding whitespace is removed and a blank value is unset.
Rotation: [secret rotation runbook](../../docs/runbooks/secret-rotation.md).

| Variable | Required | Default | Secret | Meaning |
|---|---|---|---|---|
| `NODE_ENV`, `PORT`, `LOG_LEVEL`, `BODY_LIMIT_KB`, `CORS_ORIGINS`, `TRUST_PROXY_HOPS`, `HTTP_DRAIN_TIMEOUT_MS`, `DB_*`, `METRICS_*` | no | kit defaults (`NODE_ENV` = `production`) | no | the kit's base configuration |
| `DATABASE_URL` | yes | none | **yes** (password) | the runtime role `payment_app`; in production `postgres`, `root`, `*_migrator` and `*_admin` are refused |
| `AUTH_SERVICE_URL`, `AUTH_TIMEOUT_MS` | URL yes | none, 3000 | no | live identity for user bearers |
| `SERVICE_TOKENS` | no | none (every service call refused) | no (digests) | accepted callers, `<caller>:<sha256 digest>`, at most two per caller. In production a digest of the token published in the root `.env.example` is refused |
| `PAYMENT_SERVICE_POLICY` | when a token is registered | none | no | each caller's operations and `allowedPlatforms` (deny by default) |
| `ORGANIZATION_SERVICE_URL`, `ORGANIZATION_REFERENCE_TOKEN`, `ORGANIZATION_REFERENCE_TIMEOUT_MS` | **in production** | none, none, 2000 | token: **yes** | Organization verification (no bypass in production; `ORGANIZATION_REFERENCE_FIXTURE` is refused there) |
| `RABBITMQ_URL`, `RABBITMQ_CONFIRM_TIMEOUT_MS`, `RABBITMQ_HEARTBEAT_S` | URL **in production** | none, 5000, kit default | **yes** (URL password) | event bus; without it the in-memory bus (development and tests only) |
| `PAYMENT_SUPPORTED_CURRENCIES` | no | `TND` | no | ISO 4217 codes, comma-separated |
| `PAYMENT_MAX_ATTEMPTS` | no | 3 | no | attempts per payment (1 to 20). `IDEMPOTENCY_TTL_HOURS` was retired by Core V2 S4g and is refused: money-command idempotency is class M, retained 90 days by the database |
| `PAYMENT_RATE_LIMIT_CREATE_PER_MINUTE`, `PAYMENT_RATE_LIMIT_ATTEMPT_PER_MINUTE` | no | 300, 30 | no | per-caller limits |
| `PAYMENT_RETURN_URL_ALLOWLIST` | no | empty | no | allowed return-URL prefixes |
| `PAYMENT_TEST_PROVIDER` | no | `false` | no | the development test gateway (payer-chosen `scenario`s); **refused in production** |
| `PAYMENT_SIMULATION_PROVIDER` | no | `false` | no | Core V2 S4f: the `simulation` provider and its harness routes (certification only); **refused in production** and together with `PAYMENT_TEST_PROVIDER` |
| `AUTH_SERVICE_TOKEN` | when `PAYMENT_SERVICE_POLICY` grants `payment.refund.create` | none | **yes** | Payment's own service token for Auth's receipt consumption and lookup (AUTH-02, AUTH-03; Core V2 S6b); at least 32 characters, never a published value; refused in production |
| `FILE_SERVICE_URL`, `FILE_SERVICE_TOKEN` | no (only beside refunds) | none | token: **yes** | File Service and Payment's own service token for verifying an Owner's `dispute_evidence` grant (`read_granted`; Core V2 S6e-D, PAY-10); set together; the token at least 32 characters, never a published value; refused in production. Absent: dispute evidence is refused (503) and nothing recorded |
| `PAYMENT_SIMULATION_WEBHOOK_SECRET` | when the simulation provider is on | none | **yes** | the simulation provider's notification signing secret (at least 32 characters; a value published in this repository is refused); refused in production |
| `SWAGGER_USERNAME`, `SWAGGER_PASSWORD` | no | `docs`, none | password: **yes** | API docs; mounted only with a password of at least 16 characters |

No real gateway adapter exists yet, so there is no gateway credential to configure.

## Running locally

```bash
cd apps/payment-service
cp .env.example .env                  # edit AUTH_SERVICE_URL etc. for your setup (NODE_ENV=development is in the template)
set -a; . ./.env; set +a              # nothing loads .env for you: export it into this shell before starting
docker compose --profile db up -d --wait postgres   # from the repo root
npm run start:dev
```

Unset, `NODE_ENV` means **production**: the service then requires a broker and the runtime database role. Shared setup (Node 22, `npm run build:libs`, the environment, the test environment variables): [developer guide](../../docs/DEVELOPMENT.md).

## Migrations

```bash
MIGRATION_DATABASE_URL=postgres://payment_migrator:...@localhost:5433/payment npm run migrate -w payment-service
```

Nothing migrates automatically at service start; `/ready` fails while a migration is pending (see
`@nawara/service-kit`'s README for the full migration model).

## Tests

```bash
npm run test -w payment-service         # unit
npm run test:e2e -w payment-service      # integration, against a real PostgreSQL (TEST_DATABASE_ADMIN_URL: developer guide §6)
npm run test:db -w payment-service       # database-level invariants and concurrency races (needs PGHOST/PGPORT/PGUSER/PGPASSWORD)
npm run test:all -w payment-service      # all three
```
