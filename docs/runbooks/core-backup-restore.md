# Core database backup and restore runbook

Encrypted off-host backups, isolated restore drills and production recovery for the two databases of the Organization authority
cutover (Stage 21.x G5; ADR-0040 G5; [production-readiness.md](../architecture/production-readiness.md) §3) and, since V2 A13, for the
audit-service evidence store ([A13 record](../architecture/core-v2-a13-audit-backup.md)). Tooling:
`infra/backup/backup.sh` (on the server), `infra/backup/restore-drill.sh` (in the recovery environment),
`.github/workflows/core-backup.yml`.

- **Never** print, paste or copy a credential, the private key, a decrypted file or a restored value into a ticket, a workflow input
  or a command line. The tools print names, sizes, sha256 digests and PASS/FAIL only.
- **Monitoring detects, the operator decides, this runbook governs the action.** Nothing here restores automatically.
- **Manual only since V2-A.3 / A3.5 (owner decision B1).** `core-backup.yml` has no schedule; each run is dispatched and then approved
  through the protected `production` environment. Scheduled backups return later through a separately reviewed `production-backup`
  environment and job (they do not exist); enabling them stays G6-gated.
- A backup that has never been restored is not a backup: G5 is met only with the drills of §5 (ADR-0040 G5: a documented procedure
  is not a verified restore).

## 1. Decisions (owner, Stage 21.x G5)

| | Decision |
|---|---|
| D1 off-host | private **S3-compatible** object storage; the provider is operational configuration (no provider is built in) |
| D2 encryption | **client-side public-key**: the server encrypts to a recipient certificate; the private key lives only in off-host custody. A compromise of the server, or of the bucket and its credentials, alone exposes no plaintext |
| D3 targets | **RPO 24 h** (daily backup), **RTO 4 h**, **30 daily** backups kept. No PITR/WAL archiving (optional later) |
| D4 scope | the cutover databases: **organization-service** and **auth-service**; extended by V2 A13 to **audit-service** (append-only evidence) |
| D5 drills | Auth real-volume drill after this tooling is merged (separate authorization); Organization real-volume drill **after F1, before G7/F6** |

Not decided here: the cadence of recurring drills after G5 (production-readiness §3 asks for a scheduled drill; the owner sets it; for
Audit it is deferred to the G6 production-operations work, A13 O6).

**Audit (V2 A13, O2).** Audit inherits the Core target of RPO 24 h / RTO 4 h / 30 daily backup days. While backups remain manually
triggered (§2), the 24 h RPO is a **target, not an operationally guaranteed objective**: it is met only when someone runs §3 every day.
A measured local drill duration and a later production-gated drill duration are recorded separately; neither is the other.

## 2. One-time setup (each step a separate, approved production change)

**Recovery key pair, generated OFF the production host** (a controlled workstation), private key passphrase-protected:

```bash
openssl req -x509 -newkey rsa:4096 -keyout nawara-backup-recovery-key.pem -out nawara-backup-recipient.pem -days 3650 -subj /CN=nawara-core-backup
```

Keep `nawara-backup-recovery-key.pem` and its passphrase in two separate offline custody locations; never on the server, never in
the bucket, never in the repository. Only `nawara-backup-recipient.pem` (a public certificate) goes to the server. When the pair is
replaced, keep the old private key for as long as backups encrypted to it are retained (30 days).

**Bucket:** private (no public access, no public object URLs), in a region and account the owner controls. Credentials scoped to
this bucket and prefix only: put, get, head, list and delete objects under the prefix. Nothing else.

**Server state** (`$HOME/nawara-core/backup`, 0700; files 0600; values without quotes):

```text
destination.env      BACKUP_S3_ENDPOINT=https://…   BACKUP_S3_BUCKET=…   BACKUP_S3_REGION=…   BACKUP_S3_PREFIX=nawara-core/prod
s3-credentials.env   AWS_ACCESS_KEY_ID=…   AWS_SECRET_ACCESS_KEY=…
recipient.pem        the recipient certificate
```

