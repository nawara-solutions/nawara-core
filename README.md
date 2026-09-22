# Nawara Core

**Nawara Core** hosts the **shared, reusable microservices** for Nawara Solutions — built once, consumed by any Nawara Solutions app (starting with [Nawara Drive](../nawara-drive)) purely over their public APIs. No app ever imports this repo's code directly; they only ever call these services' endpoints.

## Why a separate repo

App-specific logic (driving lessons, exam rules, course content — anything unique to Nawara Drive) lives in the `nawara-drive` repo. Anything generic enough to be useful for a _future, unrelated_ Nawara Solutions app lives here instead. That separation keeps each repo's release cycle independent: shipping a Nawara Drive feature never requires touching Core, and improving Core (e.g. adding a new payment gateway) never requires a Nawara Drive deploy.

## Services

| Service                  | Responsibility                                                                                                                                  | Consumed by                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **auth-service**         | Registration, login, JWT/refresh tokens, role management. No commercial dependency: never checks subscription, license or entitlement state.   | Any app needing user identity        |
| **organization-service** | Company/Platform/Organization ownership. Implemented but not yet authoritative — auth-service still owns these entities.                        | Any app needing organization identity |
| **notification-service** | Generic push (FCM), SMS, email dispatch, triggered by events from any service/app                                                               | Any app needing to notify users      |
| **billing-service**      | What is owed: Product, Price, Invoice, PaymentRequest, and the Subscription/Entitlement model (one Subscription per Organization; see [ADR-0044](docs/adr/0044-subscription-entitlement-final-model.md)) | Any app needing to bill or check commercial access |
| **payment-service**      | How money was paid and the payment state only — payments, attempts, gateway adapters, transactional outbox to RabbitMQ. Not the billing or accounting system. | Billing, or any app needing to charge users |
| **ai-service**           | Generic LLM-backed service (chat, Q&A, content generation) — configurable knowledge base/prompt per calling app                                 | Any app needing AI features          |

Each service:

- Owns its own database — no service reaches into another's data directly.
- Exposes a versioned REST (and/or gRPC) API as its only public contract.
- Is independently deployable and independently versioned.

## Tech Stack

- **Language:** TypeScript (NestJS) for auth/notification/payment; Python (FastAPI) for ai-service (best ecosystem for LLM/RAG work)
- **Databases:** PostgreSQL per service; Redis for caching/sessions; a vector DB (or `pgvector`) for ai-service's knowledge base
- **Messaging:** RabbitMQ for async events (e.g. `PaymentCompleted`, `UserRegistered`) that other services/apps can subscribe to
- **Infra:** Docker Compose (local dev), Kubernetes (production, when needed)

## Repository Structure

```
nawara-core/
├── apps/
│   ├── auth-service/           # implemented and deployed
│   ├── organization-service/   # implemented, not yet authoritative (auth-service still owns Company/Platform/Organization)
│   ├── billing-service/        # implemented through Stage 12.7: catalog, invoices, Subscription/Entitlement
│   ├── payment-service/        # implemented through Stage 12.7: settlement, attempts, outbox, real-broker publishing
│   ├── notification-service/   # NestJS starter only
│   └── ai-service/             # FastAPI starter (/health only)
├── libs/
│   └── service-kit/            # technical foundations for new services (no business logic); see its README
├── infra/postgres/             # local PostgreSQL: one database + migrator/runtime roles per service, and a verify script
├── scripts/                    # static repository checks (workflow safety, architecture boundaries)
├── docs/                       # ADRs, architecture documents, ADD/SDD/TDD, security review
├── docker-compose.yml          # LOCAL development infrastructure only (PostgreSQL, RabbitMQ)
├── .github/workflows/          # Core CI, and the auth-service build/deploy workflows
├── CLAUDE.md
└── README.md
```

## Local development and checks

```bash
npm ci
cp .env.example .env                                          # local development credentials only
docker compose --profile db up -d --wait postgres             # PostgreSQL 16 on 127.0.0.1:5433
docker compose up -d rabbitmq                                 # RabbitMQ on 127.0.0.1:5672
bash infra/postgres/verify.sh                                 # proves the least-privilege roles

npm run build -w @nawara/service-kit                          # services consume the kit's built output
npm run lint|typecheck|test|build -w <workspace>              # what Core CI runs per workspace
npm run check:repo && npm run test:repo                       # static workflow-safety and architecture checks
```

See [`docs/architecture/service-foundations.md`](docs/architecture/service-foundations.md) for what is implemented versus
designed versus deferred.

## Consuming these services from another app

Other Nawara Solutions apps (including Nawara Drive) never import this repo. They call the deployed API, e.g.:

```
POST https://api.nawara-solutions.com/auth/login
POST https://api.nawara-solutions.com/payment/charge
POST https://api.nawara-solutions.com/notification/send
POST https://api.nawara-solutions.com/ai/chat
```

## Status

auth-service is implemented and deployed. billing-service and payment-service are implemented through Stage 12.7
(catalog, invoicing, settlement, Subscription/Entitlement, and a real-broker Payment→Billing integration — none of
this is production-deployed yet). organization-service is implemented but not yet authoritative. notification-service
and ai-service remain starters. See [`docs/architecture/service-foundations.md`](docs/architecture/service-foundations.md)
for the detailed implemented/designed/deferred breakdown (dated; re-verify against `docs/sdd/*` for the current state
of any one service).
