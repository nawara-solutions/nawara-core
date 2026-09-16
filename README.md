# Nawara Core

**Nawara Core** hosts the **shared, reusable microservices** for Nawara Solution — built once, consumed by any Nawara Solution app (starting with [Nawara Drive](../nawara-drive)) purely over their public APIs. No app ever imports this repo's code directly; they only ever call these services' endpoints.

## Why a separate repo

App-specific logic (driving lessons, exam rules, course content — anything unique to Nawara Drive) lives in the `nawara-drive` repo. Anything generic enough to be useful for a _future, unrelated_ Nawara Solution app lives here instead. That separation keeps each repo's release cycle independent: shipping a Nawara Drive feature never requires touching Core, and improving Core (e.g. adding a new payment gateway) never requires a Nawara Drive deploy.

## Services

| Service                  | Responsibility                                                                                                                                  | Consumed by                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **auth-service**         | Registration, login, JWT/refresh tokens, role management                                                                                        | Any app needing user identity        |
| **notification-service** | Generic push (FCM), SMS, email dispatch, triggered by events from any service/app                                                               | Any app needing to notify users      |
| **payment-service**      | Gateway-agnostic billing engine — supports multiple "products" (e.g. subscriptions, licenses, one-off charges) across multiple payment gateways | Any app needing to charge/bill users |
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
│   ├── auth-service/
│   ├── notification-service/
│   ├── payment-service/
│   └── ai-service/
├── libs/
│   ├── shared-types/        # DTOs/interfaces published for consuming apps
│   ├── shared-auth-guard/   # JWT validation middleware reused across services
│   └── shared-config/
├── infra/
│   └── docker-compose.yml
├── CLAUDE.md
└── README.md
```

## Consuming these services from another app

Other Nawara Solution apps (including Nawara Drive) never import this repo. They call the deployed API, e.g.:

```
POST https://api.nawara-solution.com/auth/login
POST https://api.nawara-solution.com/payment/charge
POST https://api.nawara-solution.com/notification/send
POST https://api.nawara-solution.com/ai/chat
```

## Status

🚧 Early-stage / scaffolding phase.
