# Architecture Design Documents (ADD)

An ADD describes how a system, or a major boundary within it, is put together: components,
their responsibilities, how they communicate, data ownership, and the key non-functional
constraints (scale, security, availability) that shaped the shape.

## Relationship to a root architecture overview

If this project has a root whole-system overview doc (e.g. `ARCHITECTURE.md`), that document
is the **whole-system** ADD — actors, use cases, key flows, the class diagram, the service
layout, and the recommended tech stack. It is the single source of truth for the system's
overall shape and is not duplicated here.

Files in this folder are **narrower-scope ADDs** written once a specific boundary needs more
detail than the root document carries, for example:

- How a specific service is composed internally at the architecture level (its own
  sub-components, not just "it's a service in the diagram")
- Contracts and data flow between two or more services
- Cross-cutting concerns that span several services (e.g. how JWT validation is shared, how
  events are versioned)

If you're documenting the internal design of a single module/service for implementers, that's
an [`sdd/`](../sdd) document instead — see [`docs/README.md`](../README.md) for the
distinction.

## Naming

```
short-kebab-title.md
```

No numbering — ADDs are living documents, revised in place as the architecture evolves (unlike
ADRs, which are immutable). Use git history/PRs to see how a given ADD changed over time.

## Workflow

1. Copy [`template.md`](./template.md) to `short-kebab-title.md`.
2. Reference any ADRs that informed the design.
3. Get it reviewed before implementation starts on the boundary it covers.
4. Keep it up to date as the design evolves — open a PR against the file itself.

## Index

| Title | Status |
| ----- | ------ |
| [auth-service](./auth-service.md) | Draft |
