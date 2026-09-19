# 0032. Database per service on a shared PostgreSQL server

- **Status:** Proposed
- **Date:** 2026-09-19
- **Deciders:** Anwar (project owner)

## Context

Every Core service owns its data and no service may read another's tables. Production is currently one VPS running
Docker; auth-service has its own PostgreSQL 16 container. The new services (and payment and notification when built)
need storage that is isolated but not operationally heavy.

## Options considered

1. **One database per service on a shared PostgreSQL server, one login role per service, no cross-database grants.**
   Chosen.
2. *One database, one schema per service.* Rejected: a wrong grant or `search_path` can cross services, and a service
   cannot be moved out on its own.
3. *One PostgreSQL container per service.* Rejected for now: about ten database containers to run, upgrade and back up
   on one host.

## Decision

- Each service that needs a relational store gets its **own database and its own login role** on the shared server.
  A role can connect only to its own database; no role is a superuser (see the least-privilege gap in the auth review).
- **Connection settings are per service** (`DATABASE_URL`), so moving a service to its own server later is a
  configuration change only.
- Migrations are per service and run from that service's image; no migration touches another database.
- The existing auth-service database is **not moved or renamed** by this decision.
- Services without a durable store yet (location, search, analytics) get none until a concrete need exists. Search is a
  derived index and must be rebuildable from its owners.

## Consequences

- Isolation by credentials at low cost; per-service backup and restore is possible (`pg_dump` per database).
- One server is still a single point of failure and a shared resource budget. Backups and a **tested restore** remain
  an unresolved production blocker for every database, including Auth's.
- A local development setup needs only one server plus the service's own database, created by an init script.
