# Architecture Decision Records (ADR)

An ADR captures one significant, hard-to-reverse architectural decision: the context that
forced it, the options considered, the choice made, and its consequences. Once accepted, an
ADR is **immutable** — if a decision changes later, write a new ADR that **supersedes** the
old one rather than editing it. This keeps a truthful history of _why_ the system looks the
way it does.

## When to write one

Write an ADR for anything that would be expensive to reverse or confusing to a future
contributor without the reasoning, e.g.:

- Choosing a datastore, message broker, or framework
- Splitting or merging a service
- Adopting a monorepo tool, a testing strategy, an auth strategy
- Any decision recorded in this project's root architecture doc (if it has one) that needs
  the _why_, not just the _what_

Don't write one for reversible, low-stakes choices (e.g. a lint rule, a variable name) — use
a PR description or code comment instead.

## Naming

```
NNNN-short-kebab-title.md
```

Numbers are sequential and never reused, even if an ADR is later superseded or rejected.

## Workflow

1. Copy [`template.md`](./template.md) to `NNNN-short-kebab-title.md` (next sequential number).
2. Fill it in with status `Proposed`.
3. Get it reviewed in the PR that introduces the decision (or the PR that first acts on it).
4. On merge, set status to `Accepted`.
5. If a later decision replaces this one, set this one's status to `Superseded by ADR-000X`
   and link both directions.

## Index

| #   | Title | Status |
| --- | ----- | ------ |
| [0001](./0001-generic-organization-id-scoping-claim.md) | Generic `organizationId` as the multi-tenancy scoping claim | Accepted |
| [0002](./0002-jwt-access-token-with-rotating-refresh-token.md) | JWT access token + DB-backed refresh token with rotation & reuse detection | Accepted |
| [0003](./0003-postgresql-typeorm-persistence.md) | PostgreSQL + TypeORM as auth-service's persistence | Accepted |
| [0004](./0004-synchronous-fail-closed-license-validation.md) | Synchronous, fail-closed license validation against payment-service for B2B registration | Accepted |
| [0005](./0005-bounded-time-license-subscription-revalidation.md) | Bounded-time license and subscription re-validation on login and refresh | Accepted |
| [0006](./0006-per-user-subscription-reservation-on-license-lapse.md) | Per-user subscription reservation on organization license lapse | Accepted |
| [0007](./0007-out-of-band-cash-payment-confirmation.md) | Out-of-band cash payment confirmation via Admin role | Accepted |
| [0008](./0008-automatic-grace-license-on-license-lapse.md) | Automatic 24-hour grace license on organization license lapse | Accepted |
| [0009](./0009-platform-scoped-admin-accounts.md) | Platform-scoped Admin accounts (platformId, owner/operator tiers) | Accepted |
| [0010](./0010-owner-secret-key-login-with-device-alerting.md) | Owner permanent secret-key login with new-device alerting | Accepted |
| [0011](./0011-operator-time-boxed-login-code.md) | Time-boxed operator login code with business-day gating | Accepted |
| [0012](./0012-owner-managed-operator-schedule-and-blocking.md) | Owner-managed operator profile, schedule, and block/unblock | Accepted |
| [0013](./0013-operator-session-ceiling.md) | Hard 8-hour session ceiling for operator refresh-token rotation | Accepted |
| [0014](./0014-schedule-anchored-operator-duration.md) | Schedule-anchored operator login-code and session duration | Accepted |
| [0015](./0015-two-phase-operator-contact-confirmation.md) | Two-phase operator contact confirmation before first login | Accepted |
| [0016](./0016-first-owner-bootstrap-command.md) | One-time bootstrap command for a platform's first owner account | Proposed |
