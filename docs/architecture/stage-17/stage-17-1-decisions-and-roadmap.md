# Stage 17.1 — File Service architecture and decisions

- **Status:** design only (no code, no migration, no dependency). **Architecture frozen:** F16 decided by the owner (§3); only
  production-enablement choices remain (§8).
- **Documents:** [ADR-0048](../../adr/0048-file-service-architecture.md) (Accepted), [file-service SDD](../../sdd/file-service.md) (Draft).
- **Principle:** business services own the meaning and the relationship of a file; File Service owns the file object, its storage
  lifecycle, its integrity and controlled access to its bytes.

## 1. Investigation

**Repository baseline:** `main` at `9af757f` (Stage 16 closed). Services: auth, organization, billing, payment, notification, ai.
Shared: `libs/service-kit` (config, logging, request context, errors, health, service auth, DB and migrations, outbox / inbox,
rate limiting, poll loops).

**Existing capability:**

| Capability | Location | Owner | Production use | Reusable | Conflict |
|---|---|---|---|---|---|
| file or storage code | none | — | — | — | — |
| `multer` / `busboy`, `file-type` | transitive (`@nestjs/platform-express`, `@nestjs/common`) | NestJS | unused | busboy / multer are not needed for raw streamed bodies; `file-type`-style magic detection may be reused in 17.5 (decided then) | none |
| "bucket" matches | `kit_rate_limit` buckets | service-kit | yes | unrelated to storage | none |
| service tokens, caller policy, keyed request hash, `PollLoop`, `SKIP LOCKED` batches, rate limiter, readiness, bounded drain | service-kit, notification-service | Core | yes | **yes**, as-is | none |
| Core ADD `file-service` row, O2 (storage provider open), events `file.uploaded` / `file.deleted`, API prefix `/file` | `core-architecture.md` | Core | design | yes | the planned `file → auth` synchronous call: **rejected** with F16 (§3) and removed from the ADD |
| Billing SDD §36.5 / §36.7: PDFs → file-service; "short-lived File Service URL" after Billing authorizes | `billing-service.md` | Billing | design | yes | none (it matches option C, §3) |
| Notification attachments by `fileId`, fetched at send time | ADR-0046 §16, Notification SDD §15 | Notification | design | yes | none |

**Consumers:** Drive documents and photos, Billing PDFs and logos, Notification attachments, future Security / Admin exports. All are
documents and images in the megabyte range; none needs resumable or multi-gigabyte transfer (SDD §2).

## 2. Decision ledger