The script refuses a plain-http endpoint, an empty or climbing prefix, a credentials file not 0600, a missing certificate, and **any
private key under that directory**.

**Schedule (current state, V2-A.3 / A3.5).** There is **no** scheduled backup. The workflow is dispatch-only and its job is bound to
the `production` environment, whose reviewer approval would make a nightly run wait. The former mechanism (set
`CORE_BACKUP_SCHEDULE=enabled` and `CORE_BACKUP_SERVICES`, daily at `17 2 * * *` UTC) is removed and the two variables are no longer
read. A schedule returns only through a separately reviewed change: a `production-backup` environment (no interactive reviewer, `main`
only, its own credentials) and a scheduled job bound to it. Enabling it stays G6-gated. Until then the RPO is met only by manual runs,
and the staleness rule of §4 is the reminder.

## 3. Backup

```bash
gh workflow run core-backup.yml --ref main -f services="auth-service"
gh workflow run core-backup.yml --ref main -f services="audit-service"   # V2 A13; a production action: authorize each run
```

**audit-service prerequisite (V2 A13.4a).** An Audit backup requires the migration `0004_changes_validation_search_path.sql` to be
applied in the target database: without it a backup of a non-empty Audit database cannot be restored with `pg_restore`. `backup.sh`
checks it first and **refuses** the Audit backup (stage `preflight`: no dump, no upload, no manifest, no success status) while it is
missing. The first production Audit backup therefore must not run before an authorized Audit deployment has applied 0004, in this order:
A13 merged → a separately authorized Audit digest deployment (applies 0004, narrows and asserts `schema_migrations`) → deployment health
verified → only then the first production Audit backup → its verification → a separately authorized real-volume Audit restore drill.
The 24 h RPO stays a target, not an operationally guaranteed objective, while backups are manually triggered.

**Approval (V2-A.3 / A3.5).** The production job of this workflow (`backup`) is bound to the protected GitHub environment `production`. After the
dispatch the run **waits**: approve it in GitHub (the run → **Review deployments** → `production` → **Approve and deploy**). Only then
does the job start and receive the production SSH credentials (environment secrets). The reviewer is the owner; GitHub does not
prevent self-approval here, so this is a deliberate second owner action, not independent review. **Reject** (or cancel) a run you no
longer want instead of leaving it waiting: whether a waiting run holds the `production-deploy-core-api` queue has not been observed yet.

