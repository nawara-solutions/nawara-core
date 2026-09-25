# Software Design Documents (SDD)

An SDD describes the internal design of **one module or service**, one level deeper than an
[ADD](../add) — the audience is the engineer(s) about to build or maintain that module, not
someone trying to understand the whole system.

## What goes in an SDD

- Data model / schema for the module
- Key classes/interfaces and their responsibilities
- Sequence diagrams for its important flows
- The API contract it exposes (and the contracts it consumes from others)
- Error handling and edge cases at the design level

## What doesn't

- Cross-service architecture — that's an [`add/`](../add) doc
- Step-by-step implementation/file-by-file plan for a single feature — that's a
  [`tdd/`](../tdd) doc
- The _why_ behind a specific technical choice made while designing this module — that's an
  [`adr/`](../adr) entry, linked from here

## Naming

```
service-or-module-name.md
```

One SDD per module/service, e.g. `booking-service.md`, `auth-service.md`. Like ADDs, these
are living documents revised in place as the module's design evolves.

## Workflow

1. Copy [`template.md`](./template.md) to `service-or-module-name.md`.
2. Write it before (or alongside) building the module — it's a design tool, not documentation
   written after the fact.
3. Get it reviewed before implementation starts.
4. Update it when the module's design changes materially; trivial implementation details
   don't need to be reflected here.

## Index

| Title | Status |
| ----- | ------ |
| [auth-service](./auth-service.md) | Reviewed |
| [payment-service](./payment-service.md) | Draft (new design, for review; replaces the superseded one) |
| [billing-service](./billing-service.md) | Draft (for review; Stages 1-3 implemented — foundation, domain schema, HTTP API) |
| [organization-service](./organization-service.md) | Implemented (Stage 9); not authoritative: ownership migration from Auth (ADR-0039) not performed |
| [notification-service](./notification-service.md) | Draft (Stage 16.1 design, for review; not implemented) |
| [file-service](./file-service.md) | Draft (Stage 17.1 design, architecture frozen); foundation (17.2), persistence (17.3), storage port (17.4), upload (17.5), download + authorization (17.6), delete + cleanup (17.7) |
| [audit-service](./audit-service.md) | Draft (Stage 18.1 design); foundation (18.2), persistence (18.3) |
