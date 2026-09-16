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
