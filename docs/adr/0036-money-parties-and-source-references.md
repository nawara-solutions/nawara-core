# 0036. Money, explicit parties and generic source references

- **Status:** Proposed
- **Date:** 2026-09-19
- **Deciders:** Anwar (project owner)

## Context

Financial records must express two directions unambiguously (a customer paying an organization, and an organization paying
Nawara), never lose precision, and refer to product objects without knowing them. The old design used ambiguous `payerId` and
`organizationId` fields and untyped integer amounts.

## Options considered

**Money**
1. **Integer minor units plus an ISO 4217 code with a currency table.** Chosen.
2. *Decimal/numeric columns.* Rejected: rounding rules leak into code.
3. *Floating point.* Rejected.

**Parties**
1. **Explicit typed references for payer, seller and organization context.** Chosen.
2. *One overloaded `organizationId`.* Rejected: ambiguous.

**References**
1. **Opaque `sourceType`/`sourceId`.** Chosen.
2. *Foreign keys to product tables.* Rejected: cross-service coupling.

## Decision

- Amounts are `bigint` minor units with a mandatory currency code; the exponent comes from a currency table (**TND has three
  decimals**). CHECK constraints reject non-positive amounts where a positive amount is required.
- Every invoice, payment and journal entry names `payer` and `seller` as `(type, id)` with `type` in `user | organization |
  company`, plus the optional `organizationId` context. Nawara's own sales use `seller = company`. **Which legal entity issues
  Nawara's invoices is an open business decision**, as is whether Nawara is represented by a Company row (the platform-owning
  company, ADR-0022) or another party type.
- `sourceType` and `sourceId` are opaque, format-checked strings; there is no foreign key and no copy of the product entity.
- The server, never the client, determines amount, currency, payer, seller and beneficiary from the invoice and the verified
  caller.

## Consequences

- No rounding surprises; multi-currency is possible later; a record answers "who paid whom, for which organization".
- Comparing amounts across currencies is impossible without an explicit rate, by design.
- Consumers must format using the currency exponent.