Per service, a run succeeds only when every step does, in this order: `pg_dump -Fc` **inside the database container** (its own
PostgreSQL major; a newer client's dump does not restore on an older server) over the local socket as the least-privileged identity
that reads everything (`organization_migrator` and `audit_migrator`, the non-superuser owners; `auth_app`, read-only use, no privilege
added) -> non-empty custom-format archive -> `pg_restore --list` reads it and it holds the data of the cutover-critical tables (Audit:
`schema_migrations`, `audit_record`, `audit_retention_policy`, `audit_retention_run`, `outbox`, `inbox`; a data section exists even
for an empty table) -> the restore facts (row counts, structure, migration digest, outbox counts, owners, ACLs, authority state; for
Audit instead of an authority state: the append-only triggers and their state, function and default ACLs, the schema ACL, a digest of
every record's identity and clocks, and the newest record as the known record) and the secret files (`db.env`, `roles.env`, `.env`,
`callers/`; tar, modes kept) -> each encrypted with `openssl cms` (AES-256, to the certificate) -> uploaded ->
HEAD reports each object's exact size -> the plaintext manifest, **last**. Then retention.

Objects, per run: `<prefix>/<service>/<service>-<YYYYmmddTHHMMSSZ>.{db.dump.cms,facts.cms,config.tar.cms,manifest}`. The manifest
holds the format, the PostgreSQL version, sizes and sha256 digests; never a secret or a row count. No manifest = an incomplete set,
never used by a restore.

**What the checksums prove:** the manifest's sha256 of each encrypted object detects corruption or truncation before decryption; the
dump's plaintext sha256 proves decryption reproduced the exact dump. They do **not** prove authorship: anyone holding the bucket
credentials and the public certificate could write a well-formed set. The restore drill (§5) and pg_restore `--exit-on-error` are
the proof of recoverability.

**Plaintext** exists only in a 0700 work directory under the backup state; it is deleted right after encryption and the whole
directory on every exit path, success or failure. Nothing unencrypted is ever uploaded; an encryption failure uploads nothing.

**Retention (D3):** the newest 30 backup days per service are kept; older artifacts of **that service, under the prefix, with the
exact artifact names**, are deleted, and only after the new backup succeeded. Nothing else in the bucket can match.

**Exit codes:** 0 all services backed up; 1 a backup failed or was refused (other services are still attempted); 3 backups succeeded
and retention failed (the new backup is intact).

## 4. Failure visibility (attended model, as G4)

| Signal | Alert when | Action |
|---|---|---|
| the `core backup` workflow run | failed (exit 1) | read the log (it names the stage: preflight, dump, verify, facts, config, encrypt, upload); fix; run again manually |
| the same | exit 3 (retention failed) | the backup is good; fix the bucket permission or listing; old backups are only kept longer |
| `backup/status/<service>.last-success` `stamp=` | older than **24 h** (the RPO) | a missed or failed run: run §3 now (there is no schedule since V2-A.3 / A3.5; see §2) |
| `backup/status/<service>.last-attempt` | `result=failed` | as the first row |
| a restore drill (§5) | any FAIL | the backups are **not** recoverable until fixed: stop any cutover step that depends on G5 |

```bash
for s in auth-service organization-service audit-service; do [ -f ~/nawara-core/backup/status/$s.last-success ] && sed -n 's/^stamp=/'"$s"' last success: /p' ~/nawara-core/backup/status/$s.last-success; done
```

## 5. Restore drill (isolated; the G5 evidence)

Run **in the recovery environment** (a controlled machine with Docker, OpenSSL and the private key), never with the private key on
the production host:

```bash
SERVICE=auth-service STAMP=latest PRIVATE_KEY_FILE=nawara-backup-recovery-key.pem \
IMAGE=ghcr.io/nawara-solutions/nawara-core-auth-service@sha256:<the release that made the backup, or later> \
BACKUP_DIR=<dir with destination.env + read s3-credentials.env> \
  bash infra/backup/restore-drill.sh      # BACKUP_KEY_PASSPHRASE may carry the passphrase (env only, never argv)
```

For organization-service add `KNOWN_ID=<the id of a Company written before the backup>` (read through the API). auth-service takes
no `KNOWN_ID` (refused): its application read is the hierarchy authority marker, so a fresh Auth database with no user can be drilled
and no personal data is read.

The drill creates `nawara-drill-<service>-<id>-db` with **`--network none`** (no route to a broker, Auth, Organization or the
internet) and runs the service image in that namespace only; it refuses a production container name, an existing drill, and a
Docker host running the production databases (override only for an approved on-host drill: `RESTORE_ON_PRODUCTION_HOST=yes`).
It passes only when all of these hold:

1. every encrypted object matches the manifest (sha256), **before** decryption; the decrypted dump matches its sha256;
2. the secret-file archive holds only the expected names, files 0600 and directories 0700 (contents never printed);
3. roles and default privileges exist **before** `pg_restore --exit-on-error` (the manifest's PostgreSQL major, inside the drill
   container); Auth's `auth_app` too (its grants are in the archive);
4. the image's own migration runner accepts the restored history (checksums included): the backup's migrations are *already applied*;
   a later release may apply only newer ones; then the deploy's `schema_migrations` narrowing;
5. the runtime role is LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS; `schema_migrations` is owned by the
   migration owner and the runtime holds SELECT only; for organization-service the deploy's own privilege assertion passes;
6. **every** fact recorded at backup time is equal: row counts, structure, migration digest, outbox (total, pending, attempts),
   owners, ACLs, authority state (`ownership_state` / `hierarchy_authority`);
7. the service boots against the restored database with a drill-only configuration (production endpoints and credentials replaced;
   **never a production broker URL**, since the relay re-publishes restored pending outbox rows) and `GET /ready` answers ready.
   **One exception (R2, ADR-0063 §4 item 9):** an auth-service backup whose recorded authority fact is exactly `frozen`, already proven
   equal to the restored database in step 6, is a valid backup, and an image with the hierarchy authority readiness check (A5.4-A5)
   correctly reports it **not ready**. The drill then accepts only `503` naming `hierarchy_authority` alone, together with the service's
   own `marker_frozen` diagnostics (its reason line and the readiness registry's line), and step 8 must still read `frozen`; anything
   else fails. An image that predates the check, detected from the image itself, answers ready and is held to the normal gate. The
   exception is never enabled by an operator setting, applies to the drill only, and does not make a frozen Auth ready for traffic;
8. the application-level read: organization-service returns the known Company through its API; auth-service reads its hierarchy
   authority marker through its own CLI (`hierarchy-status`; only the mode is used, nothing else is printed), and it must equal the
   value recorded at the backup source.

The drill containers **with their volumes** (`docker rm -f -v`: the postgres image keeps the restored data in an anonymous volume)
and every decrypted file are removed at the end, on success and on failure. `KEEP_DRILL=yes` is for local debugging only, never for
G5 evidence: it keeps the containers and the restored data, and prints the `docker rm -f -v` command that removes them.

**Real-volume drills (D5):** Auth, once this tooling is merged, under its own authorization; Organization after F1, before G7/F6.
Record each as G5 evidence: the date, the backup stamp, the image, the drill output (it holds no secret).

### 5A. audit-service drill (V2 A13)

```bash
SERVICE=audit-service STAMP=latest PRIVATE_KEY_FILE=nawara-backup-recovery-key.pem \
IMAGE=ghcr.io/nawara-solutions/nawara-core-audit-service@sha256:<the release that made the backup, or later> \
BACKUP_DIR=<dir with destination.env + read s3-credentials.env> \
  bash infra/backup/restore-drill.sh      # no KNOWN_ID: the known record is the one recorded at backup time
```

Audit's `/ready` requires a broker and its ingestion consumer, so the drill adds a **disposable broker** in the drill database's own
namespace (`nawara-drill-audit-service-<id>-mq`, `--network container:<drill db>`: loopback only, no route, no DNS; the production
broker's pinned image; a drill-only vhost user). Additionally to the checks of §5:

1. the facts are compared **before** the deploy's `schema_migrations` narrowing, so they prove equality with the backup source as it
   was; if the source still let `audit_app` write the migration history (O3-B), the drill prints a `NOTICE` and continues: the intended
   state is then applied and the deploy's own privilege assertion must pass;
2. the append-only triggers are present and enabled, and the controls are refused: `audit_app` UPDATE on `audit_record`; the owner's
   UPDATE, DELETE and TRUNCATE on `audit_record` and `audit_retention_run`; an `outbox` event rewrite; `audit_app` INSERT, UPDATE,
   DELETE on `schema_migrations`; `audit_app` running the retention grant helper; and a supplied `recordedAt` is replaced by the
   database clock. These are **LOCAL / DISPOSABLE RESTORE MUTATION** against the drill's own database, every one rolled back; they are
   never run against production;
3. the database and the broker have no network, and the broker and the service share only the drill database's namespace (checked);
   the service's `RABBITMQ_URL` is exactly the drill broker's;
4. the real `GET /ready` passes and the ingestion consumer is attached to the drill broker;
5. the application read: `GET /audit/platform/records` with a drill-only reader (`SERVICE_TOKENS` / `AUDIT_SERVICE_POLICY`
   `read_platform`, written only into the drill's own environment file) returns the newest record recorded at backup time.

The drill ends with a secret-free `DRILL_RESULT service=… stamp=… checks=… duration_s=…` line (the measured duration is the drill's RTO
evidence). The broker, the service and the database are removed with their volumes; `KEEP_DRILL=yes` keeps all three.

## 6. Production recovery (RTO 4 h)

**This section is for organization-service and auth-service. audit-service is never recovered this way: see §6A.**

Never ad hoc. The same order as the drill, with the normal deploy doing the last steps. Decrypt only in the recovery environment,
then move the needed files to the server over SSH into a 0700 directory, and delete them after use.

1. **Stop the service** (`docker stop nawara-core-<service>`) so nothing writes and no relay runs during the restore.
2. **Secret files** (only if the server state was lost): extract the decrypted `config.tar` into
   `$HOME/nawara-core/<service>` with `umask 077; tar -xpf`; check `stat -c '%a %n'`: directories 700, files 600.
3. **Database container:** if it is gone, run the service's normal deploy workflow once to recreate it (it creates the database, the
   roles with the restored passwords, an empty schema, and starts the service); stop the service again.
4. **Empty the database** (as the bootstrap owner, connected to the `postgres` database; the roles already exist from step 3):
   - organization-service: `DROP DATABASE organization; CREATE DATABASE organization OWNER organization_migrator;` (as `organization_admin`);
   - auth-service: `DROP DATABASE auth; CREATE DATABASE auth OWNER auth;` (as `auth`).
   The archive restores the schema owner, the object owners, the grants and the default privileges; the redeploy (step 6) re-applies
   the database-level grants.
5. **Restore** the decrypted dump inside the container: `docker exec -i <db> pg_restore -U <bootstrap owner> -d <db> --exit-on-error <dump`,
   then delete the dump.
6. **Redeploy** with the normal workflow: the migration runner reports the history as already applied, the deploy re-applies the
   grants and the `schema_migrations` narrowing, the privilege assertions run, and only then does the service start.
7. **Verify** before reopening traffic: `/ready` (Organization runbook §6.1), the authority agreement (§6.2), the application-level read of §5 step 8.

After the restart the relay publishes the restored pending outbox rows, including rows that had already been published after the
backup: Audit stores each `(sourceService, eventId)` once, so they are absorbed. Writes after the backup are lost (up to the RPO).

## 6A. audit-service recovery (V2 A13, O5): never drop the live evidence

Audit holds append-only evidence that may have been written after the backup and may not be reproducible. The live database is
**never** dropped and replaced by a backup. The procedure, each step an explicit operator action:

1. **Contain:** stop `nawara-core-audit-service` (ingestion stops; the broker keeps queuing `audit.#` in the durable
   `audit-service.audit`). Do not touch `nawara-core-audit-db` or its volume.
2. **Restore into a new, isolated database:** the drill of §5A (recovery environment) or a new database container and volume; never
   the live one.
3. **Verify:** every §5A check.
4. **Establish the gap:** if the live database is readable, compare it with the restored one (record ids and `(sourceService, eventId)`
   after the backup point).
5. **Reconcile what is available:** records still in a readable live database (copy procedure: **not implemented**, owner decision);
   messages still queued in `audit-service.audit` / `.retry` (delivered after cutover; `(sourceService, eventId)` uniqueness absorbs
   duplicates); dead-lettered messages (the kit's DLQ replay tools). Re-emitting producers' already-published outbox rows is **not
   implemented** (owner decision).
6. **Explicit operator decision** on what is accepted as lost.
7. **Controlled cutover:** the exact repointing procedure (the deploy names `nawara-core-audit-db`) is a later design and proof item.
8. **Verify after cutover:** `/ready`, the consumer attached, the queue draining.

Evidence acknowledged by the broker into data that is lost cannot be re-delivered: the 24 h RPO bounds what a backup restores, not
what can be reconstructed. Restoring a backup is necessary for Audit recovery, never sufficient on its own.

## 7. The authority boundary (ADR-0040 A2.6)

- **Before F6:** restoring the inactive Organization environment is recovery inside preparation, not an ownership rollback. Verify
  with the drill checks and the G4 agreement (§6.2 of the Organization runbook).
- **After F6:** a restore is **never** a rollback. **Do not restore a pre-F6 Organization backup after F6 activation:** Auth
  `org_authoritative` with a restored Organization `PREPARED`, `VERIFIED` or `ACTIVATABLE` is authority disagreement. After any
  post-F6 restore: do not resume traffic; run the agreement check; on a mismatch **stop, investigate, no automatic repair**.
  Hierarchy writes made after the restored backup are lost, and ADR-0040 designs no reconciliation for lost writes after
  activation: that gap stands and is escalated to the owner, not filled here.
- **After F6, a pre-F6 Auth backup is forbidden as an ordinary restore** ([ADR-0063](../adr/0063-post-f7-authority-mode-cli-and-recovery-convergence.md)
  §9). An Auth backup taken before F6 holds the `local` (or, in an existing environment, `frozen`) hierarchy authority marker, and one taken
  inside the attended F6 step may still hold `local` while Organization is `ACTIVE`; restoring it would reintroduce Auth's former
  hierarchy authority, and a restore is not an `UPDATE`, so the marker's trigger cannot stop it. The pre-F6 Organization rule above is
  unchanged. This rule is **procedural**: no tool enforces it today, and it has **not** been rehearsed.
  - **Marker compatibility:** after F6, a restorable Auth backup is one whose recorded authority state (the encrypted restore facts,
    §3) is `org_authoritative`; a restorable Organization backup is one whose recorded phase is `ACTIVE` or `RETIRED`. Auth and
    Organization backups restored together must be on the same side of F6.
  - **Before the restore:** read the backup's recorded authority state from its restore facts, decrypted with the recovery key in
    the isolated drill environment (§5), never in production; an incompatible backup is not restored.
  - **After the restore, before traffic:** read Auth's marker (`hierarchy-status`) and Organization's phase (`ownership status`), both
    read-only, and run the agreement check (§6.2 of the Organization runbook); a `local` marker after F6 is a critical disagreement.
  - **Refusal and escalation:** on an incompatible backup or any disagreement, stop, do not resume traffic, never edit either side to
    make them agree, and escalate to the owner.
  - **Exceptional recovery** stays separately governed (ADR-0040 A1.4, A2.6): it is attended and owner-decided, requires a
    reconciliation design that does not exist, and never authorizes restoring Auth's former authority. No universal administrator or
    database-repair bypass applies.
- **Backup timing around the cutover:** the policy is the daily backup. ADR-0040 does not mandate a backup immediately before or after
  F6; an additional cutover backup can be approved in the G6 rehearsal plan.

## 8. Validation (repository and local; no production)

- `scripts/deploy-tests/backup-restore.test.mjs` (fake Docker, real OpenSSL/tar): the whole flow, every failure stage (nothing
  uploaded, no plaintext left), encryption failure, a private key on the host, upload and HEAD failures, retention (30 days kept;
  look-alike keys, other services and other prefixes never touched; failure exits 3), configuration refusals, the drill's
  isolation, ordering and every fail-closed check.
- A local end-to-end drill (PostgreSQL 16.15, synthetic data, a disposable key pair, an S3 API test double, the real Organization and
  Auth images): both backups encrypted, uploaded and verified, retention enforced against a real S3 API, the source databases
  removed, then both drills passed (Organization 11 checks, 50 facts; Auth 10 checks, 95 facts); the restored pending outbox row
  stayed pending with no network.
- V2 A13 (audit-service): the same test file covers the Audit backup (owner dump, REQUIRED_DATA, integrity facts, three-service
  retention, partial failure), byte-identical Auth and Organization facts SQL, and the Audit drill (order, isolation, disposable broker,
  O3-B notice, assertion, controls, consumer, known-record read, cleanup); `audit-deploy.test.mjs` covers the deploy's
  `schema_migrations` narrowing and assertion. The local end-to-end Audit drill is A13.3 evidence (the
  [A13 record](../architecture/core-v2-a13-audit-backup.md)).