| ID | Question | Decision | Rationale | Alternatives | Status | Needed before |
|---|---|---|---|---|---|---|
| F1 | Service boundary | Generic file object service; no business references, types or versions; binaries never in PostgreSQL | Core rule (generic services); Billing / Drive keep meaning | per-product storage; document-management service | DECIDED | — |
| F2 | Ownership / tenancy | `ownerService` = token caller (immutable); `organizationId` optional, asserted within caller policy `none` / `request`; opaque `createdBy`; platform files allowed; no Company / Product knowledge | the Notification pattern (ADR-0042 policies); File cannot verify business ownership | organization mandatory (breaks platform files); File verifying users (§3 B) | DECIDED | — |
| F3 | Metadata model | SDD §3: server-derived type, size, checksum, key; caller-provided name (sanitized), declared type, organization, actor ref; key and provider never exposed | clients must not choose physical placement | client-chosen keys / paths | DECIDED | 17.3 |
| F4 | Business-reference ownership | Products own the relationship (`StudentDocument.fileId`); File keeps only an **attach** flag (temporary vs attached) and the owner; no reference table, no cross-service foreign key | deletion safety comes from owner-only delete + attach, not from knowing the resource | `file_reference` table (couples File to product models) | DECIDED | — |
| F5 | Storage abstraction | `StoragePort` (put-stream / get-stream / head / delete), normalized errors, `AbortSignal`, no SDK types in the domain | provider independence; bounded I/O | SDK in the domain | DECIDED | 17.4 |
| F6 | Production storage | **S3-compatible**, provider chosen before production enablement (O2) with a vendor ADR (§5); SSE at rest required | the port makes the choice cheap to defer; no production data yet | choose now | DEFERRED: owner (O2) | production enablement |
| F7 | Local storage | Filesystem adapter (configured root, key grammar, no user path), refused in production; MinIO container for the S3 adapter tests | deterministic tests; no accidental production use | in-memory only (does not test streaming) | DECIDED | 17.4 |
| F8 | Upload model | **PROXY** through File Service, streamed, `Content-Length` required, no buffering | documents / images only; one enforcement point for size, type, checksum and the future scanner; fewest states | direct signed (more states, finalize protocol, weaker validation); hybrid (two paths without evidence) | DECIDED (direct upload = later additive option for large media) | 17.5 |
| F9 | Download model | **PROXY STREAM** through File Service; no presigned storage URLs in V1 | safe headers (§9) applied by File; buckets stay private; revocation is immediate | signed storage URLs (header control and revocation weaker) | DECIDED | 17.6 |
| F10 | Lifecycle | SDD §5: `UPLOADING`, `VERIFYING`, `AVAILABLE`, `REJECTED`, `FAILED`, `DELETING`, `DELETED` + attach flag | derived from the proxy model; every crash window has a state | fewer states (hides partial uploads) | DECIDED | 17.3 / 17.5 |
| F11 | Immutability / versioning | Immutable after `AVAILABLE`; no generic versioning (products own document versions) | checksum, caching, audit and attachment snapshots become trivial | mutable files; File-level versions | DECIDED | — |
| F12 | Checksum | SHA-256 computed by File while streaming; optional client `Content-Digest` compared; provider checksum as a second check; never authorization or dedupe | integrity and corruption detection | trust the client checksum | DECIDED | 17.5 |
| F13 | Content type | Magic bytes decide; declared type and extension must agree; V1 allow-list PDF, JPEG, PNG, WebP, HEIC/HEIF; everything else refused; policy may narrow | a renamed executable is never a PDF | trust `Content-Type` / extension | DECIDED (allow-list extension: owner) | 17.5 |
| F14 | Filenames | SDD §8 (NFC, controls / bidi / separators removed, 255 bytes, RFC 6266 / 8187 encoding); personal data, not logged | presentation only; header-injection-proof | raw names | DECIDED | 17.5 / 17.6 |
| F15 | Authorization ownership | Products authorize users against business resources; File authorizes **callers** (policy + owner + organization match); File never calls product services | File cannot know business permissions | File calling products; File checking only org membership | DECIDED (with F16) | — |
| F16 | End-user access to bytes | **Option C: product-issued short-lived access tickets** (opaque, server-side, one file or one upload intent, one operation, bound to the issuing owner service and the organization, 60–300 s) redeemed on File Service; **Option A** service-token routes kept for trusted internal services; **Option B** (user token → File → synchronous Auth membership) **rejected** | exact product authorization; no double proxy; no `file → auth`; Auth outages do not gate downloads; matches Billing SDD §36.7 | A only; B | **DECIDED (owner, 2026-09-24)** | 17.3 (table), 17.5 / 17.6 |
| F17 | Deletion | Owner-only; logical (`DELETING`) then asynchronous physical delete with retries; idempotent; tombstone row kept; no un-delete in V1 | DB and storage are not transactional; audit keeps the tombstone | immediate hard delete | DECIDED | 17.7 |
| F18 | Orphans | Temporary until attached; `FILE_ATTACH_TTL` (default 24 h) then cleanup; upload-lease sweep for crashed uploads | abandoned uploads cannot accumulate | no expiry | DECIDED (TTL value: owner may adjust) | 17.7 |
| F19 | Malware scanning | Architecture hook (`VERIFYING`, quarantine) in V1; **whether a scanner is mandatory before production user uploads is an owner / security decision** | the allow-list (no executables, archives, Office) removes the worst classes; scanning needs a product choice | mandatory scanner now | PENDING OWNER | production enablement |
| F20 | Encryption | TLS in transit; provider SSE at rest required; no application-level crypto in V1 | no concrete requirement for custom crypto | per-file envelope encryption | DECIDED | — |
| F21 | Quotas | Configuration limits only (global ceiling, per-caller `maxBytes`); per-organization storage quotas later as derived configuration, never a synchronous Billing call | avoid coupling to Entitlement | Billing lookup per upload | DECIDED (quotas: future) | — |
| F22 | Idempotency | `Idempotency-Key` + keyed request hash (dedicated HMAC key) on service uploads; single-use tickets; attach / delete idempotent by state | Core convention; keyed because declared metadata can be guessable | unkeyed hash; none | DECIDED | 17.5 |
| F23 | Retention | Files live until their owner deletes them; tombstones kept; orphan and ticket expiry as above; legal retention durations are owner / legal (as Notification D10) | no invented legal rules | fixed durations | DECIDED (durations: owner / legal) | — |
| F24 | Audit integration | `file.uploaded / attached / deleted / rejected` via the kit outbox (ids only) when Stage 18 needs them; access-denied and sensitive-download events designed with Stage 18 | Core event catalog | publish nothing | DECIDED (timing: 17.9 or Stage 18) | Stage 18 |
| F25 | Notification attachments | Notification sends `fileId`s; the file's owner grants Notification a time-bound read **delegation**; Notification streams at send time, never stores bytes or storage keys; attachments must be `AVAILABLE`, email-sized and type-limited; a deleted file fails that delivery terminally | owner authorizes; File enforces | Notification copies bytes; storage credentials in Notification | DECIDED (direction); built after File V1 | attachments stage |
| F26 | Readiness | `/ready` = database + migrations; storage not a readiness dependency; storage health is a separate signal | a correlated external outage should not remove every instance; per-request 503 is precise | storage in readiness | DECIDED | 17.2 |
| F27 | Observability | Structured signals + `file_ops_snapshot` (SDD §15); no filenames, keys, tokens, URLs | Core has no metrics platform | new metrics stack | DECIDED | 17.9 |
| F28 | Reconciliation | Bounded workers (lease sweep, orphan expiry, delete retries) + an operator reconciliation tool (missing objects, keyless objects); no continuous full-bucket scanner in V1 | cost and simplicity; the states make divergence rare | continuous scanner | DECIDED | 17.7 |
| F29 | Size limits | Global ceiling `FILE_MAX_BYTES` (default 25 MB, bounded ≤ 100 MB), per-caller `maxBytes` ≤ ceiling, per-ticket limit; callers never raise their own | documents / images | per-request sizes | DECIDED (values: owner may adjust) | 17.2 |
| F30 | File ids and keys | UUID v4 ids (Core convention); opaque keys `<prefix>/<fileId>/<random>`; `fileId` ≠ key; neither is authorization | no new id standard | content-addressed keys | DECIDED | 17.3 |
| F31 | Timeouts / retries | connect ≤ 2 s, idle-stream 30 s, transfer bound from size; retries only head / get-before-first-byte / delete | no unbounded SDK defaults (the 16.8 lesson) | SDK defaults | DECIDED | 17.4 |
| F32 | Rate limiting | Kit limiter per caller and per organization (uploads, ticket issuance); ticket redemption failures per ticket; client IPs only as keyed HMACs if ever used (the D21 lesson) | abuse and cost | none | DECIDED | 17.8 |
| F33 | Deduplication | None (no cross-tenant or content-addressed storage) | privacy and deletion simplicity | global dedupe | DECIDED | — |
| F34 | Backup / DR | Database backups and provider durability / object versioning are operational prerequisites; restore must pair metadata and bytes (a restored row without its object is `file_content_missing`, surfaced by reconciliation) | documented, not built | — | DOCUMENTED | production enablement |
| F35 | Ticket form | **Opaque server-side tickets** (random 32 bytes, SHA-256 digest stored, bindings in a row) — not signed self-contained tokens | redemption reads the file row anyway; immediate revocation, true single use, no signing-key rotation, shared-database scaling (SDD §11.1) | signed tokens (revocation list, key rotation, still stateful for single use) | DECIDED | 17.3 / 17.6 |
| F36 | Ticket use and leakage | Upload tickets single-use; download tickets reusable until expiry by default (optional single-use); revocable; tokens only in the redemption path, never logged, `Referrer-Policy: no-referrer`, `no-store`; one generic `ticket_invalid` | mobile retries vs replay window kept short | single-use downloads only (breaks retries) | DECIDED | 17.5 / 17.6 |

