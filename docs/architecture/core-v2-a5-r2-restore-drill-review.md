# Core V2 A5 R2: independent source review of the frozen-backup restore-drill change

- **Status:** review record, documentation only, 2026-10-12. **Verdict for the source only: PASS WITH LIMITATIONS. No code change is
  required.** This is a static review: no script, test, container, image or restore was run. It does **not** certify R2.
- **Subject:** R2 ([ADR-0063](../adr/0063-post-f7-authority-mode-cli-and-recovery-convergence.md) §4 item 9; the
  [A5.4-A5 design](core-v2-a5-4-a5-readiness-design.md) §9, OPEN-8). A backup taken under a freeze stays a valid backup state.
  The restore-drill compatibility change must be "separately authorized, tested and reviewed before any affected rehearsal".
- **Change reviewed:** PR #292, implementation commit `c79020e`, merged at `5edaf34` (2026-10-10; PR CI 24/24, `core-ci-passed`),
  read on `main` at `92c3b44`. The following were in scope:
  - `infra/backup/restore-drill.sh`, lines 491–539 (the exception and the two ready gates), with `compare_facts` (lines 321–351) and
    the Auth application read (lines 568–577);
  - `scripts/deploy-tests/backup-restore.test.mjs`, lines 501–632;
  - [`core-backup-restore.md`](../runbooks/core-backup-restore.md), §5 step 7.
- **Prior review evidence:** PR #292's description reports an "independent security and governance review: PASS WITH FINDINGS, no
  material finding". There is no review or comment on the pull request in GitHub, so that earlier review is **NOT VERIFIED**. This
  record is the evidenced review.
- **Update (2026-10-12): R2 PACKAGED-IMAGE PROBE: PASSED. R2 FULL RESTORE DRILL: NOT DEMONSTRATED BY THIS PROBE.** LOW 1's
  packaged-image capability probe passed for both pinned images on the nonproduction lab host (§5; owner-supplied terminal output).
  R2 as a whole is **not certified**.

## 1. What the change does (verified in source)

1. **The exception is derived, not configured.**
   - `FROZEN_BACKUP` and `READY_GATE` are assigned inside the script (lines 495–507). Values from the caller's environment are
     overwritten, so they cannot enable the exception.
   - `FROZEN_BACKUP=yes` only when `SERVICE=auth-service` and `AUTHORITY_FACT` is exactly `authority|frozen`.
   - `AUTHORITY_FACT` comes from the verified, decrypted `facts.expected` (line 325), and `compare_facts` has already proven it equal
     to the restored database before the service starts.
2. **The capability is detected from the image itself (D1).** One `docker exec … node -e` runs in the image's runtime `WORKDIR`
   `/app/apps/auth-service`, which matches `apps/auth-service/Dockerfile` (`dist` copied to `./apps/auth-service/dist`). It returns:
   - `absent` when `dist/hierarchy/authority-readiness.js` does not exist;
   - `capable` when the module exports `HIERARCHY_AUTHORITY_CHECK === "hierarchy_authority"` (the constant exists in
     `apps/auth-service/src/hierarchy/authority-readiness.ts:7`);
   - `unknown` otherwise.

   Any value other than `absent` or `capable`, including empty output or a failed exec, stops the drill.
3. **The frozen gate accepts one answer only.**
   - The body-reading probe must return exactly `503 {"status":"unavailable","failed":["hierarchy_authority"]}`.
   - The latest `hierarchy_authority_not_ready` reason line must name `reason=marker_frozen` with `marker=frozen`.
   - The latest registry line must be `error=HierarchyAuthorityNotReady code=marker_frozen`.

   Both log lines are matched as JSON `msg` values, anchored at the field start and the end of the value, and never printed. A
   capable image answering `200 ready` while frozen fails immediately. Anything else within the existing 60-attempt budget fails.
4. **The CLI read still applies.** The application read (lines 568–577) must still return `frozen`, equal to the backup source.
5. **Every other path is unchanged.** Organization and Audit drills, Auth backups with `local`, `org_authoritative` or a malformed
   fact, and frozen backups drilled with a pre-check image all keep the exact earlier ready gate (lines 530–539). A pre-check frozen
   drill additionally prints a `NOTE` line.

## 2. Assessment

| Question | Finding |
|---|---|
| Capability detection | Sound for the documented packaged layout. Errors push it towards `unknown`, which stops the drill. A capable image whose file sits elsewhere would report `absent`, then answer `503` to the exact ready gate, and fail. **No path produces a false pass.** |
| Frozen marker handling | Correct and narrow: the exception requires the verified fact, the exact body, both diagnostics and the CLI read. |
| Old versus new images | D1 is handled. A pre-check image answers ready while frozen and keeps the unchanged gate. A check-capable image must give the frozen answer. |
| Fail-closed behavior | Holds for an unknown capability, a failed exec, a timeout, a different body, an extra failing check, a missing or mismatched diagnostic, a wrong CLI marker and a malformed fact. |
| Invocation assumptions | The probe relies on Node 18+ `fetch` and dynamic `import` inside the image, and on the module resolving its imports (`@nestjs/common`, `@nawara/service-kit`, the Auth config and database modules) from the packaged `node_modules`. Those modules have no top-level side effects (read 2026-10-12). This is exactly what a packaged-image probe must confirm (LOW 1). |
| Existing protections | Preserved: verification of the manifest and facts, `compare_facts` before start-up, network isolation, drill-only configuration with no production broker, cleanup of the drill containers and volumes, and no printing of secrets or restored values. |
| Test coverage | Meaningful for the logic. The tests use a fake Docker harness and cover, among others: the capable and pre-check frozen paths; unchanged gates for the other states; fail-closed cases (extra or different checks, wrong reasons, missing or partial diagnostics, spoofed log content, look-alike bodies, timeout, capable-but-ready, unknown capability, wrong CLI marker); a malformed fact; caller bypass variables; a local backup giving the frozen-shaped `503`; and a frozen fact not held by the restored database. **They do not exercise a real image, a real Docker daemon, a real database or a real Auth process.** |

