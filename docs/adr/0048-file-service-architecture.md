# 0048. File Service architecture

- **Status:** Accepted (2026-09-24, Stage 17.1; F16 decided by the owner: product-issued access tickets)
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
