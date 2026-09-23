# 0045. Commercial `entitlementKind` compatibility fields

- **Status:** Proposed. Records the Stage 13.5 disposition of fields that already exist; it changes no code, schema,
  API or event.
- **Date:** 2026-09-22
- **Deciders:** Anwar (project owner)

> **Governed by [ADR-0044](./0044-subscription-entitlement-final-model.md)**, which stays the authority for the
> commercial model. This ADR does not amend it: it only records why two leftover `entitlementKind` fields are kept, what
> they mean today, and what must happen before they could ever be retired.

## Context

The pre-implementation commercial design ([ADR-0038](./0038-entitlement-in-billing-service.md)) split commercial access
into an `organization_license` and a `user_subscription`. Billing's catalog was built with that vocabulary:

- `product."entitlementKind"` — `text NOT NULL DEFAULT 'none'`, `CHECK IN ('none', 'organization_license',
  'user_subscription')` (migration `0002`), immutable like every product column except the archive state.
- `invoice_line."entitlementKind"` — `text NOT NULL` with no default and the same `CHECK` (migration `0004`), copied from
  the product when the line is created; invoice lines are append-only.

The value set is written three times (the create-product validation in `product-input.ts` and the two `CHECK`
constraints); there is no shared type.

ADR-0044 then replaced ADR-0038's shape with the model that was built and is authoritative today:

```text
Organization ──► Subscription (one per Organization, Billing) ──► deriveEntitlement(subscription, now) ──► { valid, expiresAt }
Payment ──► settlement only (payment.succeeded) ──► Billing links a settled recurring invoice to the Subscription
```

Settlement is linked to a Subscription from `invoice_line.interval` (a snapshot of `price.interval`) alone. No part of
Subscription, `deriveEntitlement()`, the entitlement API or Payment settlement branches on either `entitlementKind`.

The fields are nonetheless **not unused** (Stage 13.5 investigation):

| Field | Observable roles today | Commercial decision-making reader |
|---|---|---|
| `product.entitlementKind` | Product API input (optional, default `none`, validated) and output; part of the create-product replay identity (same `(seller, code)` with a different value is `409 product_conflict`, the same value replays); source of the invoice-line copy | none |
| `invoice_line.entitlementKind` | persisted append-only line snapshot; published in every `invoice.created` payload (`lines[].entitlementKind`); not in the invoice HTTP representation | none |

No in-repository consumer of `invoice.created` was found, and no in-repository client reads either field. **External
consumer usage is unknown**: consuming apps (for example Nawara Drive) and any RabbitMQ subscriber outside this repo
must be verified before retirement. Removing a field from the Product API, from the replay identity or from a
published event is a backward-incompatible contract change, whatever this repository's own code does.

## Options considered

1. **Remove both fields now** — drops the superseded vocabulary, but breaks the Product API (an unknown field is a
   `400`), changes replay/conflict semantics, removes a field from a published event without versioning, and needs a
   schema migration over append-only history. Rejected: the contract cost is unknown, the benefit is cosmetic.
2. **Repurpose them as entitlement drivers** — would restore ADR-0038's model against ADR-0044. Rejected.
3. **Keep both as documented compatibility fields, with explicit retirement prerequisites** — no contract changes;
   documentation stops presenting them as either authority or dead code.

## Decision

We chose **option 3**.

- **`product.entitlementKind` is a compatibility field.** It stays on the Product API (input and output), in the
  create-product replay identity, and as the source of the invoice-line copy, with its current values and default. It
  **does not** determine Subscription behavior, effective entitlement or Payment settlement, and it is not commercial
  authority.
- **`invoice_line.entitlementKind` is retained for event and snapshot compatibility.** It stays written at line creation,
  append-only, and in the `invoice.created` payload. Having no in-repository decision-making reader is not a reason to
  remove it.
- **Commercial access has one source**: Billing's effective entitlement derived from the Organization's Subscription
  (ADR-0044). Neither `entitlementKind` is an authentication, security-status, authorization or entitlement check, and
  no service may treat it as one.
- **`requiresSubscription`** (on Auth's `organization_join_code`) remains governed by ADR-0044: non-authoritative
  onboarding/UI metadata that Auth stores and returns. It **must not** be used as commercial access authority. This ADR
  does not redefine it.

**Retirement is a separate compatibility project.** Before either `entitlementKind` is removed or its meaning changed,
at least:

1. confirm external API consumers of the Product field;
2. confirm external RabbitMQ/event consumers of `invoice.created`;
3. deprecate the Product API field (documented, not silently ignored);
4. define a compatibility window;
5. remove or replace its role in the create-product replay identity;
6. version `invoice.created` if the payload field is removed;
7. decide how historical invoice-line values are treated (kept, archived, or dropped);
8. write an explicit database migration plan;
9. add or adjust contract tests — including an `invoice.created` payload-shape test, which does not exist today.

## Consequences

- **Easier:** no API break, no event break, no database migration, no historical data rewrite; ADR-0044's Subscription
  model remains the only commercial authority, and the docs now say so consistently.
- **Harder / given up:** the superseded `organization_license` / `user_subscription` vocabulary stays visible in the
  Product API, the schema and the event, and some conceptual redundancy remains (the line copy always equals the
  immutable product value). Any cleanup needs deliberate deprecation and event versioning. This is accepted technical
  debt.
- **Follow-up:** none required now. The Billing SDD (sections 10 and 11, R-2) and the Auth ADD were corrected alongside
  this ADR. Auth migration `0004` still carries a comment saying payment-service owns entitlement; applied migrations are
  checksummed and immutable, so it is intentionally left as a historical artifact and corrected here and in the docs
  instead.