## 3. End-user access to bytes (F16) — decided

**Owner decision (2026-09-24): Option C accepted, Option A retained for internal services, Option B rejected.**

```text
Browser / mobile
      ↓
Product service ── product-specific authorization (may this user see this student's passport?)
      ↓  service token
File Service ── issues a narrowly scoped ticket (one file or one upload, one operation, short expiry)
      ↑
Browser / mobile ── redeems the ticket on File Service ── File validates it and streams the bytes
```

| | A. Service-only | B. User JWT + `file → auth` | **C. Product-issued tickets (accepted)** |
|---|---|---|---|
| How | clients talk only to the product; the product streams bytes with its service token | clients call File with their user bearer; File asks Auth about organization membership | the product authorizes the user, then gets a ticket bound to one file / upload and one operation, 60–300 s; the client redeems it on File |
| Authorization quality | exact (product) | **coarse**: intra-tenant IDOR once an id leaks | exact, enforced per file |
| Bytes through the product | yes | no | no |
| Public surface on File | none | user routes | one redemption route |
| Synchronous dependency | none | `file → auth` on every access | none |
| Outcome | **retained** for trusted internal services (Billing PDFs, Notification attachments, workers) | **rejected**: membership cannot authorize a business resource; Auth would gate every download | **accepted** for end users |

