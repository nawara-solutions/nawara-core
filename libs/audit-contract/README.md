# @nawara/audit-contract

The Core **audit contract** (ADR-0049, [Stage 18.4 record](../../docs/architecture/stage-18/stage-18-4-canonical-contract-catalog.md)):
the canonical audit payload, the reviewed **event catalog**, the **one runtime validator** shared by producers and audit-service, and the
**transactional producer helper** over the kit outbox. Human-readable catalog (generated from the code):
[`docs/architecture/audit-event-catalog.md`](../../docs/architecture/audit-event-catalog.md).

It has **no runtime dependency** (not even `@nawara/service-kit`: the outbox and the query client are structural ports the kit
satisfies), stores nothing, publishes nothing and queries nothing.

## Why a package of its own (and not the kit)

The kit holds generic technical infrastructure; `membership.revoked` → `auth-service`, `security` is an audit/domain contract. Producers
need the contract without depending on audit-service internals, and audit-service needs the same validation: a small dedicated package
is the only place both can import without a cycle. Dependency direction (enforced by `npm run check:repo`):

```text
 payment / billing / organization / file / auth  ──►  @nawara/audit-contract   (".")       ◄── audit-service
                                                           ▲ ("./consumer": audit-service only)
 @nawara/service-kit  ──✗──►  @nawara/audit-contract       (the kit never depends on it)
 @nawara/audit-contract/src  ──✗──►  anything but its own files
 any service  ──✗──►  apps/audit-service/src/…             (no service imports another's source)
```

## Entry points

| Import | For | Exports |
|---|---|---|
| `@nawara/audit-contract` | producers (and audit-service) | `AuditEventWriter`, `validateAuditPayload`, `AuditContractError`, `AUDIT_REFUSALS`; the catalog (`AUDIT_CATALOG`, `AUDIT_ACTIONS`, `CORE_PRODUCERS`, `catalogEntry`, `actionsOwnedBy`); constants (`AUDIT_CONTRACT_VERSION`, `SUPPORTED_AUDIT_VERSIONS`, `AUDIT_CATEGORIES`, `ACTOR_TYPES`, `USER_KINDS`, `AUDIT_OUTCOMES`); types (`AuditPayload`, `AuditActor`, `AuditReference`, `AuditEventInput<A>`, `AuditChangesOf<A>`, …) |
| `@nawara/audit-contract/consumer` | audit-service only | `validateAuditEvent` (a received kit envelope → `ValidatedAuditEvent`) |
| `@nawara/audit-contract/testing` | tests only | `sampleAuditPayload(action, 'minimal' \| 'complete')`, `sampleActor`, `sampleActions`, `SAMPLE_IDS` |

Everything else (grammars, the sensitive-data lists, the jsonb size model, the catalog-document renderer) is internal.

## Producing an audit event (Stage 18.7 onward)

```ts
const audit = new AuditEventWriter({ sourceService: config.serviceName, outbox: outboxService }); // the name the relay stamps as source

await db.tx(async (q) => {
  await q.query(`UPDATE organization_membership SET status = 'revoked' … WHERE id = $1`, [membershipId]);
  await audit.write(q, {
    action: 'membership.revoked',
    actor: { type: 'user', id: actor.userId, userKind: actor.kind },
    organizationId: membership.organizationId,          // from the ROW, never from a header or token
    resource: { type: 'membership', id: membershipId },
    subject: { type: 'user', id: membership.userId },
    outcome: 'succeeded',
    changes: { authority, was_admin: membership.isOrganizationAdmin },
  });
});
```

`write` validates first (nothing is written for an invalid event), refuses a client that is not inside an open transaction
(`transaction_required`, detected with a `SAVEPOINT`), then calls the kit `OutboxService.enqueue` **on the same client**: the business
change and its audit intent commit or roll back together. It never opens, commits or publishes anything. Derived, never supplied: the
source (constructor), the category (catalog), the event type `audit.<action>`, the version (1), `occurredAt` (the outbox row's `now()`,
the business transaction's time) and, by default, the event id (a new UUID) and correlation id (the request's). A producer may pass
`{ eventId }` (a UUID) to make a retried business operation write its event once.

The helper validates structure, ownership and metadata policy. **It cannot prove business truth**: that the actor was authorized, that
the organization is the one recorded on the resource, that the change happened. Those remain the producing service's duty.

## Validation

`validateAuditPayload(payload, sourceService)` is the single authority: the writer calls it before writing, and audit-service calls it
(through `validateAuditEvent`) before storing. Strict: unknown fields refused at every level, no trimming, case folding, coercion or
repair; values are ASCII grammars at least as strict as the Stage 18.3 table's CHECKs; `code` changes are closed enumerations. A refusal
is an `AuditContractError` whose `code` (= `message`) is one of `AUDIT_REFUSALS` and never contains the refused value. On success it
returns a new, deep-frozen canonical payload built from validated primitives only.

## Versioning and rollout

- The contract version is the kit envelope `version` (1). The payload has no version field. `SUPPORTED_AUDIT_VERSIONS = [1]`; any other
  version is refused (`unsupported_version`), never read as 1.
- Additive, optional catalog changes (a new action, a new optional change key) keep version 1; a breaking payload change is version 2,
  and audit-service then accepts N and N − 1 during the rollout (ADR-0049 A50).
- **Deploy audit-service with the new catalog first, then let a producer emit the new action.** A producer running ahead is refused by
  its own writer only if its copy of the package lacks the action; if audit-service is behind, the event is dead-lettered
  (`unknown_action`) and replayed after audit-service is upgraded: never lost, never stored as "unknown".
- Actions are never renamed or edited in place (A13): a rename is a new action plus a deprecation.

## Adding an action

A reviewed change to `src/catalog.ts`, justified against the ADR-0049 A7 selection rule (security posture, authority, ownership or
lifecycle of an important object, money, privileged intervention — attributable to a verified actor), then
`npm run catalog:doc -w @nawara/audit-contract` (a unit test fails while the document and the catalog differ).

## Test

```bash
npm run build -w @nawara/audit-contract
npm test -w @nawara/audit-contract                        # catalog, contract matrix, adversarial, envelope, writer (no services)
TEST_DATABASE_ADMIN_URL=postgres://… npm run test:integration -w @nawara/audit-contract   # real PostgreSQL + kit outbox / relay
```

audit-service's `test/contract-persistence.e2e-spec.ts` proves every action against the real `audit_record` table.
