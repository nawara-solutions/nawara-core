# 0048. File Service architecture

- **Status:** Accepted (2026-09-24, Stage 17.1; F16 decided by the owner: product-issued access tickets)
- **Amended:** **Amendment 1 (2026-10-25, Core V2 OD-FILE, decisions F1 to F8 approved by the owner)** at the end of this ADR adds evidence grants, holds and the ticket reservation lease direction. The ADR **stays Accepted**; the original text is unchanged; nothing in it is narrowed or replaced.
- **Date:** 2026-09-24
- **Deciders:** Anwar (project owner)
- **Related:** [ADR-0032](./0032-database-per-service-on-a-shared-server.md) (database per service), [ADR-0033](./0033-service-to-service-authentication-and-user-identity.md)
  (service tokens; user identity only through Auth), [ADR-0034](./0034-shared-service-kit-and-api-conventions.md) (service-kit, API
  conventions, `Idempotency-Key`), [ADR-0037](./0037-reliable-events-outbox-inbox.md) (outbox), [ADR-0042](./0042-service-token-scopes-and-administrative-authorization.md)
  (per-caller policy), [ADR-0046](./0046-notification-service-architecture.md) (future attachments). Design detail:
  [file-service SDD](../sdd/file-service.md). Decisions and roadmap: [Stage 17.1](../architecture/stage-17/stage-17-1-decisions-and-roadmap.md).

## Context

Several Nawara capabilities need stored files: Nawara Drive (student, instructor and school documents, contracts, evidence),
Billing's future rendered invoices (Billing SDD §36.5: "bytes → file-service → an Invoice Document record in Billing"), Notification's
deferred email attachments (ADR-0046 §16), and later exports. No file or storage code exists in the repository; the Core ADD reserves
`file-service` ("Where is this file and who may read it?") and leaves the object-storage provider open (O2).

The risk this ADR guards against runs in both directions: products owning buckets, keys and credentials (every product re-solving
storage, integrity and access), or File Service learning every product's business model (who may see student X's passport).

## Options considered

1. **Each product stores its own files** (its own bucket, keys and credentials). Rejected: storage security, integrity, cleanup and
   provider coupling would be solved once per product; Billing, Notification and Drive would each hold storage credentials.
2. **A document-management service** that knows document types, versions and business references. Rejected: it becomes a
   product-domain database and couples Core to Drive's model (the Core rule: generic services only).
3. **A generic File Service (chosen):** products keep the business meaning and the relationship (`StudentDocument.fileId`); File
   Service owns the file object: immutable bytes, metadata, integrity, lifecycle, storage and controlled byte access.

## Decision

**1. Boundary.** A file is `fileId` → immutable bytes + generic metadata. File Service never stores business references, document
types or versions; a product's "document version" is a new `fileId` held by the product. Binaries never go into PostgreSQL.

**2. Ownership.** Every file has an **owner service** (the authenticated caller that created it, from its service token), an optional
`organizationId` (asserted by the caller within its policy, as in Notification: `none` or `request`), and an optional opaque actor
reference (`createdBy`, for audit only; File Service never verifies users). Platform files without an organization are allowed.

**3. Immutability.** Once available, the bytes of a `fileId` never change (`same fileId = same bytes`, SHA-256 recorded). A change is
a new file. No generic versioning.

**4. Storage.** A provider-neutral `StoragePort` (put-stream, get-stream, head, delete) with bounded timeouts and normalized errors;
an S3-compatible adapter for production (the provider is chosen before production enablement, O2 / F6) and a filesystem adapter for
development and tests (refused in production). Storage keys are opaque, server-generated, never public and never authorization.

**5. Byte path (V1).** Uploads and downloads are **streamed through File Service** (no presigned object-storage URLs in V1): File
Service is the one place that enforces size, verifies content type from the bytes, computes SHA-256, applies safe download headers
and hosts the future malware-scan hook. Direct-to-storage transfer remains an additive later option for large media.