**Rules frozen with the decision:**
- File Service never calls Auth (or any product service) to authorize byte access; a user token is never presented to it.
- A ticket is not a general credential: a download ticket cannot upload, delete or read metadata; an upload ticket creates one file
  within its limits and cannot touch an existing file; no ticket issues tickets.
- Tickets are **opaque and server-side** (F35): only a SHA-256 digest of the 32-byte random token is stored with its bindings
  (operation, file or upload intent, issuing owner service, organization, expiry, use state). Every binding and the file's status
  are re-checked at redemption, so authorization never rests on secrecy alone.
- Upload tickets are single-use; download tickets are reusable until their short expiry (optional single-use); both are revocable
  (F36). Tokens are never logged.
- The exact TTL default (within 60–300 s) and the redemption rate limits are frozen in 17.6.

## 4. Stage roadmap (validated; adjusted)

| Stage | Scope | Notes |
|---|---|---|
| 17.1 | architecture and decisions | this record |
| 17.2 | service foundation: NestJS skeleton on the kit, config (limits, policy parse, keys), health / ready, service auth, DB provisioning (`file_migrator` / `file_app`), Dockerfile, Compose, CI | as planned |
| 17.3 | persistence and metadata: `file` and `file_access_ticket` tables, state and attach constraints, triggers (immutability, transitions), indexes for the sweeps | delegation table with Notification attachments |
| 17.4 | storage port: filesystem and S3-compatible adapters, bounded timeouts, normalized errors, MinIO adapter tests | before any upload |
| 17.5 | upload lifecycle: service streamed upload, size cut-off, magic-byte type check, SHA-256, idempotency, attach, lease sweep; **upload tickets** (issue, single-use redemption) | **moved here:** content validation and checksum belong to upload correctness, not to 17.8 |
| 17.6 | download and authorization: streamed download, safe headers, owner / organization checks, **download tickets** (issue, redeem, revoke, TTL default, redemption rate limits, log redaction) | |
| 17.7 | delete and cleanup: logical delete, delete worker, orphan expiry, reconciliation tool | |
| 17.8 | security and integrity: threat-model verification (§6), rate limits, scanner hook (`VERIFYING`), filename / header fuzzing, leak scans | narrowed (validation moved to 17.5) |
| 17.9 | operational hardening: signals, snapshot, runbooks, key / credential rotation, outbox events if Stage 18 needs them, production image | |
| 17.10 | focused certification | File only; Stage 22 stays the Core validation |

## 5. Production storage investigation (O2 / F6; not chosen here)

| Criterion | AWS S3 | Cloudflare R2 | EU S3-compatible (OVHcloud, Scaleway, …) | Self-hosted (MinIO / Ceph) |
|---|---|---|---|---|
| API | reference S3 | S3-compatible (subset) | S3-compatible | S3-compatible |
| Egress | charged | no egress fees | varies | own bandwidth |
| Region / residency | EU and Middle East regions | automatic / jurisdiction options | EU | anywhere, including Tunisia |
| Durability | very high, managed | managed | managed | **operator-owned** (replication, disks, backups) |
| Encryption at rest | SSE (managed keys / KMS) | at rest by default | provider SSE | operator |
| Lifecycle rules, versioning | yes | lifecycle yes | varies | yes |
| Operational load | low | low | low | high |
| Lock-in | moderate (only S3 API used) | low | low | none |

