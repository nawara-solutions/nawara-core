# Stage 17.8 — File security and integrity hardening

- **Status:** implemented and validated on `feat/file-service-security-integrity` (awaiting review).
- **Scope:** adversarial validation of every File Service boundary against the frozen threat model (Stage 17.1 §6), with minimal
  fixes where a boundary did not hold or a control promised for 17.8 was missing: the F32 usage limits, bounded upload concurrency,
  a cap on reusable download tickets, limiter retention, download integrity (SHA-256 verified while streaming), and two file-name
  defects found by fuzzing. Property / fuzz tests, a concurrency pass on both adapters, a 40-mutation campaign, an image probe.
- **Not in scope (and not present):** a malware scanner (decision **B**, §6); dashboards, alerting, SLOs, a production provider,
  backup / DR, credential rotation, capacity tuning (17.9); certification (17.10); the audit trail (Stage 18); public sharing, CDN,
  presigned URLs, multipart, versions, dedupe, thumbnails, OCR; product integrations; route renaming (21.R1 / 21.R2).
- **Frozen design followed:** [ADR-0048](../../adr/0048-file-service-architecture.md), [SDD](../../sdd/file-service.md), the
  [Stage 17.1](./stage-17-1-decisions-and-roadmap.md) decisions (F9, F12, F14, F16, F19, F29, F32, F35) and threat model (§6), and the
  17.2–17.7 records. Where this stage changes an approved behaviour it says so explicitly (§5); no decision is reopened.

## 1. Baseline and findings

