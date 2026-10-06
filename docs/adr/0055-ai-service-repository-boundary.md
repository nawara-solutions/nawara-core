# 0055. AI service repository boundary: the AI runtime lives outside `nawara-core`

- **Status:** Proposed (2026-10-06: the project owner's architecture decision; set to Accepted when the pull request that introduces it
  merges)
- **Date:** 2026-10-06
- **Deciders:** Anwar (project owner, architecture owner)

> **Amends** [ADR-0051](./0051-release-management-and-client-compatibility.md) on one point only: AI model, prompt and RAG versions
> are owned by the separate AI service (`nawara-ia`), not by a Core `ai-service`. The reserved `ai` component kind is unchanged.

## Context

`nawara-core` holds the shared platform services of Nawara Solutions (identity, the Company / Platform / Organization hierarchy,
authorization, audit, notification, billing and payment, files, releases). Its documents also listed an `ai-service` (Python/FastAPI, a
"generic LLM-backed chat/Q&A/content-generation service") as one of Core's services.

The evidence, on `origin/main` at `6fac8fe` (2026-10-06):

- `apps/ai-service` was two files: `main.py`, an 8-line FastAPI app answering `GET /health` with `{"status":"ok"}`, and
  `requirements.txt` (`fastapi`, `uvicorn[standard]`). No test, Dockerfile, Compose service, deploy workflow, runbook, `package.json`
  or CI job; nothing imported it, called it, built it, started it or routed to it. Core CI excluded it on purpose.
- Core has **no executable AI contract**: no AI endpoint, DTO, client, event, queue, table, service identity, caller policy, audit
  action, entitlement or release kind. release-service reserves an `ai` component kind in documentation (ADR-0051) and refuses it in
  its schema and validator.
- The V2 roadmap already treated a major `ai-service` build-out as FUTURE / IDEA, outside V2 scope. A12.4 (operational logging and
  PII safety) found the scaffold's stock Uvicorn access log echoed query strings and recorded A12.4.4 (ai-service logging) as not
  applicable, because the AI runtime is not a Core-owned service.

AI also has a lifecycle of its own: providers and models change independently of Core, its dependencies (Python, model SDKs, possibly
GPU or local-model runtimes) differ from Core's TypeScript stack, its scaling characteristics differ, experimentation must not
destabilise Core's certified services, and several Nawara products may reuse the same capability.

## Options considered

1. **Keep `ai-service` in `nawara-core` and build it out here.** One repository, but AI dependencies, release cadence and
   experimentation would share Core's CI, validation and change-safety gates, and the platform authority repository would own a
   fast-moving product capability.
2. **Keep the scaffold as a placeholder until AI work starts.** No immediate change, but the repository keeps describing a Core service
   that Core will never own, and every Core-wide phase (CI, observability, logging) must keep excluding it by hand.
3. **A separate repository and service, `nawara-ia`, owns the AI runtime; Core removes the scaffold and keeps only platform
   contracts.** Clear ownership and an independent lifecycle; integration goes through Core's existing platform contracts.

## Decision

We chose **option 3**.

- **Core = platform authority.** `nawara-core` stays authoritative for identities, the Company / Platform / Organization hierarchy,
  authorization, shared audit, billing and payment, notification, files, releases and its other shared platform capabilities.
  `nawara-ia` must not duplicate these authorities; it uses them.
- **`nawara-ia` = platform intelligence.** A future, separate repository and service owns the AI runtime: providers and models,
  prompts, inference and orchestration, model routing, retrieval and embeddings, agents and tools, AI-specific runtime policy, AI
  dependencies, AI-specific observability and logging, and its own build and deployment. Its internal architecture is **not** decided
  here: it follows real product requirements when that work starts.
- **Products own product business logic** (School, Drive, a future ERP, …). It moves into neither Core nor `nawara-ia`.
- **The Core scaffold is removed.** `apps/ai-service` is deleted from `nawara-core`. Nothing in Core depended on it.

### Integration principles

When `nawara-ia` integrates with Core it follows the platform contracts that apply to any caller: identity and service identity,
authorization, Company / Platform / Organization scope where applicable, request and correlation propagation, audit where an action
must be accountable, privacy and PII rules, usage or accounting where applicable, and release metadata if it registers releasable
components. These are expectations, not a protocol: **this ADR defines no endpoint, event, queue, schema, credential or token format.**
Each integration is designed, with its own decision record, when a real requirement exists.

### Logging and privacy

A12.4 is Core's implementation (the TypeScript `JsonLogger` in `libs/service-kit`). `nawara-ia` adopts a compatible policy (structured
operational logs, no secrets, no direct PII, no request bodies or prompts, no query strings in access logs, errors as their type rather
than their message) and implements it in its own runtime. Core's logger is not shared with a different runtime.

### Observability

A12.5 and A12.6 cover Core's services. Each workload owns its own instrumentation: `nawara-ia` instruments the AI runtime, as Core
instruments Core. A future Nawara observability environment may collect and visualize telemetry from Core, `nawara-ia` and other Nawara
workloads (products such as School, Drive or a future ERP), without moving any workload's implementation ownership into Core.

### Deployment

`nawara-ia` has an independent build and deployment lifecycle, not defined here. Core's build-not-deploy model, digest deployments and
production gates are unchanged.

### Releases

The `ai` component kind stays reserved, as ADR-0051 says, for AI *software* components. Executable support does not exist today:
release-service refuses `ai`, and a migration adds it only when an AI component is to be registered. A separately deployed `nawara-ia`
can then register its components through the same release contracts as any product; separate repository ownership does not prevent
that. AI model, prompt and RAG versions remain configuration of the AI service (`nawara-ia`), not releases.

## Consequences

- Core's service inventory no longer contains an AI service: CI, A12 observability and future Core-wide phases cover the Core services
  only, with no exception to carry.
- AI work starts in its own repository with its own stack and cadence: its lifecycle is independent of Core's, and it integrates with
  Core only through Core's platform contracts.
- Integrating AI into a product goes through Core's existing contracts, and any new Core-side contract (for example a caller policy for
  `nawara-ia`, or an audit action) is a separate, explicitly decided change.
- Documents that described `ai-service` as a Core service are corrected; historical records keep their text.
- Follow-up: none in Core. Creating `nawara-ia` is a separate workstream.
