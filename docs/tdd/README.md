# Technical Design Documents (TDD)

> Stands for **Technical Design Document** here — not Test-Driven Development. The two are
> unrelated: this folder holds pre-implementation design writeups for individual features;
> this project's test-writing practices (unit/integration/e2e) live wherever this project
> documents testing, if anywhere.

A TDD is the concrete plan for implementing **one feature or task**, written _before_ the code
— one level deeper than an [SDD](../sdd). It's the "how exactly am I going to build this"
document: which files change, what the algorithm/logic is, what edge cases exist, and how
it'll be tested. Once the feature ships, the TDD is frozen as a historical record of the plan
(it will drift from the final code over time — that's expected and fine; git/the code is the
source of truth for current behavior).

## What goes in a TDD

- The specific problem/ticket being solved
- Files/components touched and the change to each
- Algorithms, state transitions, or business logic that need spelling out before coding
- Edge cases and how they're handled
- Data migration steps, if any
- Test plan (what unit/integration/e2e coverage this feature needs)
- Rollout considerations (feature flags, backward compatibility)

## What doesn't

- Module-wide design decisions that outlive this one feature — that belongs in the module's
  [`sdd/`](../sdd) doc, which the TDD should link to and build on
- The _why_ behind a reusable technical choice — that's an [`adr/`](../adr) entry

## Naming

```
short-kebab-feature-name.md
```

One TDD per feature/task. Unlike ADD/SDD, a TDD is **not** updated after the feature ships —
if requirements change significantly later, write a new TDD for that follow-up work.

## Workflow

1. Copy [`template.md`](./template.md) to `short-kebab-feature-name.md`.
2. Write it before starting implementation; get it reviewed for anything non-trivial.
3. Implement against the plan, noting any deviations in the PR rather than editing the TDD
   after the fact.

## Index

| Title | Status |
| ----- | ------ |
| [auth-core-flow](./auth-core-flow.md) | Draft |
| [devices-module](./devices-module.md) | Draft |
| [admin-owner-secret-key](./admin-owner-secret-key.md) | Draft |
| [operator-login-and-confirmation](./operator-login-and-confirmation.md) | Draft |
| [operator-administration](./operator-administration.md) | Draft |