The port uses only put / get / head / delete, so any row works. The choice needs data this repository does not have: data-residency
requirements for Tunisian customers' documents, expected volume and egress, cost and hosting policy. **Decision checkpoint:** a vendor
ADR before production enablement (17.9 / 17.10 enablement checklist). Implementation proceeds against MinIO and the filesystem adapter.

## 6. Threat model

| Threat | V1 mitigation | Future | Residual |
|---|---|---|---|
| Guessed `fileId` (IDOR) | owner-only + organization match; 404 on mismatch; tickets per file | — | none known |
| Cross-tenant access | organization recorded immutably and checked on every call; no cross-tenant dedupe | per-organization keys | product passing a wrong `organizationId` of its own tenant |
| Path traversal | keys server-generated, grammar-validated; names never paths | — | none |
| Malicious filename | sanitization + RFC 8187 encoding; not logged | — | display spoofing within printable Unicode |
| MIME spoofing | magic bytes decide; declared / extension must agree | deeper format validation | polyglot files inside allowed types |
| Malware | allow-list without executables, archives, Office; `VERIFYING` hook | scanner (F19) | malicious PDF / image payloads until a scanner exists |
| Oversized upload | `Content-Length` required; stream cut at the limit | per-organization quotas | — |
| Zip / archive bomb | archives refused | if archives are allowed later: bounded expansion | — |
| Storage credential leak | env / `*_FILE` only, never logged or stored; least-privilege bucket policy | rotation runbook (17.9) | a compromised host |
| Signed URL / ticket leak | short TTL, one file, one operation, token stored as HMAC, never logged; single-use uploads | revocation list | reuse within TTL (downloads) |
| Signed URL replay | TTL; upload tickets single-use | — | download replay within TTL |
| Checksum spoofing | File computes its own; client digest only compared | — | — |
| Orphan storage abuse | attach deadline, cleanup, per-caller rate limits and size ceilings | quotas | — |
| Upload flooding | rate limits per caller / organization; bounded concurrency | — | — |
| Download amplification | rate limits; no Range in V1 | CDN for public content (none planned) | bandwidth cost |
| Header injection | one Content-Disposition encoder; no raw names in headers | — | — |
| Inline XSS | attachment by default; inline only for images; `nosniff`; CSP sandbox | separate download origin | — |
| Storage / DB inconsistency | states + lease sweep + delete retries + reconciliation tool | continuous reconciliation | detection latency |
| Race during delete | state machine with conditional transitions; downloads only from `AVAILABLE`; an in-flight stream may finish | — | a download started just before a delete completes |
| Unauthorized service caller | service tokens + deny-by-default policy per operation | — | a compromised caller token acts as that caller |

## 7. Future integration contracts (not built)

- **Drive:** `StudentDocument`, `Contract`, `ExamEvidence` each hold a `fileId`; Drive authorizes users, issues upload / download
  tickets (its workers may also use the service routes), attaches after its write, deletes when its record goes; versions are new files.
- **Notification:** a request carries `fileId`s; the owner delegates read to Notification; Notification streams at send time (never
  bytes at rest, never keys, credentials or public URLs); a missing / deleted file fails the delivery terminally.
- **Billing:** uploads rendered PDFs as the owner, attached at creation; keeps the SHA-256 and compares it; downloads through its own
  authorization and a download ticket.
- **Audit (Stage 18):** `file.uploaded / attached / deleted / rejected` events (ids only); access-denied and sensitive downloads
  designed there.

## 8. Owner decisions, risks and carryovers

- **Architecture:** nothing open. F16 decided (§3); ticket form and use rules decided (F35 / F36).
- **Before production enablement:** F6 storage provider (vendor ADR), F19 malware policy, F34 backup / DR, bucket and credential
  setup.
- **Owner may adjust:** F13 allow-list (Office formats would need macro / archive handling first), F29 limits (25 MB, ≤ 100 MB),
  F18 attach window (24 h), F23 legal retention.
- **Carried:** Core-wide API naming (`/file` prefix per the Core ADD) to 21.R1; Notification attachments after File V1.
