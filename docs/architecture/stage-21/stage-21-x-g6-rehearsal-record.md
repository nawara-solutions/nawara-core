# Stage 21.x G6 — production-like rehearsal record

- **Status:** RECORD — **APPROVED; G6 CERTIFIED (2026-10-14)**. The owner approved this record by merging it into `main` (PR #311,
  merge commit `64b503095674a8227527c7f0b68819cdf703669d`), as the [G6 plan](stage-21-x-g6-rehearsal-plan.md) §13 requires ("the
  record is complete and approved"). Sections 1–13 are the certified content, unchanged; [§14](#14-certification-and-the-g7-reference)
  records the certification and the G7 reference. The rehearsal result is **PASS**.
- **Gate:** ADR-0040 decision 7, G6 (with the parts of G4 and G5 that ADR-0040 assigns to the rehearsal); plan decision D-14 and §10.
- **Operator:** the Project Owner. **Approver:** the Project Owner (self-approved; no independent second-party approval).
- **Authorizes nothing.** No production step, no digest deployment and no G7, F6 or F7 action follows from this record; each keeps its
  own owner-authorized checkpoint (plan §12, §15.8; [cutover record](stage-21-x-cutover-record.md) §7). Final Core Validation stays
  the absolute last full validation.
- **Related:** [G6 plan](stage-21-x-g6-rehearsal-plan.md) (§15–§21 record the preparation, G6-S1, G6-S2 and G6-BV-S),
  [cutover record](stage-21-x-cutover-record.md), [organization-production runbook](../../runbooks/organization-production.md),
  [core-backup-restore runbook](../../runbooks/core-backup-restore.md).

## 1. Evidence kind

**OWNER-SUPPLIED TERMINAL OUTPUT**, as in plan §16–§21. The owner authorized and ran every step separately, from the owner workstation,
with a hash-pinned script streamed over the pinned two-hop SSH path (owner workstation → `nawara-lab-01` → guest). Every guest step
printed the §17.5 isolation gate at its start and end. This record's author prepared the scripts, tested them locally with
stand-ins and, where noted, PostgreSQL 16.15 fixtures built from the pinned images, and read the owner's saved copy of each complete output; the hashes below are of
those copies.

- **Independently verified by this record's author:** the hash of every output listed here; the consistency of the outputs with each
  other (times, counts, digests, event trails); the §8.2 CI run (§6); the source facts cited from the repository.
- **Reported by the guest scripts, not read independently:** guest database contents, Docker state and the guest-side logs under
  `/home/ubuntu/g6-stack-logs/` on the guest.
- **Owner-reported only:** the production collation capture (§9.1).
- **Retention:** the outputs and scripts are held by the owner outside the repository (plan §11: raw logs until F7 certification + 90
  days; the VM kept stopped through G7 + 14 days). None contains a credential, token, configuration value or production address.

## 2. Environment

| Item | Value |
|---|---|
| Rehearsal environment | guest `g6-rehearsal-01` (Ubuntu 24.04, QEMU/KVM without libvirt, `restrict=on`, `ipv6=off`) on the nonproduction host `nawara-lab-01`; R3 preserved (plan §15.6, §17) |
| Dates (UTC) | G6-BV-S 2026-10-14 09:32–09:58; G6-C 10:09–16:25; G6-D 11:47–17:51 (interleaved with G6-C as each signal's precondition was reached); G6-E 19:40–20:43; G6-F captures 21:11–22:30 |
| Rehearsal Company | `nawara-rehearsal` (plan §5) |
| Rehearsal identities | actor labels `g6-rehearsal-operator` and `g6-rehearsal-approver` inside the rehearsal; they name no person |
| Docker | Server 29.1.3, containerd image store (production: 29.1.3, G6-A) |
| PostgreSQL | 16.15, `postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea` (production: 16.15 on `postgres@sha256:cf78e766…0685`; accepted limitation, plan §16.2; §9) |
| RabbitMQ | 3.13.7, `rabbitmq:3.13.7-alpine@sha256:d7af1c87…52bc` (the production digest, G6-A) |
| MinIO (B3) | the Chainguard digest approved for the isolated rehearsal only (plan §17.4) |

### 2.1 Images and Git revisions

| Service | Rehearsal index digest (plan §16.1) | Revision | Production repository digest (G6-A, 2026-09-30; cutover record §5) | Production running image observed 2026-10-12 (cutover record §14) |
|---|---|---|---|---|
| auth-service | `sha256:5877c6ad5a4a4ac4b7858efce794abf9ba65c5162dc9fc8f569fdef384ec35ed` | `64ad8e3ae57e15170c3d714ddb9bc804626f374d` | `sha256:e6279588ffc4742d356d812858964fdc81903c762c3daa9a71bd00c179c9a7ee` | `sha256:26164d42…5eaf` (legacy image) |
| organization-service | `sha256:61221d5445f46045cfb9fd99ee38b42833568dfb1f577f853699d5f7acb9ca60` | `564a30f` | `sha256:76734d81b620b556b3915ef465fa4ef684af236d3a2e8de61aa039b08514e49d` | `sha256:76734d81…e49d` |
| audit-service | `sha256:785a443169aada802cba82788b4ba1fda6e70676ba2d9e2d45d3bda89eb571ab` | `564a30f` | `sha256:a8dade8c5e4c2bf8efde34d208814d6c441a102bd1c54a9b10ac33dff88e4554` | `sha256:a8dade8c…4554` |

The G6-A values are the repository digests recorded by G6-A; the 2026-10-12 values are the running images the G6 baseline refresh
observed. They are different observations and are not substituted for each other: production Auth drifted after G6-A (cutover record
§10, §11).

The rehearsal identity is the digest set approved for isolated G6 rehearsal use only (plan §16.1). It is **not** a production
deployment authorization; the first production digest deployment of each service stays a separate checkpoint (§11).

### 2.2 Configuration fingerprint (variable names only)

The deploy scripts generate every rehearsal secret on the guest; no value appears in any output. The G6-S2 deployment and inspection
(plan §19.1: `be560eaf…d605`, `5e0b5ac6…529d`) list the configuration names; G6-BV-S check 2 asserted that every `DATABASE_URL`,
`RABBITMQ_URL` and `ORGANIZATION_SERVICE_URL` host is a guest-local container name. Changes during G6-C, each by name:

- F1: the provisioning caller's token digest and its `hierarchy.provision` policy in Organization's `.env`;
- F4: the auth-service caller (`hierarchy.read`, no Platform) in Organization's `.env`; `ORGANIZATION_SERVICE_URL` and its token in
  Auth's `.env`;
- F6: `AUTH_HIERARCHY_SOURCE=organization-service` in Auth's `.env` (source first, plan §15.4 item 1); the rehearsal-only fault line
  `ORGANIZATION_SERVICE_TIMEOUT_MS` added and removed twice, `.env` byte-identical after each removal (cases 3 and 7).

### 2.3 Broker topology

Vhost `nawara-core`; three per-service identities (`audit-service`, `auth-service`, `organization-service`), provisioned by the pinned
`infra/rabbitmq/provision.sh` (G1). Audit's deploy asserted that `audit-service.audit` is declared, bound to `audit.#` and consumed;
every later step asserted durable, settled queues and one audit consumer. Permissions are asserted by the scripts, not printed.

### 2.4 Migration fingerprints

The approved G6-A form (cutover record §5; the BV-S production capture uses the same expression): count, last name, MD5 of
`name:checksum` in name order, rows without a checksum. Rehearsal values read on the guest after G6-E, read-only
(`g6f-guest-migrations-20261014T222947Z.out`, §10); production values from the BV-S `pre` and `post` captures (plan §21.1), equal to
G6-A's.

| Database | Rehearsal (guest) | Production | Result |
|---|---|---|---|
| `auth` | 11 \| `0011_code_event_purge_index.sql` \| `b8139c05c1f49393d5ee049464403392` \| 0 | 11 \| `0011_code_event_purge_index.sql` \| `b8139c05c1f49393d5ee049464403392` \| 0 | **MATCH** |
| `organization` | 8 \| `kit_0003_generic_triggers.sql` \| `72f2bc1b737a40feca121ccff6fe8ffd` \| 0 | 8 \| `kit_0003_generic_triggers.sql` \| `72f2bc1b737a40feca121ccff6fe8ffd` \| 0 | **MATCH** |
| `audit` | 7 \| `kit_0003_generic_triggers.sql` \| `f311b78605ebf57efb33ff2b5c0e81ef` \| 0 | 6 \| `kit_0003_generic_triggers.sql` \| `0006a2adda45c36073ef8defa8af7bb2` \| 0 | **intended difference** |

The Audit difference is the planned `0004_changes_validation_search_path.sql` (plan §15.3): the guest records it as applied exactly once,
and the rehearsal count is production's + 1. The Audit MD5 differs by design and is not compared. In production, `0004` is applied only
by an authorized Audit digest deployment, forward-only. The B1 drills and B2 Gates A–D also showed the migration history of the restored
Auth and Organization databases equal to checkpoint X (§8).

### 2.5 Rehearsal ownership digest

**D = `9af2831c9fda1acebe263f3be8fdc10ac8ac36437b1fee3c7e306ed7d870ba31`**, the content digest of `ownership status` at F5 (taken
twice, identical). It stayed D through the rollback proof, G7-equivalent, F6, F7, every G6-D demonstration and the G6-E restore.
Organization computes it with `ORDER BY id::text COLLATE "C"`, so it does not depend on the database collation (§9).

## 3. G6-BV-S (plan §6.1)

**PASS** (2026-10-14), recorded in plan §21 (merged in PR #309): every automated check passed (exit 3) and check 6 is met (the
production captures before and after are identical).

## 4. G6-C — the rehearsed procedure (plan §9.1, §15.4)

All 2026-10-14. Output SHA-256 of the owner's saved copy.

| Step | Start | Result | Output SHA-256 |
|---|---|---|---|
| G1–G3, attended redeployment acceptance | 10:09:06 | **PASS**: broker provisioned; Audit and Organization redeployed, `OK`; privileges `f\|f` and `t\|f`; ports 0, internal network only | `fb9df877f87846ef5aec58720450863c5eb0e6daf7e651a7d4ef9e32bcb4da36` |
| F1 | 10:14:19 | **PASS**: `PREPARED\|fresh`; provisioning caller registered (token never printed); Organization redeployed and ready | `66d1df03924f10f4158fc1f4c0ddd6cd55461515bc3cb7f82094925f39a1edfd` |
| F2 | 10:23:00 | **PASS**: Company `nawara-rehearsal` created (HTTP 201); `1\|0\|0`; still `PREPARED\|fresh` | `176ebced9939c9bc4ea04b091552145a85150233f81e062cfce926180ba624e7` |
| F3 | — | none (Company only; OPEN-5) | — |
| F4 | 10:34:24 | **PASS**: auth-service caller registered; Organization and Auth redeployed; `bootstrap-owner`: one owner; Auth reference row = Organization's | `814ad8dbd62ad6e5ce23f9382a4c496dee1cae81b548452455f0d77c863e85ad` |
| F5 | 10:41:17 | **PASS**: `VERIFIED` with D | `993abaad972ea7170b33a4d0cbf1f30e6ac9fdb5972c3f5846613515868723fc` |
| T1-equivalent, v1 | 10:57:52 | **STOP** before any mutation (deviation 5.1) | `1f0d56457e88f9b78a85c5fe1ce881adf6758fae3712a5069d40f350c49a8ff0` |
| T1 broker observation (read-only) | 11:05:07 | broker healthy: queues in `nawara-core` empty, one audit consumer, outbox fully published | `c52aaca6249dabbf191e675020e81cc880725a46bc3c6efd95104fb3b77152d1` |
| T1-equivalent, v2 | 11:10:24 | **PASS**: owner TOTP enrollment; one outbox row `audit.owner.factor_enrolled`, published → broker → exactly one audit record with the same event id, actor and correlation id | `78d64706e520a130444435c327d8f7024e58b4d6cf2ff566b176746ce29257ce` |
| Rollback proof | 11:28:28 | rollback `VERIFIED → PREPARED` recorded; **STOP** on the script's expectation (deviation 5.1) | `f5eda5db6623130ff71ed314b005346edac4cb763103f9f0bac856665320d0be` |
| Rollback verification | 11:33:45 | **PASS**: status digest D (content unchanged); `verify` `PREPARED → VERIFIED` with D; chain verify, rollback, verify | `93c46e973028a71e179614caad13c7c93be7cec19065b4994606ceac4de2bed6` |
| G7-equivalent | 11:38:20 | **PASS**: `ownership approve --reference REHEARSAL`: `ACTIVATABLE`, not authoritative; §6.2 MATCH before | `ba4cac914f40bc93f1b3495bde75ba20158195a3e9df10ef015a20fcb28ab2dc` |
| F6 Part A (§15.4 item 5) | 14:00:47 | **PLANNED STOP** (case 7, ruling 11): `activate` → `ACTIVE`; cases 5, 3 (refused, then one retry succeeded), 7 (refused); E1 unchanged throughout | `6845946dcaf8d52230c117eb2a70728ec72ad67695685a6bbeea0549deabbcfa` |
| F6 Part B (fresh architecture-owner decision under ruling 11) | 14:11:30 | **PASS**: case 4 restart; E2 = E1; `hierarchy-retire --fresh`; §6.2 **MATCH** `ACTIVE\|org_authoritative\|organization-service`; Auth `/ready` ready | `19ed49abddb005103337ca35eaaa531389a1c879cd756c2d5467b674ea4ce419` |
| Post-activation refusal | 16:21:40 | **PASS**: `ownership rollback` refused with `rollback_after_activation`, one rejected event; `ACTIVE` and D unchanged | `e76cc961f324c70edcbb0b87e91ca30dd2e766ef2f167adfe358199e8dc6842a` |
| F7 | 16:25:22 | **PASS**: `ACTIVE → RETIRED` (retire event cites Auth's `hierarchy-retire` event); §6.2 **MATCH** `RETIRED\|org_authoritative\|organization-service`; D unchanged | `9eae5d97b81b76588bafe8260ff62e7a270537600682382d453d57571947b739` |

### 4.1 The seven Auth readiness cases (plan §15.4 item 2)

| Case | Result |
|---|---|
| 1 source-first sequence through F7, MATCH at its end | **PASS** (F6 Part A, Part B, F7) |
| 2 no unintended hierarchy-content change across the window | **PASS**: E1 (before the first redeploy and again before the retry) = E2 (before `hierarchy-retire --fresh`), Auth content digest, Organization phase, verified and live digest D, two Auth authority events |
| 3 a failed Auth redeploy and one controlled retry | **PASS**: refused by the configuration check (`ORGANIZATION_SERVICE_TIMEOUT_MS`) in 1 s, running container unchanged; the retry on the certified digest succeeded in 9 s, `/ready` `source_ahead_of_marker` only |
| 4 an Auth restart inside the window | **PASS**: one `docker restart`; same container healthy in 6 s; `source=organization-service marker=local` |
| 5 an abandoned transition detected by the agreement check | **PASS**, observed twice: `ACTIVE\|local\|unset` with `/ready` ready after `activate`; `.env` showing the source while the running container still reported `local` after case 3 |
| 6 measured durations | recorded: approval latency (approve → `activate`) 8545 s; window `activate` → MATCH 655 s, including the Part A/B pause; `hierarchy-retire` step 2 s. The hard limit is set later from these (OPEN-5); G6 sets none |
| 7 a second failure, then stop and escalation, no further retry | **PASS**: refused in 1 s; the window container kept running; fault line removed; stop and escalation; Part B followed only on a fresh decision |

**F6 first-touch `ensure()` and the authority marker** (A5 record §9.2, OPEN): G6 rehearsed the approved safeguard of the
[F6 readiness decision record](../core-v2-a5-4-f6-transitional-readiness.md): no administrative first touch ran inside the transition
window (plan §15.4 item 5), and case 2 shows no hierarchy-content change across it. The code-level item itself is unchanged and stays
open in the A5 record; G6 does not close it.

## 5. Deviations (plan §5, §13)

Already recorded in the plan and unchanged: §16.5 (the host, the QEMU controls, offline image transfer, the PostgreSQL image difference,
G6-B before the decisions, the transient VM, B1–B3), §18.4, §19.2, §20.1 and §21.3. Added by G6-C to G6-F:

### 5.1 G6-C

- **T1 v1 stopped** before any mutation: its queue check read the default vhost, not `nawara-core`. A read-only observation showed the
  broker healthy; v2, with the vhost corrected, passed.
- **Rollback proof:** the script expected the verified digest to survive the rollback; the schema clears it on `VERIFIED → PREPARED`.
  The rollback itself was recorded as designed; a reviewed verify-only step completed the proof.
- **F6 in two parts:** the source-first mirror (§15.4 items 1 and 5) with Part A's planned stop and Part B's forward completion under
  ADR-0063 §4 ruling 11; the in-window extensions are exactly those §15.4 item 5 lists.

### 5.2 G6-D

- **Order:** freeze MISMATCH (before F6, at `ACTIVATABLE`) and source mismatch (before F6) were demonstrated during G6-C; readiness,
  failed verification, outbox relay and hierarchy reference after F7, each with a re-baselined pre-state.
- **Hierarchy reference:** Organization was stopped before the owner login (the approved order), then restored.
- **Disposable owner sessions** for the outbox and hierarchy-reference demonstrations: one session family stays live; only token
  hashes are stored and no raw token was retained. It is part of checkpoint X and was restored unchanged.

### 5.3 G6-E

- The drills ran on the guest with `RESTORE_ON_PRODUCTION_HOST=yes` and the rehearsal key on the guest, before the declared loss.
- Two approved writes after X (one Auth failed login, one Organization rejected `verify`), made through the applications only, to prove
  their absence after the restore.
- **Incident (STOP at the Auth drill, exit 125).** `restore-drill.sh` requests the bare tag `postgres:16-alpine`; the guest held only the
  digested reference and has no route to a registry, so the pull failed. Checkpoint X already existed; nothing was written after X and
  no database was touched. Read-only diagnostics found the cause.
- **Correction:** one local tag `postgres:16-alpine` → the pinned image `sha256:721873c3…80ea` (image metadata only; no pull; the pinned
  content unchanged). Two earlier runs of the tag script stopped before tagging on script defects (a template error; the store's
  `postgres:16-alpine@sha256` spelling); the third passed.
- **Recovery split into B1 and B2 on the original X**, instead of one G6-E run: B1 the drills of X, B2 the declared loss and recovery,
  under a one-run lock that is never removed.
- **B1 Organization drill with `KEEP_DRILL=yes`** to read the restored digest (the runbook calls it debugging-only); the drill
  containers were removed immediately.
- The marker check reads `org_authoritative` on the restored post-F6 Auth backup; a wrong-side restore stays procedural and was not
  rehearsed (plan §15.4 item 4).

### 5.4 G6-F

- **Production collation capture:** two SSH attempts (21:16 and 21:20 UTC) were refused at authentication after the pinned host key was
  verified; nothing ran remotely and the evidence is kept. The capture was then run at the Server 1 console with a capture body
  byte-identical to the reviewed one, delivered as checksummed chunks through the owner's existing terminal and installed only on the
  exact hash (the transfer and installation results are **owner-reported**). Its output is **owner-reported** (§9.1).
- **Migration fingerprints** were captured on the guest after G6-E (§2.4), once the evidence review found the rehearsal's full fingerprint
  was not otherwise recorded.

## 6. Monitoring demonstrations (plan §8, G4)

### 6.1 §8.1 signals

| Signal | Start | Observed (excerpt) | Restored | Output SHA-256 |
|---|---|---|---|---|
| authority agreement MISMATCH + Auth `/ready` `marker_frozen` (§15.4 item 3) | 11:47:20 | `hierarchy-freeze` at `ACTIVATABLE`: §6.2 MISMATCH `ACTIVATABLE\|frozen`; `/ready` `marker_frozen` | `hierarchy-unfreeze`; MATCH | `503c5c4de374afbc5367c0e5943705ff98a4c717698505ec6b917e328893b714` |
| `hierarchy_source_mismatch` + `source_ahead_of_marker` (§15.4 item 3) | 12:42:44 | the start-up warning; `/ready` `source_ahead_of_marker`; §6.2 MISMATCH | redeploy without the source; MATCH | `2b68b579c1ac0ccde684b587f314569b8eb5ae61e0533ad00e3a2c443af7c9bc` |
| readiness | 17:47:11 | Organization database stopped: Organization `/ready` 503 (database); Auth unaffected | database started; ready; state unchanged | `b5ea93e43b3e23dbfa0ebbdffa8155ee9a858dfcf1daf5f02e36efdb6d1e11f5` |
| failed verification / digest mismatch | 17:48:18 | `verify --expect-digest <wrong>` refused; `ownership_import_failed` `verification_mismatch`; one rejected event | none (append-only evidence); state and D unchanged | `33d6768530a8350280b8bee08ebed4b43d5a1bfd1e36450b7368afa16e4f27c8` |
| outbox relay failure and lag (60 s) | 17:49:05 | RabbitMQ stopped, then an audited action: `outbox_publish_failure`; `nawara-check-outbox-lag --max-age-seconds 60` above 60 s | RabbitMQ started (same container); the event relayed to exactly one Audit record; lag check passes | `2adebf981da8544b0b3eeb522a0a25085cd70a8087e8de735b4a860218dd9844` |
| `hierarchy_reference_*` | 17:51:28 | Organization stopped, then an Auth first touch: 503 `hierarchy_unavailable`; `hierarchy_reference_unavailable` logged | Organization started; no unintended change | `fc6eaa436629b380484005a6cb4128a1ae6111a46f800c80f018c4d4344aa271` |

### 6.2 §8.2 `hierarchy_anchor_mismatch` (not induced; e2e evidence)

Core CI run [38091302936](https://github.com/nawara-solutions/nawara-core/actions/runs/38091302936) (push to `main`, success) at
`64ad8e3ae57e15170c3d714ddb9bc804626f374d`, the rehearsed Auth revision. Job `auth-service` (114328123591), step `integration tests`:
success; its log reports `✓ test/hierarchy-reference.e2e-spec.ts (11 tests)`. At that revision the file contains the test "an anchor
that disagrees with the authority fails closed and alerts" (line 143). The log names the file and its passing test count, not each test.

## 7. Health and readiness

Every G6-C, G6-D and G6-E step checked the pinned images of the eight stack containers, both services' `/ready`, settled queues and no
published host port before and after its action (each output's pre-state and final lines).

## 8. Backup and restore: RPO and RTO (plan §7, G5)

| Step | Start | Result | Output SHA-256 |
|---|---|---|---|
| Checkpoint X, then the drills | 19:40:33 | X = `20261014T194046Z`: eight encrypted objects (dump, facts, configuration, manifest per service), both status files succeeded; **STOP** at the Auth drill, exit 125 (§5.3) | `1977bc933f77e8db0ea22746a4d379796f96d76ce8c978b4c63c4ca8603924f9` |
| Diagnostics (read-only) | 19:46:56 | cause found: bare `postgres:16-alpine` tag absent; pull failed (no route) | `b5bd3328cc6f5796619a187e55051f1720ed7b8861f97cfdcf307e12298c3a0a` |
| Tag script, run 1 | 19:57:57 | STOP before tagging (script defect) | `8ae834f29aa485081b865ce487ba3bf6a38fb206624e5c512a448a1fcbf77499` |
| Tag script, run 2 | 20:03:58 | STOP before tagging (script defect) | `cf1797b3833e47f23a4934cf2ae76e7e43b123ed45ee151593681653a7cdcd8a` |
| Tag script, run 3 | 20:09:20 | **PASS**: one local tag → `sha256:721873c3…80ea`; no pull; nothing else changed | `1e0ac4cde7bd0b150d11b1b6f37e21da15ec78eaf2cd635005537aba875383e3` |
| B1: drills of X | 20:20:42 | **PASS**: Auth restores in 12 s (10 checks), restored marker `org_authoritative`; Organization in 9 s (11 checks), restored `RETIRED`, authoritative, verified and content digest **D**; MATCH; nothing live changed | `c3dc4c291f8caf1ef0404ed506bceecc4680a7a638bdc72c193cd65bb93afc8f` |
| B2: declared loss and recovery | 20:42:59 | **PASS** (below) | `b8fe8e765baffae94588e5298e22ba437b011cf96214070fb3bc98b806bcfaf4` |

**B2 (runbook §6 recovery of the Auth and Organization databases):**
- **Gate A** (before any write): all 50 Organization and 95 Auth facts equal X. **Gate B:** after the two approved writes, the live facts
  differ from X only by them.
- **Declared loss T0** `2026-10-14T20:43:23Z`. **T1** `20:43:47Z`: both services `/ready` ready, B1's drills passed, agreement MATCH.
- **Gate C** (restored, before the redeploy) and **Gate D** (recovered): all 50 and 95 facts equal X (row counts, structure,
  migration history, owners, ACLs, authority state).
- **After the recovery:** Organization `RETIRED`, authoritative, D, exactly the ten X events (the rejected `verify` written after X is
  absent); Auth `org_authoritative`, its row written after X absent; runbook §6.2 **MATCH** `RETIRED|org_authoritative|organization-service`.

| Measure | Result | Limit | Verdict |
|---|---|---|---|
| **RPO** | X (status files succeeded) was **3757 s** old at the declared loss; the restored facts equal X; rows written after X are absent | 24 h | **PASS** |
| **RTO** | T0 → T1 = **24 s** (with the B1 drill times, 24 + 12 + 9 = 45 s) | 4 h | **PASS** |

The real-volume restore drills stay certified under G5 and were not repeated (plan §7). Checkpoint X, its encrypted objects, the status
files and the B2 lock are preserved.

## 9. PostgreSQL ICU and collation (plan §16.2, §17.6)

### 9.1 Inputs

| Capture | Where it ran | Output SHA-256 | Status |
|---|---|---|---|
| Guest, `g6f-guest-collation.sh` (`7e8a54ac587171dd57c443710f5b1c79253b4fadaf1ff476fc27561eac187d5a`), read-only, 21:11:28 | guest, pinned path | `942c974dfffc6bdeac29ceda12ed8a4d1242b2a9efde6c05916c721ff438610c` | verified (owner's copy read) |
| Production, `g6f-prod-collation-console.sh` (`0f5b1fdebf7d05ea911e2bb75cd037ae8ec0c7020b230bb9b12917a84edf6845`), read-only, 22:13:03 | Server 1 console | `8822a8e4e9102751af25997f29e9c29f54315a1c6d6e3d04143c3d3622b5dfc1` | **owner-reported**: 32 lines, exit 0, identity PASS, collation COMPLETE. Kept on Server 1; **no copy was read by this record's author**. Accepted by the owner with this provenance |

### 9.2 Facts

| Fact | Guest (Auth, Organization) | Production (Auth, Organization), owner-reported |
|---|---|---|
| Image ID | `sha256:721873c3…80ea` | `sha256:cf78e766…0685` |
| PostgreSQL | 16.15 | 16.15 |
| C library / ICU | musl libc 1.2.6 / ICU 78 | musl libc 1.2.6 / ICU 78 |
| Database provider and locale | `libc`, `en_US.utf8` | `libc`, `en_US.utf8` |
| Database collation version | not tracked (stored and actual null) | not tracked |
| Collation version mismatches | 0 | 0 |
| Locale-dependent indexes / all indexes | Auth 14 / 76; Organization 5 / 22 | the same counts and index names |

### 9.3 Assessment

1. **Major version:** 16 on both sides; no STOP.
2. **Not byte-identical:** the image IDs differ, so the environments are not identical and this record does not claim they are (the
   §16.2 limitation stands). Every captured collation-relevant fact is the same; libraries outside those facts are not compared.
3. **Text ordering and uniqueness:** with the `libc` provider, ordering follows the C library; the same musl version orders
   `en_US.utf8` text the same way on both sides. Uniqueness under these deterministic collations is byte equality. Digest D uses
   `COLLATE "C"` and does not depend on the database collation.
4. **Locale-dependent indexes:** the 19 indexes are ordered by the same musl version on both sides; no REINDEX is needed for G6.
5. **Logical restore:** backups are logical (`pg_dump -Fc`), and `pg_restore` rebuilds every index in the target. The G6-E restore used
   the same image for backup and restore; `restore-drill.sh` runs on `postgres:16-alpine`, the same musl/ICU family as production per
   these captures. The facts the drill compares do not depend on text ordering.
6. **Collation versions are not tracked** (`libc` provider on musl): PostgreSQL cannot warn if a future image changes the C library.
   A change of the PostgreSQL image family (for example to glibc) is a collation change for these 19 indexes and needs its own,
   owner-decided assessment. Recorded as a risk only.

**Result: PASS WITH RECORDED LIMITATIONS** — the image IDs differ; collation versions are not tracked; the production capture is
owner-reported.

## 10. G6-F captures

| Capture | Start | Result | Output SHA-256 |
|---|---|---|---|
| Guest collation (§9) | 21:11:28 | COMPLETE; isolation gates PASS | `942c974dfffc6bdeac29ceda12ed8a4d1242b2a9efde6c05916c721ff438610c` |
| Production collation, SSH attempt 1 | 21:16:15 | refused at authentication (exit 255); no output | — (empty) |
| Production collation, SSH attempt 2 | 21:20:27 | refused at authentication (exit 255); no output | — (empty) |
| Production collation, console (§9.1) | 22:13:03 | owner-reported COMPLETE | `8822a8e4e9102751af25997f29e9c29f54315a1c6d6e3d04143c3d3622b5dfc1` (owner-reported) |
| Guest migration fingerprints (§2.4), `g6f-guest-migrations.sh` (`c0267171d9b90d0771c7cf61004f1cf3be683f7902acc5f05c99d94228967462`), read-only | 22:29:47 | **PASS**: Auth and Organization MATCH production; Audit `0004` applied once, count production + 1; isolation gates PASS | `f70ab5ea794693fd2d9b41dfe857f6b3d478084a19500e7e7ce18627ada77c6b` |

## 11. Image pinning for G6 (cutover record §8)

The cutover record's §8 question, how the rehearsal, F6 and F7 keep the exact rehearsed image identity, is **closed for G6 only**: it
was answered by V2 A0 (owner decision D5: build once, then verify and deploy an exact index digest; cutover record §13), and G6 rehearsed
exactly the digest set of plan §16.1. **This authorizes nothing in production.** Production's first digest deployment of each service,
with the production Tier B configuration check before it, stays a separate, owner-authorized checkpoint, as do the pre-G7 backup, G7,
F6 and F7 (plan §15.8; cutover record §7).

## 12. Script versions

Held by the owner outside the repository; a hash identifies a version and is **not** an approval to run it. The G6-S1, G6-S2 and
G6-BV-S versions are in plan §18.3, §19.3 and §20.4.

| Script | SHA-256 | Step |
|---|---|---|
| `g6-c-g1g3-redeploy.sh` | `d7587cd9729261b252b1e2d2396220f876806030f13f6e35efbd02206452defc` | G1–G3 |
| `g6-c-f1.sh` | `1099db965689626f8965b67e66cdd4c21380f8f61dd344047e34084507b2b080` | F1 |
| `g6-c-f2.sh` | `cb3a67b74aae8c7214739e368a2c7704f603bc48e80340c24108b5f381a86924` | F2 |
| `g6-c-f4.sh` | `55010cff0aee6e409fed964cfc5e50eca430e67cf84477d99462e998bf6c5a83` | F4 |
| `g6-c-f5.sh` | `cba1db357220d5e4575879e8e76ec59644180d6903a85f4b24f6bb037d2ff474` | F5 |
| `g6-c-t1.sh` | `8efc32a7e8abea36f212688b02c0ac8c812f90734c7c7d344382575a537be51c` | T1 v1 (stopped) |
| `g6-c-t1-queue-observe.sh` | `5dc5b88c9fd30b988109e27dfbae0cad262c679c497d81bdd48d889bd343a58f` | T1 observation |
| `g6-c-t1-v2.sh` | `50c70bb4ce20a146aaf15433413dcd81280b58a20e77d7cc2825cf9cb18b844b` | T1 v2 |
| `g6-c-rollback-proof.sh` | `b0ee0192f7c32cb15385808b118f0a8c4079f0bd67347794556bc44f17a793cc` | rollback proof |
| `g6-c-rollback-proof-verify.sh` | `7b96b3457009754e4e19185d91a85ad39b997187499e4c4ce41c280964d7dfa7` | rollback verification |
| `g6-c-g7-approve.sh` | `6d6673cc1a57161e2dbbc01697729d7f99beaa5ff60d6841bb0e9f97831ecc39` | G7-equivalent |
| `g6-c-f6-part-a.sh` | `5611a6d98a9be8fe649cc380a0d30fb7fedd08709c22d1aab5c35470fc0efb2e` | F6 Part A |
| `g6-c-f6-part-b.sh` | `3765831143fcbdcfb810969263c2e90ff0f84505d006f37485aabde2954272f3` | F6 Part B |
| `g6-c-rollback-refusal.sh` | `b51a3bb11290b50374d4679272683f7560e7df53b07b6bda89bbea6424f990ff` | post-activation refusal |
| `g6-c-f7.sh` | `8f267850882843d18bbe97e0dc1d865f083c0cc193623a576c6ec444badb1c51` | F7 |
| `g6-d-freeze-mismatch.sh` | `6ba56d44cfebe7bc287a0813b432fc03bf7c4b7da8236aee442c97ca1364c373` | G6-D |
| `g6-d-source-mismatch.sh` | `babbeefe3bfa58fe1ff0ad8e1ccc98c2ea150f620be1fb61d722d5737689f3f4` | G6-D |
| `g6-d-readiness.sh` | `e5d99af3c5a780ac98d891e8546da20f318c78dc834df584a15c253e395e6f0b` | G6-D |
| `g6-d-failed-verify.sh` | `3475df27d886f6ed963b398b4fef7489c39bf468c38f018dbba244f28d169e06` | G6-D |
| `g6-d-outbox-relay.sh` | `38466a3496670c0bff36b84ceab9a5181ed2ad59b3f4f930dd0e29796f047cff` | G6-D |
| `g6-d-hierarchy-reference.sh` | `84a7b7b1bed451b78c109899ef6dd30d1f91bbb18acdfc2a983426e3c4824922` | G6-D |
| `g6-e-backup-restore.sh` | `b815ccc058bffff998777f3b81551cc189395b645caa62aaacca14c0c726b32d` | X, drills (stopped) |
| `g6-e-diag-drill-exit125.sh` | `72d5b405ca3bd996c96e262931822bf1be392d96dadeaea5707ab1659212db35` | diagnostics |
| `g6-e-tag-postgres-alias.sh` | `2897b94584f682a26e26ace43fba61184113df848b6b50e79380e9942ac0efc6` | the passing tag run (the two stopped runs used earlier versions) |
| `g6-e-b1-drill-x.sh` | `5230cc370651ebaf30808b3177bc3c60a95ba5ac938f98f1453b7a0cc16c0048` | B1 |
| `g6-e-b2-recover-x.sh` | `5838a59938555c4b20a039f7a954d24b775804cbd4882051df367deeaec4e85a` | B2 |
| `g6f-guest-collation.sh` | `7e8a54ac587171dd57c443710f5b1c79253b4fadaf1ff476fc27561eac187d5a` | §9 guest |
| `g6f-prod-collation-console.sh` | `0f5b1fdebf7d05ea911e2bb75cd037ae8ec0c7020b230bb9b12917a84edf6845` | §9 production (console) |
| `g6f-guest-migrations.sh` | `c0267171d9b90d0771c7cf61004f1cf3be683f7902acc5f05c99d94228967462` | §2.4 |

Unchanged repository tools used: `infra/backup/backup.sh` and `infra/backup/restore-drill.sh` as on `main`; the services' deploy
scripts streamed from the pinned images.

## 13. Result

| Plan §13 condition | Result |
|---|---|
| G6-BV passes | **PASS** (G6-BV-I §17.1; G6-BV-S §21) |
| every §9.1 step reaches its PASS result | **PASS** (§4; F3 n/a by design) |
| every §8.1 signal observed and restored | **PASS** (§6.1) |
| the §8.2 evidence is cited | **PASS** (§6.2) |
| RPO and RTO | **PASS**: 3757 s ≤ 24 h; 24 s ≤ 4 h (§8) |
| the record is complete and approved | complete (this document, all plan §10 fields); **approval = the owner's merge of this record** |

**Rehearsal result: PASS, with the recorded deviations (§5) and limitations (§9).** G6 becomes **CERTIFIED** when this record is
merged into `main` with the owner's approval.

**G7 reference:** `G6-REHEARSAL-<YYYYMMDD>@<commit of the certified record>`. Both parts are fixed only after the merge and are recorded
then; nothing in this record is a G7 reference yet.

**Unchanged:** production; G7, F6 and F7 stay locked behind their own authorizations; the preserved rehearsal state (checkpoint X, the
B2 lock, the recovered guest, the evidence) is not cleaned up by this record; Final Core Validation stays the absolute last.

## 14. Certification and the G7 reference

Appended after the merge; §1–§13 are unchanged and are the content the owner approved.

- **G6 CERTIFIED (2026-10-14).** The owner approved this record by merging PR #311 into `main` at 2026-10-14T23:05:44Z (`core-ci-passed`
  green). Merge commit `64b503095674a8227527c7f0b68819cdf703669d`; content commit `1f80083bc7d22f8937aee124ad4fe7e70e73c5c4`. The file
  at both commits has SHA-256 `ad40c9072d4e2a8e2c5b4f2de68a1f38ab059010249fb5e5fd2491957cb9e03a`.
- **G7 reference (plan §10, D-14; fixed now, as §13 provides):**

  ```text
  G6-REHEARSAL-20261014@64b503095674a8227527c7f0b68819cdf703669d
  ```

  - **Date:** 2026-10-14, the date of the rehearsal in UTC, the time base of this record (§2). The certifying merge is also on that UTC
    date.
  - **Commit:** the merge commit at which this record became certified on `main`. The content commit `1f80083` is not used: at that
    commit the record was not yet on `main` and not yet approved. The certified content is identical at both.
  - **Use:** `ownership approve --reference` requires only a non-empty value and stores it as text; it is passed exactly as above.
- **Authorizes nothing.** The pre-G7 backup, its verification and the backup schedule (M2), and G7, F6 and F7 (M3), each keep their own
  owner-authorized checkpoint ([cutover record](stage-21-x-cutover-record.md) §7, §16). M2 is **not certified**; G7, F6 and F7 stay
  **locked**. The preserved rehearsal state of §13 is unchanged.