**6. Lifecycle.** Explicit states (`UPLOADING`, `VERIFYING`, `AVAILABLE`, `REJECTED`, `FAILED`, `DELETING`, `DELETED`) and a
separate retention flag: a new file is **temporary** until its owner **attaches** it (after the product's own business write); an
unattached file expires and is cleaned up. Deletion is logical first (tombstone), physical asynchronously with retries. Database and
object storage never share a transaction: every crash window is recoverable by state + reconciliation.

**7. Authorization.** Deny by default; service tokens (ADR-0033) and an explicit per-caller policy (operations, organization mode,
media types, size ceiling). A caller acts only on the files it owns, presenting the file's organization; a guessed `fileId` is a 404.
The product decides whether *a user* may access *a business resource*; File Service never calls product services and **never calls
Auth** to authorize byte access (a user token is never presented to File Service).
- **End users (F16, decided by the owner):** the product authorizes the user against its own resource, then asks File Service (with
  its service token) for a **short-lived access ticket** narrowly bound to one file (download) or one upload intent (upload), one
  operation, the issuing owner service and the file's organization. The client redeems the ticket directly on File Service, which
  validates it and streams the bytes. A ticket is an **opaque, random, server-side** credential (only its digest is stored), so it is
  revocable, can be single-use, needs no signing keys and survives horizontal scaling through the database.
- **Internal services (Option A retained):** trusted services that handle bytes themselves (Billing's generated PDFs, Notification
  attachments, product workers) use the service-token routes directly, within their caller policy.
- **Rejected (Option B):** user token → File Service → synchronous Auth membership lookup. Organization membership cannot answer
  whether a user may access a specific business resource, and it would make every download depend on Auth.

**8. Readiness.** `/ready` = database + migrations. Object storage is **not** a readiness dependency: an outage fails the byte
operations with `503 storage_unavailable` and is signalled separately, instead of removing every instance at once.

## Consequences

- **Easier:** products store one opaque `fileId` and never proxy bytes for their users (tickets); no File → Auth dependency, so Auth
  availability does not gate downloads; one place for storage credentials, integrity, safe serving, cleanup and the future
  scanner; Billing PDFs, Drive documents and Notification attachments share one contract; immutability makes caching, auditing and
  attachment snapshots trivial.
- **Harder:** File Service exposes one public ticket-redemption route (rate-limited, token never logged); bytes pass through File Service (bandwidth and connections are sized for documents and images, not large media); a
  product must attach a file after its own write or lose it at expiry; deletion is asynchronous.
- **Open (production enablement, not architecture):** the production storage provider (O2 / F6, before production enablement); the malware
  policy (F19, before production enablement); legal retention durations (F23, owner / legal).
- **Follow-up:** the Stage 17.2–17.10 roadmap in the Stage 17.1 record; Notification attachments after File V1 (ADR-0046 §16).

## Amendment 1 (2026-10-25): evidence grants, holds and the ticket lease (Core V2 OD-FILE)

The owner resolved OD-FILE ([D-A2 contract register](../architecture/core-v2-d-a2-contract-register.md) §5.5, FIL-01 to FIL-07) with
decisions F1 to F8. They add to this ADR; they do not change its existing decisions (owner-only service access, product-issued tickets,
the caller policy, deletion). The frozen invariants stay: a grant never widens organization scope; a held file cannot be deleted; tickets
are single-purpose and bounded.

- **F1 (grantor):** only the file's owner service, identified by its verified service token, with the explicit `grant` operation, on its
  own file in its own organization, while the file is `AVAILABLE` and attached. No human, public or third-party issuance; no ownership
  or organization from the request.
- **F2 (purpose and grantee):** a closed vocabulary, each purpose with exactly one grantee: `dispute_evidence` → `payment-service`
  (PAY-10), `surplus_evidence` → `billing-service` (BIL-30), `settlement_evidence` → `billing-service` (BIL-32). A grant is bound to one
  file, one organization (the file's), one purpose, one case reference and one grantee; it gives the grantee no general file access.
- **F3 (lifetime):** an explicit expiry, 24 hours by default, at most 7 days; never extended (renewal is a new grant); expired or revoked
  grants are never reactivated or consumed.
- **F4 (holds, S2-File.3):** only the file's owner service places or releases a File evidence hold. Audit's legal-hold authority is not
  carried over.
- **F5 (ticket lease, S2-File.4):** reservation before consumption; the lease duration, commit, rollback and interrupted-stream
  semantics are decided with that slice.
- **F6 (audit):** `file.grant_issued`, `file.grant_revoked`, `file.hold_placed`, `file.hold_released` and `file.granted_read`, written
  through the transactional outbox, never with grant data beyond identifiers, file content or evidence.
- **F7 (this record):** recorded as an amendment, consistent with the ADR status lifecycle.
- **F8 (policy):** `FILE_SERVICE_POLICY` gains `grant` and the caller's `grantPurposes` (deny by default, no wildcard). Losing either
  stops new issuance and revocation; granted reads (S2-File.2) re-check the policy at use.

**Implemented in S2-File.1:** the `file_evidence_grant` table (migration `0004`), issuance (`POST /file/files/{id}/evidence-grants`,
idempotent by `Idempotency-Key`) and revocation (`POST /file/evidence-grants/{grantId}/revoke`), the first two audit actions. A grant is a
record, not a credential: there is no grant secret. Granted reads, holds and the lease are later slices.

**Implemented in S2-File.2:** granted metadata and content reads and grant tickets for the grantee (`read_granted` with `readPurposes`,
the F8 policy dimension on the grantee side), re-checked at every access and at every ticket redemption; `file.granted_read` records each
authorized access (not a delivery). Holds (S2-File.3) and the lease (S2-File.4) remain.
