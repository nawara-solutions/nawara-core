# 0003. PostgreSQL + TypeORM as auth-service's persistence

- **Status:** Proposed
- **Date:** 2026-09-16
- **Deciders:** Anwar (project owner)

## Context

`auth-service` needs relational storage for `User` and `RefreshToken` records (see
ADR-0002), with a hard uniqueness constraint on email, a foreign-key relationship from
refresh tokens to their owning user, and transactional (ACID) guarantees on registration
— a user must never be left half-created. No service anywhere in `nawara-core` has
chosen a datastore yet: every app under `apps/` (`auth-service`, `notification-service`,
`payment-service`, `ai-service`) is still a bare, unmodified framework scaffold. This is
therefore genuinely the first persistence decision made in this repo, though per this
repo's database-per-service principle it should be understood as scoped to
`auth-service`'s own choice, not a mandate binding the other three services.

## Options considered

1. **PostgreSQL with TypeORM** — decorator-based entity classes that fit naturally
   alongside NestJS's own decorator/DI conventions, a first-party, actively maintained
   `@nestjs/typeorm` integration, and built-in migration tooling.
2. **PostgreSQL with Prisma** — Prisma's generated client gives stronger end-to-end type
   safety and a very ergonomic migration workflow, but its schema lives in a separate
   `.prisma` file outside Nest's module/DI system, which is a less idiomatic fit for
   this repo's stated "NestJS module/controller/service/DTO structure" convention.
3. **MongoDB with Mongoose** — `User` and `RefreshToken` are both strictly relational,
   fixed-shape records with a real foreign key between them; there is no
   schema-flexibility requirement here that would justify a document store.
4. **MySQL with TypeORM** — functionally comparable to PostgreSQL for this workload, but
   PostgreSQL is the more common default in the NestJS ecosystem and has better native
   support for the partial/unique indexes that a nullable `organizationId` column (per
   ADR-0001) may eventually want.

## Decision

We chose **PostgreSQL with TypeORM**.

## Consequences

- Adds `@nestjs/typeorm`, `typeorm`, and `pg` to `apps/auth-service/package.json` (none
  of which are present in today's bare scaffold).
- Per the database-per-service principle, `auth-service` needs its own dedicated
  Postgres instance/database — no docker-compose or infra of any kind exists anywhere in
  this repo yet. This is a concrete follow-up piece of work, expected to be bundled into
  the first implementation TDD rather than requiring a separate ADR.
- Migrations will live under `apps/auth-service/src/migrations/`.