## 3. Limitations and follow-ups (none requires a code change)

- **LOW 1 (open; recorded by PR #292):** the capability probe has not been run inside a production-packaged Auth image. The fake
  harness cannot prove that the module resolves there. If it fails, the result is a false **failure**, not a false pass.
  - **Follow-up:** a one-time, separately authorized nonproduction check against the two digest-pinned images. Expected results:
    `capable` for `sha256:5877c6ad…35ed` (`64ad8e3`) and `absent` for `sha256:f6e1d165…3a54` (`fcf5806`).
  - **Timing:** required before an affected rehearsal relies on this path. The R3 demonstration is not evidence for it
    ([runbook](../runbooks/auth-readiness-alerting.md) §6).
  - **Update (2026-10-12): done.** The probe ran on 2026-10-12, with both expected results (§5). LOW 1 is closed for these two
    digests only; any other Auth digest relied on by a frozen-backup drill needs the same probe first.
- **LOW 2 (accepted design limit):** the registry logs only when a check's state flips. If the first failing `/ready` had a
  different reason, no `code=marker_frozen` registry line appears, and a valid frozen drill fails closed. Rerunning the drill is the
  remedy. This is not a safety defect.
- **Informational:** the probe's `docker exec` calls carry no explicit timeout. This matches the script's other `docker exec` calls
  and is not a regression.
- **No real backup/restore drill** of a frozen Auth backup has been run. No end-to-end pass is claimed.

## 4. Status

- **R2 is implemented and merged.**
- **Tested:** fake harness only.
- **Source review:** PASS WITH LIMITATIONS (this record).
- **Not certified:** the packaged-image probe and a real drill are outstanding. *(Update 2026-10-12: the packaged-image probe has
  passed, §5. A real frozen-backup restore drill is still outstanding, so R2 stays not certified.)*
- **Gate:** required before any rehearsal that drills a backup taken under a freeze.

This record authorizes no drill, rehearsal, deployment or G6/G7/F6/F7 action.

## 5. Packaged-image capability probe (2026-10-12)

**R2 PACKAGED-IMAGE PROBE: PASSED. R2 FULL RESTORE DRILL: NOT DEMONSTRATED BY THIS PROBE.**

- **Evidence kind:** OWNER-SUPPLIED TERMINAL OUTPUT. The owner ran the probe and supplied the output; it was not independently
  collected by this record's author.
- **Where and when:** the isolated nonproduction lab host `nawara-lab-01` (Server 2), 2026-10-12 at 10:23:51 UTC. Production was not
  involved.
- **Method:**
  - The identical capability snippet of `infra/backup/restore-drill.sh` (`node -e`; the file check and module import of
    `dist/hierarchy/authority-readiness.js`) ran in the image's own `WORKDIR` as its own user.
  - Each image ran in one throwaway container: `docker run --rm --pull=never --network none --read-only --cap-drop ALL
    --security-opt no-new-privileges`, with no environment, mounts or volumes.
  - The only difference from the drill is `docker run` in place of `docker exec` into a running drill application. The probe code and
    the packaged files are the same.

**Results:**

| Image (pinned digest; no tag used) | Built from | Exit | Result | Expected | Outcome |
|---|---|---|---|---|---|
| `ghcr.io/nawara-solutions/nawara-core-auth-service@sha256:5877c6ad5a4a4ac4b7858efce794abf9ba65c5162dc9fc8f569fdef384ec35ed` | A5.4-A5 merge `64ad8e3` | 0 | `capable` | `capable` | **PASS** |
| `ghcr.io/nawara-solutions/nawara-core-auth-service@sha256:f6e1d165fe1a33f9420f2e4a4626d9a2da482a82c422e879e799a9e19c5d3a54` | `fcf5806` (pre-A5.4-A5) | 0 | `absent` | `absent` | **PASS** |

**Preflight and isolation, as reported by the owner:**
- the R3 carrier timer was disabled and inactive, and its queue was empty;
- the lab's container and volume inventory hash was identical before and after
  (`ca764750448f6f87553564b1a27b630fb2134221ce5769c71b577591b60c5a76`);
- no temporary container was left;
- there was no database restore, authority transition or production operation.

The R3 certification and its artifacts are unchanged.

**What this shows:** in the packaged images, the module resolves and the capability detection gives the expected answer. The
false-failure risk of LOW 1 did not occur for these digests.

**What it does not show:**
- a real backup and restore of a frozen Auth backup;
- the frozen ready gate's `503` and its diagnostics against a restored database;
- the CLI `frozen` read;
- any other image digest.

**Remaining before R2 can be certified:** one real restore drill of a backup taken under a freeze. Under R2's rule that drill is needed
only before a rehearsal that relies on this path, and it needs its own authorization. The G6 rehearsal, which uses the same
`restore-drill.sh`, is expected to be such a rehearsal if its Auth backup records `authority|frozen`.