`main` at `08e730a` (Stage 17.7 merged, PR #111). Seven findings; each is resolved minimally:

| # | Finding | Kind | Resolution |
|---|---|---|---|
| F-1 | **F32 not implemented.** The threat model's "upload flooding", "orphan storage abuse" and "download amplification" rows and F32 promise per-caller and per-organization limits on uploads and ticket issuance in 17.8; only failed ticket *redemptions* were limited (17.5). | missing control | `UsageLimiter` (§4.1): the kit limiter per caller and per (caller, organization) for service uploads, ticket issuance and service content reads. |
| F-2 | **No bound on concurrent uploads** ("upload flooding: … bounded concurrency"). | missing control | `FILE_UPLOAD_MAX_IN_FLIGHT` per process (§4.2), checked before any row, ticket claim or storage call: `503 upload_busy`, nothing consumed. |
| F-3 | **A leaked reusable download ticket was an unlimited download** for its lifetime (≤ 300 s): amplification. | missing control | `FILE_TICKET_MAX_DOWNLOADS` (§4.3), enforced by the redemption's own conditional `UPDATE` (no schema change). |
| F-4 | **Same-size tampering was served.** 17.6 checked the stored size (and an early / late end) but not the bytes: an object altered in place was streamed as the file its `ETag` names. | integrity gap | The download recomputes SHA-256 and holds the last chunk back until it matches (§4.4, the upload's `VerifiedBody` rule). |
| F-5 | **Bidi marks passed the name sanitizer.** It removed U+202A–202E and U+2066–2069 but not the other three Unicode `Bidi_Control` characters (U+061C, U+200E, U+200F), nor U+2028 / U+2029 / U+FEFF. | defect (F14) | The sanitizer and the Content-Disposition encoder remove `\p{Cc}`, `\p{Bidi_Control}`, U+2028, U+2029, U+FEFF; migration **0003** adds the schema's last-line check (§4.5). |
| F-6 | **A hostile name could cause an opaque 500 (fuzz finding).** The sanitizer normalized to NFC *before* removing controls; removing a control between a letter and its combining mark (`e U+0007 U+0301`) left a non-NFC name, which the schema refuses. | defect | Remove first, then normalize (§4.5); an end-to-end test uploads that exact name (201, `é.pdf`). |
| F-7 | **Limiter rows were never removed.** The redemption limiter (keyed client addresses) and the new usage limiter grow `kit_rate_limit` without bound. | hygiene | The cleanup pass deletes expired windows of this service's buckets only (§4.6), the Notification 16.9 rule. |

Everything else attacked in §3 held without change.

## 2. Threat-model traceability (Stage 17.1 §6, every frozen threat)

"Proven" = an automated test fails if the control is removed (most are also killed mutations, §7.3). "Residual" = accepted risk
that remains after the V1 control.

| # | Threat (17.1 §6) | Control in code | Evidence (tests; mutations) | Status | Residual |
|---|---|---|---|---|---|
| T1 | Guessed `fileId` (IDOR) | `findOwned` = id + owner + organization in one query; UUIDv4 ids; malformed ids never reach SQL; one 404 body | download / deletion "non-disclosure" suites; attach 404; M27 | Proven | none known |
| T2 | Cross-tenant access | `organizationId` immutable (trigger), checked on every read / ticket / delete; ticket bindings re-checked at redemption; no dedupe | repository "org A never reaches org B"; download / deletion non-disclosure; M27 | Proven | a product passing a wrong organization *of its own tenant* (17.1) |
| T3 | Path traversal | server-generated keys (`<prefix>/<uuid>/<32 hex>`), grammar-checked by both adapters; filesystem containment; `O_NOFOLLOW`; `/proc/self/fd` recheck | storage-key fuzz (10 000 keys), filesystem symlink / escape suite (17.4); M34 | Proven | filesystem adapter: check-to-link window if the root is writable by others (17.4, dev only) |
| T4 | Malicious filename | sanitizer (now every bidi control, F-5; order fixed, F-6) + one RFC 6266 / 8187 encoder; names never logged; DB CHECK (0001 + 0003) | 20 000-name sanitizer property, 20 000-name Content-Disposition property, e2e hostile names, RLO `.exe` refused; M21–M24, M37 | Proven | visual confusables within printable Unicode (homoglyphs) |
| T5 | MIME spoofing | signature at offset 0 decides; declared type and extension must agree | detection fuzz (10 000 heads), adversarial samples, polyglot tests; M36, M37 | Proven | polyglots inside allowed types (§3.5) |
| T6 | Malware | allow-list without executables, archives, Office, HTML, SVG; attachment + sandbox CSP; `VERIFYING` state reserved | adversarial sample suite (17.5); polyglot serving test | **Deferred (B, §6)** | malicious PDF / image payloads until a scanner exists |
| T7 | Oversized upload | `Content-Length` required; refused before the claim when over the limit; the Meter cuts the stream at the limit; per-caller `maxBytes`; `FILE_MAX_BYTES` ≤ 100 MiB | upload size suites, framing test (§3.3) | Proven | per-organization storage quotas (not in V1) |
| T8 | Zip / archive bomb | archives refused (no decompression anywhere) | adversarial samples (zip, gzip, rar, docx) | Proven | — |
| T9 | Storage credential leak | env / `*_FILE` only; never logged, echoed or stored; SDK logger silenced; errors normalized | config and process suites, S3 failure suite, image probe leak scan | Proven | a compromised host; rotation runbook is 17.9 |
| T10 | Ticket leak | 256-bit CSPRNG token, digest-only storage, never logged, `no-referrer`, `no-store`, TTL 60–300 s, one file, one operation; **reusable cap (F-3)** | ticket suites (17.5 / 17.6), entropy / shape property, log scans, cap test; M12–M14, M33 | Proven | reuse by a thief within TTL and the cap |
| T11 | Replay | upload tickets single-use (atomic claim); download tickets single-use on request, capped otherwise | 20-way concurrency tests (both paths), cap concurrency test | Proven | download replay within TTL and the cap |
| T12 | Checksum spoofing | SHA-256 computed by File; client `Content-Digest` only compared; `sha256` set once (trigger); **verified again on every download (F-4)** | upload digest tests; tamper tests (filesystem and S3); M18, M19 | Proven | — |
| T13 | Orphan storage abuse | attach deadline + expiry, lease sweep, **per-caller / per-organization upload limits (F-1)**, size ceilings | 17.7 worker suites; usage-limit tests; M5, M1–M4 | Proven | quotas (not in V1) |
| T14 | Upload flooding | **usage limits (F-1)**, **in-flight bound (F-2)**, idle timeout, request timeout | usage-limit and concurrency-bound tests; M1–M6, M10, M25, M26 | Proven | a flood inside the budgets costs storage until expiry |
| T15 | Download amplification | no Range; **service-read limits (F-1)**; **reusable-ticket cap (F-3)**; backpressure; idle timeout | Range test (17.6), read-limit and cap tests; M8, M12–M14 | Proven | bandwidth inside the budgets; no per-process download concurrency bound (17.9 capacity) |
| T16 | Header injection | one Content-Disposition encoder; no raw name in any header; header values validated | Content-Disposition property (20 000); 17.6 CR/LF test | Proven | — |
| T17 | Inline XSS | attachment default; inline only for images and only on request; `nosniff`; `CSP: default-src 'none'; sandbox` | polyglot serving test (PDF+HTML, PNG+HTML); M30–M32 | Proven | a separate download origin is not used (17.1) |
| T18 | Storage / DB inconsistency | states, lease sweep, delete retries, reconcile tool; size check; **digest check (F-4)**; `file_storage_inconsistent` signal | 17.7 reconcile / sweep suites; tamper tests; M18–M20 | Proven | detection only on read or on a reconcile run (no continuous scan) |
| T19 | Race during delete | conditional transitions; downloads only from `AVAILABLE`; issuance holds `FOR SHARE`; revocation in the deletion transaction | 17.7 race suites | Proven | a stream authorized just before the delete may finish |
| T20 | Unauthorized service caller | SHA-256 token digests, deny-by-default policy per operation, organization mode, media types, size | foundation suite; "refused requests spend nothing" | Proven | a stolen caller token acts as that caller (within its policy and budgets) |

## 3. Adversarial validation by boundary

Each line is an attack that was run; the result is what the service did. "New" marks tests added in this stage; the rest are the
17.2–17.7 suites, re-run.

### 3.1 Identity, authorization, isolation

| Boundary | Attack | Result |
|---|---|---|
| Service authentication | no token, malformed, unknown, token of another caller, caller header / query / body spoofing | 401; identity only from the token (foundation) |
| Caller policy | operation not granted, organization mode `none` sending an organization, over-ceiling `maxBytes`, foreign media type | 403 with a stable code; nothing written; **no budget spent (new)** |
| Cross-service | caller B reads / deletes / issues on caller A's file id | the same 404 as a missing file |
| Cross-organization | right owner, wrong organization; no organization for an organization file; organization for a platform file | the same 404 |
| Null / platform scope | platform file read with an organization header; organization file without | 404 both ways (`IS NOT DISTINCT FROM`) |
| UUID probing | random UUIDs, malformed ids, SQL-ish ids | the same 404 body; malformed ids never reach SQL; **service-read probes spend the read budget (new)** |

### 3.2 Capabilities (tickets)

| Boundary | Attack | Result |
|---|---|---|
| Entropy | 10 000 fresh tokens | all distinct, all 43-char base64url (256 bits); new |
| Shape / guessing | 10 000 random strings; unknown / malformed / expired / revoked / used / wrong-operation tickets | only the exact shape is looked up; every failure the same `404 ticket_invalid` |
| Upload capability | 20 concurrent redemptions of one ticket | exactly one file (filesystem and S3) |
| Download capability | 100 concurrent redemptions of a reusable ticket with cap 3; a caller sending a cap field | exactly 3 served, 97 `ticket_invalid`; the field is refused (400); new |
| Token leakage | log scans of every suite; image probe | no token, digest, ticket path or storage key in any log line |
| Redemption abuse | failures past the limit | every redemption refused alike (no oracle); the client address keyed (HMAC) — **proven now** by checking that no row equals the unkeyed digest (new) |

### 3.3 Resource exhaustion and framing

| Boundary | Attack | Result |
|---|---|---|
| Usage limits (new) | uploads / issuance / service reads past the per-organization then per-caller budgets; 20 concurrent issuances | 429 `rate_limited`, nothing created; exactly the budget succeeds under concurrency; other organizations and callers unaffected; the window resets |
| Upload concurrency (new) | a stalled upload holding the only slot; a second upload (service and ticket) | `503 upload_busy`; the ticket is not consumed; the slot returns when the first is cut by the idle timeout |
| Upload size / time | over-limit length, lying length, stall, disconnect, 20 MiB stream | refused before the claim / FAILED / bounded memory (17.5) |
| Download | paused client, disconnect, 20 MiB (filesystem), 16 MiB (S3) | backpressure, bounded memory, the store stream destroyed (17.6) |
| Framing (new) | `Content-Length` + `Transfer-Encoding`, two `Content-Length`s, `+n`, `-1`, `1e3`, `0x…`, two `Transfer-Encoding`s | 400 (Node's parser) or 411; never a file |
| HTTP server | headers 60 s, max header 16 KiB, keep-alive 5 s (Node defaults); request bound sized for `FILE_MAX_BYTES` (17.5) | as configured; no connection cap (17.9 capacity) |

### 3.4 Content, names, headers

| Boundary | Attack | Result |
|---|---|---|
| Type detection | 10 000 random heads (new); executables, archives, HTML, SVG, scripts, GIF, AVIF, MP4, truncated / lying headers (17.5) | never a guess: a detected head carries that type's signature at offset 0 |
| Polyglots (new) | PDF + HTML/script; PNG + SVG/script; allowed signature after junk | stored as the leading type; PDF never inline; every response `nosniff` + `sandbox` CSP; a later signature is not a signature |
| File names (new) | 20 000 hostile names (controls, every bidi control, separators, BOM, NFD pairs, astral, long); RLO `invoice‹RLO›fdp.exe` | always NFC, ≤ 255 bytes, trimmed, idempotent, free of unsafe characters; RLO `.exe` refused 422 (the real extension contradicts the bytes) |
| Content-Disposition (new) | 20 000 hostile stored names | one line, three parameters, printable-ASCII fallback without `"` / `\`, RFC 8187 form that decodes to the cleaned name |
| Response headers | every byte route | `private, no-store`, `nosniff`, sandbox CSP, `no-referrer`, `Accept-Ranges: none`, `ETag` = SHA-256; HEAD 405 |

### 3.5 Storage and integrity

| Boundary | Attack | Result |
|---|---|---|
| Storage keys (new fuzz) | 10 000 hostile keys through the grammar and the filesystem containment | no traversal passes; containment refuses every escape |
| Filesystem adapter | symlinked directories, symlinked keys, symlinked temp area (17.4) | refused; never followed |
| Production filesystem | `FILE_STORAGE_PROVIDER=filesystem` with production | refused at boot (config test; image probe) |
| S3 / SSRF | the endpoint is operator configuration only (https in production, no credentials / query / fragment); no request value reaches a URL, bucket or key; no presigned URL exists | nothing to steer |
| Storage error redaction | refused connection, hangs, 5xx, access denied, missing bucket / object (17.4 / 17.6) | normalized `storage_*` codes; no host, bucket, key or provider text in any response or log |
| **Tampering (new)** | same key: **same size, other bytes** (filesystem; S3 one flipped bit) | the response cannot complete: it is terminated before its last chunk (earlier chunks, altered or not, were already sent; a one-chunk file sends nothing); `file_storage_inconsistent reason=digest_mismatch`; the row stays AVAILABLE (reported, never "repaired") |
| Tampering | same key, longer / shorter | `500 file_content_missing` before any byte (`size_mismatch`) |
| Tampering | object missing | `500 file_content_missing` (`object_missing`) |
| DB tampering / privileges | runtime role: DDL, trigger bypass, truncate, hard delete, changing set-once columns (17.3) | refused; only a schema owner / superuser could alter `sha256` (then every download of that file fails the digest check) |

### 3.6 Lifecycle, workers, HTTP surface, operations

| Boundary | Attack | Result |
|---|---|---|
| Lifecycle | every illegal transition; terminal states; `VERIFYING` never served | refused by triggers / CHECKs; downloads only from `AVAILABLE` (17.3 / 17.6) |
| Delete / cleanup / worker / orphans / temp files | races, crashes, leases, fences, absent objects, outages (17.7) | converge; never back to AVAILABLE; no temporary file left |
| Methods (new) | PATCH / PUT / POST on read routes, OPTIONS, TRACE, DELETE on ticket paths | never 2xx |
| CORS (new) | preflight and simple requests from a foreign origin | no `Access-Control-Allow-Origin` (CORS off by default) |
| CSRF (new) | a cross-site form POST to a ticket URL | 404: the upload redemption is PUT (not form-reachable); service routes need a bearer token (never ambient) |
| OpenAPI | mounted only with `SWAGGER_PASSWORD`, behind basic auth (17.2); 429 / `upload_busy` now documented | unchanged exposure |
| Config / secrets | missing / invalid / equal keys, production refusals; `*_FILE`; values never echoed | fail closed (config, process, image probe) |
| Dependencies | `npm audit --omit=dev` (file-service workspace) | 0 vulnerabilities |
| Docker (image probe) | non-root user; `--read-only --cap-drop ALL --security-opt no-new-privileges`; secret scan of image history and logs | see §7.4 |
| Errors | unexpected errors, storage faults | opaque bodies (`statusCode`, `error`, `message`, `code`, `requestId` only) |
| Log injection (new) | CR/LF + forged JSON in a name, key and ticket path | never in a log line; every line one JSON object |
| Metric cardinality | — | no metrics endpoint; log fields are ids, bounded codes and size buckets (never names, keys or paths) |
| Health / readiness (new) | inspect bodies | status and check names only: no version, host, database, storage or pid |

## 4. Changes

### 4.1 Usage limits (F32)

`src/limits/usage-limiter.ts`. The kit's Postgres-backed fixed-window limiter (correct across replicas), one-minute windows:

| Kind | Charged on | Per caller | Per (caller, organization) |
|---|---|---|---|
| `upload` | `POST /file/files` (replays count) | 600 / min | 120 / min |
| `ticket` | `POST /file/uploads/tickets`, `POST /file/files/{id}/tickets` (one shared budget) | 1 200 / min | 300 / min |
| `download` | `GET /file/files/{id}/content` (metadata reads are not charged) | 1 200 / min | 300 / min |

Charged **after** authorization (an unauthorized or policy-refused request spends nothing) and **before** any database lookup or
storage call; every attempt counts, refused ones included (no free probing). The organization budget is keyed by caller *and*
organization: one tenant cannot spend its caller's budget for the others, and one caller cannot spend another's. Platform files are
bounded by the caller budget. Over budget: `429 rate_limited`, nothing created. Keys are hashed by the kit; no token or client address
is used. An organization budget above its caller budget refuses to boot. Ticket redemptions are not charged here: the issuance that
created the ticket was, and redemption failures keep their 17.5 limiter.

### 4.2 Upload concurrency

`FILE_UPLOAD_MAX_IN_FLIGHT` (default 64, per process): a counter in `UploadService`, taken after authorization and the usage limits
and before the ticket claim or the `UPLOADING` row, released exactly once when the upload settles. A full process answers
`503 upload_busy` (retryable); a refused redemption does not consume its ticket.

### 4.3 Reusable download-ticket cap

A reusable download ticket is now bounded by **both** its TTL (60–300 s, unchanged) **and** a use cap:

| Question | Answer |
|---|---|
| Configurable? | yes: `FILE_TICKET_MAX_DOWNLOADS`, server environment only |
| Default / bounds | 50; integer 1–10 000; anything else refuses to boot (`ConfigError`) |
| Can a caller influence it? | no: the issue request has no such field and the DTO whitelist rejects unknown fields (`400`; tested with `maxUses`, `maxDownloads`, `useCount`, `uses`); the value is not stored on the ticket, it is read from configuration at each redemption (lowering it applies at once to live tickets) |
| Atomic? | yes: `claimDownload` is ONE conditional `UPDATE … SET "useCount" = "useCount" + 1 WHERE … AND "useCount" < $cap` (plus the ticket and file checks); PostgreSQL row locking re-evaluates the condition for every waiting claim, so no read-then-write window exists |
| Can concurrency exceed it? | no: 100 concurrent redemptions with a cap of 3 serve exactly 3 (test); the schema trigger also forbids `useCount` moving by more than one per update |
| After exhaustion | `404 ticket_invalid`, the same body as every other unusable ticket (no oracle); the attempt counts as a failed redemption for the keyed-client limiter |
| Single-use tickets | unchanged (one use); the cap applies to reusable tickets |

No schema change.

### 4.4 Download integrity

SHA-256 is now **recomputed during every download** (a change from 17.6, §5). `VerifiedDownload` replaces 17.6's `ByteCounter`: it
counts bytes (short / long still fail) and hashes them as they stream, holding back **only the last chunk** until the digest equals the
recorded `sha256`. There is no whole-file buffering and none was added.

**The exact guarantee:** *an integrity-mismatched download cannot complete successfully; the response stream is terminated before
successful completion.* On a mismatch the connection is destroyed before the last chunk: the client receives fewer bytes than
`Content-Length` and never a normal end of message, and `file_storage_inconsistent reason=digest_mismatch` is logged.

**What it does NOT guarantee:** that no altered byte is transmitted. The mismatch is only knowable once the last byte has been hashed,
so every chunk before the last has already been sent. An alteration outside the last chunk therefore reaches the client, inside a
response that ends short (tested: a forged first chunk is received by the client). Precisely:

| Case | Emitted before detection |
|---|---|
| object larger than one read chunk | the status line, headers, and `size − (last chunk)` body bytes; the last chunk is at most 64 KiB on the filesystem adapter (Node's read-stream chunk) and one HTTP read of the provider response on S3 (the image probe: 188 992 of 200 009 bytes sent, 11 017 held) |
| object that fits in one read chunk | nothing at all: Node sends the headers with the first body write, so the connection closes with no response (tested) |
| object of the wrong size | nothing: `500 file_content_missing` before any byte (17.6) |

A client that verifies `Content-Length` completion (every HTTP client does) or the `ETag` (the recorded SHA-256) cannot mistake a
tampered download for the file. Cost: one SHA-256 pass per download plus one chunk of latency; memory unchanged (the 2 MB whole-body
and 16 / 20 MiB streaming tests still pass). The CPU / throughput cost under concurrent downloads is **not yet measured**: a 17.9 item.

### 4.5 File names

The sanitizer and the Content-Disposition encoder remove `\p{Cc}` (C0, DEL, C1), `\p{Bidi_Control}` (all twelve bidi controls),
U+2028, U+2029, U+FEFF, `/` and `\`, **then** normalize to NFC. ZWJ / ZWNJ are kept (Persian and emoji need them). Migration
`0003_file_name_marks.sql` adds `file_original_name_no_marks` (`NOT VALID`: names are immutable, so only new rows can be checked;
no row outside development predates it). 0001 is not rewritten.

### 4.6 Limiter retention

The cleanup pass (step 5) deletes `kit_rate_limit` rows of this service's buckets whose one-minute window has ended, in a bounded
batch with `SKIP LOCKED`; other services' buckets are never touched. `file_cleanup_pass` reports `limits_purged`.

## 5. Changes to approved semantics (explicit)

| Earlier behaviour | Now | Why |
|---|---|---|
| 17.6: "SHA-256 is **not** recomputed on each download" | recomputed during **every** download; a mismatched download cannot complete (terminated before its last chunk); bytes before the last chunk may already have been sent (§4.4) | T12 / T18: same-size tampering was served as the file its ETag names (F-4) |
| 17.6: download tickets "reusable until expiry" | bounded by **both** the TTL and a server-controlled use cap (`FILE_TICKET_MAX_DOWNLOADS`, default 50, 1–10 000, not caller-settable; §4.3) | T15 / F32 (F-3); within one TTL a legitimate client needs a handful |
| 17.5 / 17.6 routes had no 429 except redemptions | uploads, ticket issuance and service content reads can answer `429 rate_limited`; uploads `503 upload_busy` | F32, T13–T15 (F-1, F-2) |
| F14 / SDD §8: "bidi overrides (U+202A–202E, U+2066–2069)" | every `Bidi_Control` character, U+2028 / U+2029 / U+FEFF | the listed set was incomplete (F-5) |
| F32: "ticket redemption failures per ticket" | per keyed client address (as implemented in 17.5 and approved) | a failure for an unknown ticket has no ticket to count against; recorded here as a discrepancy, not a change |

## 6. Malware scanning: decision **B** (deferred, residual risk accepted for V1)

No scanner is installed (F19 is **PENDING OWNER**, for production enablement). Scanning is not mandatory for this stage and needs no
redesign: the state machine already has `UPLOADING → VERIFYING → AVAILABLE | REJECTED`, `VERIFYING` files are never served (only
`AVAILABLE` is), and the schema requires `mediaType` from `VERIFYING` on. A scanner would add the transition to `VERIFYING` in the
upload finalization and a worker that settles it; no schema or lifecycle change.

Residual risk until then: a malicious **PDF** or **image** (exploit payloads for viewers) can be stored and served. Mitigations in
place: the allow-list excludes executables, archives, Office formats, HTML, SVG and scripts; PDFs are never inline; every download is
`attachment` unless an image, with `nosniff` and a sandbox CSP; no server-side parsing beyond the signature bytes. The decision
whether production user uploads require a scanner stays with the owner (F19) and must be taken before production enablement.

## 7. Evidence

### 7.1 Test suites

| Suite | Result |
|---|---|
| unit (`vitest run`) | 248 passed, 10 files (17.7: 234 / 9) |
| e2e (`test:e2e`, real PostgreSQL 16 + VersityGW v1.8.0) | 281 passed, 16 files (17.7: 257 / 15) |
| `npm run check:repo`, `lint` (oxlint type-aware), `tsc --noEmit` | pass, 0 findings |
| `npm audit --omit=dev` (file-service) | 0 vulnerabilities |

New: `src/security.spec.ts` (10 property / fuzz tests, seeded, 110 000 generated inputs), `test/security.e2e-spec.ts` (22 tests), three `VerifiedDownload` unit tests pinning the exact streaming guarantee,
an S3 tampering test in `download-s3.e2e-spec.ts`, an S3 concurrency test in `upload-s3.e2e-spec.ts`, the limits configuration test.

### 7.2 Concurrency on both adapters

The 17.4 storage contract (two concurrent writes of one key: exactly one wins) runs on both adapters; 20-way single-use redemptions
(filesystem), 100-way capped reusable redemptions (filesystem), 10-way single-use redemptions on S3 (new), 20-way concurrent issuances
against one budget, two-replica delete claims (17.7).

### 7.3 Mutation campaign

40 mutations of the security-relevant code (new and earlier), each applied alone; unit suite plus the security, download,
upload, foundation and S3-download e2e suites run against it; sources restored and SHA-256-verified afterwards. **39 killed, 1
equivalent.**

| # | Mutation | unit failures | e2e failures | outcome |
|---|---|---|---|---|
| M1 | usage limits never refuse | 0 | 5 | killed |
| M2 | organization budget ignored | 0 | 5 | killed |
| M3 | organization budget keyed by caller only | 0 | 2 | killed |
| M4 | caller budget ignored | 0 | 2 | killed |
| M5 | service uploads not charged | 0 | 1 | killed |
| M6 | upload-ticket issuance not charged | 0 | 4 | killed |
| M7 | download-ticket issuance not charged | 0 | 1 | killed |
| M8 | service content reads not charged | 0 | 2 | killed |
| M9 | metadata reads charged too | 0 | 1 | killed |
| M10 | upload charged before authorization | 0 | 2 | killed |
| M11 | read charged before authorization | 0 | 2 | killed |
| M12 | reusable ticket cap removed | 0 | 1 | killed |
| M13 | reusable ticket cap off by one | 0 | 1 | killed |
| M14 | cap not passed at redemption | 0 | 1 | killed |
| M15 | limiter retention ignores the bucket | 0 | 2 | killed |
| M16 | limiter retention deletes live windows | 0 | 1 | killed |
| M17 | limiter retention not run | 0 | 1 | killed |
| M18 | download digest not verified | 0 | 3 | killed |
| M19 | last chunk not held back | 0 | 2 | killed |
| M20 | size pre-check removed | 0 | 4 | killed |
| M21 | sanitizer normalizes before removing | 1 | 1 | killed |
| M22 | sanitizer misses bidi marks / separators (17.7 set) | 2 | 1 | killed |
| M23 | Content-Disposition misses bidi marks (17.7 set) | 1 | 0 | killed |
| M24 | 0003 constraint neutralized | 0 | 1 | killed |
| M25 | upload in-flight cap not enforced | 0 | 1 | killed |
| M26 | upload slot never released | 0 | 9 | killed |
| M27 | findOwned ignores the organization | 0 | 3 | killed |
| M28 | redemption client address unkeyed | 0 | 2 | killed |
| M29 | blocked client still admitted (failure oracle) | 0 | 2 | killed |
| M30 | nosniff removed | 0 | 0 | survived |
| M31 | CSP sandbox removed | 0 | 2 | killed |
| M32 | inline allowed for non-images | 0 | 3 | killed |
| M33 | ticket shape not checked | 8 | 0 | killed |
| M34 | filesystem containment removed | 1 | 0 | killed |
| M35 | filesystem allowed in production | 1 | 0 | killed |
| M36 | PDF signature anywhere in the head | 2 | 0 | killed |
| M37 | extension agreement disabled | 1 | 2 | killed |
| M38 | chunked bodies accepted | 1 | 0 | killed |
| M39 | HEAD not refused on byte routes | 0 | 2 | killed |
| M40 | one key for two purposes accepted | 1 | 0 | killed |

M30 is **equivalent**, not a gap: the kit's `helmet()` already sends `X-Content-Type-Options: nosniff` on every response, so the
route's own header is a second layer; the tests assert the header, which stays present (the image probe shows it on `/health`).

### 7.4 Image probe

Throwaway PostgreSQL (with the `infra/postgres/init` roles) and VersityGW; the production image built from this branch:

- production refusals (missing / http public URL, missing or reused keys, TTL out of bounds, filesystem store): exit 1, `ConfigError`,
  no value echoed; migrations 0001–0003 applied by the migrator; runs as uid 1000 (`node`), PID 1 `node dist/main.js`;
- store unreachable: upload 503 `storage_unavailable`, download 503, delete 202 (DELETING), `/ready` 200 throughout; docs 404;
- S3 round trip through the image: upload, replay, service and ticket downloads byte-exact with the 17.6 headers, HEAD 405, delete →
  DELETED with the object gone, an executable named `.pdf` refused;
- **17.8:** organization ticket budget 2 → `201 201 429`, another organization 201; reusable cap 2 → `200 200 404`; one bit flipped in
  the bucket (same size) → curl exit 18 (partial body: 188 992 of 200 009 bytes), `digest_mismatch` logged once;
- `--read-only --cap-drop ALL --security-opt no-new-privileges`: live and ready (`{"status":"ok"}`), HSTS / nosniff / frame headers,
  no `X-Powered-By`, TRACE 404, no CORS grant;
- stop in 60 ms, exit 0; 128 log lines: 0 secret / token / digest / name leaks, 0 storage keys; image history: 0 secrets; user `node`.

## 8. Proven, assumed, deferred, residual

- **Proven** (a test fails without the control): T1–T5, T7–T20 as in §2; the fixes F-1 to F-7.
- **Assumed:** PostgreSQL and the S3-compatible provider are trusted infrastructure (a superuser or bucket administrator is out of the
  model); TLS terminates in front of the service; `TRUST_PROXY` is set correctly when a proxy exists (it decides the keyed client
  address of the redemption limiter); product services keep their service tokens secret and authorize their users before issuing
  tickets; the production provider encrypts at rest (F20).
- **Deferred:** malware scanning (B, §6); per-organization storage quotas; continuous integrity scanning (tampering is detected on
  read and by the reconcile tool); a per-process download concurrency bound and connection caps (17.9 capacity); dashboards and
  alerting on `file_storage_inconsistent` / `rate_limited` (17.9); credential rotation (17.9); a separate download origin.
- **Residual:** malicious PDF / image payloads (§6); a stolen reusable ticket used within its TTL and cap; a stolen service token acts
  as its caller within its policy and budgets; homoglyph names; a product passing a wrong organization of its own tenant; bandwidth
  and storage consumed inside the budgets; the filesystem adapter's check-to-link window (development only).

## 9. Configuration (added)

| Variable | Default | Bounds |
|---|---|---|
| `FILE_UPLOAD_RATE_PER_CALLER` / `_PER_ORGANIZATION` | 600 / 120 per minute | 1–1 000 000; organization ≤ caller |
| `FILE_TICKET_RATE_PER_CALLER` / `_PER_ORGANIZATION` | 1 200 / 300 per minute | 1–1 000 000; organization ≤ caller |
| `FILE_DOWNLOAD_RATE_PER_CALLER` / `_PER_ORGANIZATION` | 1 200 / 300 per minute | 1–1 000 000; organization ≤ caller |
| `FILE_TICKET_MAX_DOWNLOADS` | 50 | 1–10 000 |
| `FILE_UPLOAD_MAX_IN_FLIGHT` | 64 per process | 1–4 096 |

Defaults are starting points, not capacity figures; tuning belongs to 17.9.

## 10. Deferred to later stages

- **17.9 (operational follow-ups from this stage):**
  - SHA-256 CPU cost of download verification under concurrent downloads;
  - download throughput impact of the verification (one hash pass, one chunk of latency);
  - download concurrency and connection caps (none per process today);
  - tuning of the reusable-ticket cap (`FILE_TICKET_MAX_DOWNLOADS`);
  - tuning of the upload concurrency cap (`FILE_UPLOAD_MAX_IN_FLIGHT`);
  - tuning of the rate limits (`FILE_{UPLOAD,TICKET,DOWNLOAD}_RATE_PER_*`);
  - and, as before: alerting / dashboards on the new signals (`file_storage_inconsistent`, `rate_limited`, `upload_busy`),
    credential rotation, the production provider decision support.
- **17.10:** focused certification of File.
- **Stage 18:** audit trail of access and refusals.
- **Production enablement:** the F19 scanner decision.
