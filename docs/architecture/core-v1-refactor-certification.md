# Core V1 refactor certification

- **Status:** RECORD. Certifies the Core V1 refactor (R0–R10), stage R11, on 2026-10-02. It authorizes nothing further.
- **Scope:** the error-localization and stable-code refactor decided in [ADR-0054](../adr/0054-localized-error-messages-and-stable-error-codes.md)
  and tracked in [the roadmap](../CORE-ROADMAP.md). **This record does not declare Core V1 complete.**

## Certified baseline

- `main` at `cb37cc0`; Core CI on that commit green (run 37010856975, 23 of 23 jobs).
- Certification is based on existing evidence; no new test execution was required (R11.0 found no blocker and no evidence gap).

## Certification criteria

1. Every planned stage, R0 to R10, is completed and merged.
2. The implementation is present on `main`.
3. The regression evidence is valid for the current runtime tree.
4. The required documentation is complete.
5. The implemented D10 and D12 boundaries are documented and tested.
6. No unresolved blocker remains within the refactor's scope.
7. `main` is green.

All seven are satisfied.

## Evidence summary

| Stage | Evidence |
|---|---|
| R0 Architecture inventory | a read-only inventory, cited by ADR-0054 as its evidence (`origin/main` `08475a5`); it was the input to R1 and has no separate repository artifact |
| R1 Localization architecture | ADR-0054, accepted |
| R2 Billing safe logging | Billing's Payment-integration failures are logged as bounded facts, never raw exception text; covered by `job-error-boundaries.spec.ts` |
| R3 Shared localization foundation | the service-kit mechanism (negotiation, catalogs, `httpError`, the shared filter, headers, the D12 exclusion option) and its tests |
| R4 Validation localization | `LocalizedValidationPipe`, per-element list identities, kit tests |
| R5 Auth adoption | Auth catalog, filter subclass, localization suite |
| R6 Remaining services | Audit, Organization, Release, File, Payment, Billing and Notification catalogs, catalog tests and localization suites; the kit's list helper exported for Notification |
| R7 Shared cleanup | read-only finding: no material shared cleanup required |
| R8 Legacy/type cleanup | Release's error helpers accept catalog texts only; a compile-failure proof showed a raw string is rejected |
| R9 Regression validation | on the merged R3–R8 tree: a fresh service-kit build and its tests, every service localization suite and catalog test green; three temporary negative controls (shared rendering, list identities, Notification's D10 provenance boundary) each detected, then restored with source and build hashes matching and no tracked change |
| R10 Documentation + error catalog | [Core error localization](core-error-localization.md) (developer guide and per-service catalog and code index), client contract in [integration guide §24](core-product-integration-guide.md#error-responses-and-language-adr-0054); structural catalog audit with no defect |

## Compatibility guarantees

The certified refactor preserves the HTTP status, the error `code`, the public error response shape and the order of list messages;
English without `Accept-Language` remains the compatibility baseline. Language negotiation, `Content-Language` and `Vary`, and the
implemented D10 and D12 boundaries are covered by the evidence above and documented in the error-localization guide.

## Evidence validity

R9 validated the runtime tree at `c278a8c`. Between that commit and the certified baseline `cb37cc0`, only documentation changed
(`README.md`, `docs/CORE-ROADMAP.md` and two documents in `docs/architecture/`: the R10 work and the roadmap closures). No source,
catalog, test, configuration or workflow file changed, so R9's runtime evidence applies to the certified baseline.

## Known non-blocking follow-ups

This certification does not close: the Billing PostgreSQL `57P01` test-teardown race; other timer-dependent test hardening; the Audit
and Release `auth_timeout` attribution question; the local RabbitMQ development-environment issue; the broader D10 policy and the
deferred R4 variants; G6, G7, F6 and F7 and the production backup and recovery work; Core V2.

## Certification boundary

R11 certifies the R0–R10 refactor only. It does not certify Core V1 production readiness or recovery: the remaining Core V1
production and recovery work (see the roadmap) still has to be completed, and **Final Core Validation remains the absolute last
validation campaign**.
