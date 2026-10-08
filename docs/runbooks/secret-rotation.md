# Secret and key rotation (Core, all services)

- **Status:** the cross-service reference (V2 A2.4, owner decision OD-A2-7). It states what the code supports **today**; it adds no
  mechanism. A rotation in production is a deliberate, owner-authorized change, never part of another task. Detailed procedures stay in
  the service runbooks linked below.
- **Related:** [A2 record](../architecture/core-v2-a2-configuration-and-secrets.md) (decisions); each service's README "Environment" /
  "Configuration" table (variables); the root `.env.example` (local development values only).

## 1. Kinds of secret (they do not rotate the same way)

| Kind | What a change does |
|---|---|
| **Encryption key in a ring** (id + key, an active id) | old data stays readable under its old key; new data uses the active key; re-encrypt, then retire the old key |
| **HMAC key with previous keys** | values computed under the old key are still recognised for a bounded window; then the old key is removed |
| **HMAC key without previous keys** | everything computed under the old key stops matching at once (acceptable only where that is harmless) |
| **Pepper** (an HMAC input to a stored one-way hash) | every stored hash stops verifying; the inputs are not kept, so nothing can be re-derived. **No transparent rotation** |
| **Signing key in a ring** (JWT, ADR-0058) | tokens carry the signing key's id; a new key verifies first, then signs; the old key is removed after the longest token lifetime. Without the ring, every token signed with the old key is rejected at once |
| **Caller token / digest** | caller and callee change together; the callee accepts two digests per caller, which gives an overlap |
| **Infrastructure or provider credential** | changed at the database, the broker or the provider, then delivered and the service restarted |

## 2. Matrix

`_FILE`: "yes" means the value may be supplied as `NAME_FILE=/path`. Production delivers configuration as a plain `--env-file` today; no
`_FILE` delivery is active (owner decision OD-A2-6).

| Secret | Service | Kind | Supported today | How / effect | `_FILE` | Procedure |
|---|---|---|---|---|---|---|
| `JWT_SECRET` + `JWT_SIGNING_KEYS` + `JWT_ACTIVE_KEY_ID` | Auth | HS256 signing-key ring with a kid-less legacy key (ADR-0058) | **yes, with overlap** (images from A4.8 on) | add a verification key, activate it, wait 3600 s + 5 min after the last instance stopped signing with the old key, remove the old key. Without a ring (or for an emergency), replacing `JWT_SECRET` rejects every access token at once; refresh tokens are unaffected, so clients refresh | yes | §4 |
| `TOTP_ENCRYPTION_KEYS` + `TOTP_ENCRYPTION_ACTIVE_KEY_ID` | Auth | encryption key ring | **yes** | add the new `id:key`, make it active, re-encrypt with `reseal-totp-keys`, remove the old key only at "still under an old key: 0". An id or a key may not repeat | yes | [Auth README](../../apps/auth-service/README.md), Operations |
| `OPERATOR_CODE_PEPPER`, `SECRET_KEY_PEPPER`, `THROTTLE_KEY_PEPPER`, `JOIN_CODE_PEPPER` | Auth | peppers | **no** | §3 | yes | §3 |
| `NOTIFICATION_SECRET_KEYS` + `NOTIFICATION_SECRET_ACTIVE_KEY_ID` | Notification | encryption key ring | **yes** | add, activate, wait until the old id is unused (`secret-keys usage`, `retire-check`), then remove | yes | [Notification runbook](notification-service.md) §2 |
| `NOTIFICATION_REQUEST_HASH_KEY` + `NOTIFICATION_REQUEST_HASH_PREVIOUS_KEYS` (at most 2) | Notification | HMAC with previous keys | **yes** | deploy the new key with the old one listed as previous for the idempotency window, then remove it | yes | [Notification runbook](notification-service.md) §3 |
| `NOTIFICATION_DESTINATION_LIMIT_KEY` + `NOTIFICATION_DESTINATION_LIMIT_PREVIOUS_KEY` | Notification | HMAC with one previous key | **yes** | deploy the new key with the old one as previous for one limiter window, then remove it; without a previous key the per-destination counters restart | yes | same model as §3 of the Notification runbook |
| `FILE_REQUEST_HASH_KEY` + `FILE_REQUEST_HASH_PREVIOUS_KEYS` (at most 2) | File | HMAC with previous keys | **yes** | deploy the new key with the old one as previous for the callers' retry window, then remove it | yes | [File runbook](file-service.md) §7 |
| `FILE_RATE_LIMIT_KEY` | File | HMAC, no previous key | **yes** | replace: the failed-redemption windows restart | yes | [File runbook](file-service.md) §7 |
| `RELEASE_RATE_LIMIT_KEY` | Release | HMAC, no previous key | **yes** | replace: the public rate-limit buckets restart | yes | [Release runbook](release-service.md) |
| Caller service tokens (`PAYMENT_SERVICE_TOKEN` in Billing, `ORGANIZATION_SERVICE_TOKEN` in Auth, `ORGANIZATION_REFERENCE_TOKEN` in Billing and Payment) and the callee's `SERVICE_TOKENS` digests | caller and callee | bearer token; SHA-256 digest | **yes, coordinated** | the callee accepts at most two digests per caller: add the new digest, move the caller to the new token, remove the old digest. `register-caller.sh` (Organization) never rotates a token on its own | yes (Auth: `ORGANIZATION_SERVICE_TOKEN` through its secret source) | [File runbook](file-service.md) §7; [Organization runbook](organization-production.md) §4 |
| `DATABASE_URL` password (runtime role) | every service | database credential | Auth: **yes, tooled**. Others: **manual** | Auth: the `auth-db-credential-rotate.yml` workflow. Others: give the runtime role a new password, deliver the new URL, restart | kit services: yes. Auth: **no** (**A4**) | [Auth credential rotation](auth-db-credential-rotation.md); [File runbook](file-service.md) §7 |
| `RABBITMQ_URL` identity | every service | broker credential | **manual, deliberate** | `rabbitmqctl change_password` (stdin), then the broker's `clients/<service>.env` and the service's `.env` together, then redeploy; the scripts never rotate | kit services: yes. Auth: **no** (**A4**) | [RabbitMQ runbook](core-rabbitmq-production.md) |
| `FILE_S3_ACCESS_KEY_ID`, `FILE_S3_SECRET_ACCESS_KEY` | File | provider credential | **yes** (two keys at the provider) | create the new key, deploy it, then revoke the old one | yes | [File runbook](file-service.md) §7 |
| `NOTIFICATION_RESEND_API_KEY` | Notification | provider credential | **yes** (provider-side) | §5 | yes | §5 |
| `NOTIFICATION_TWILIO_API_KEY_SID` + `NOTIFICATION_TWILIO_API_KEY_SECRET` | Notification | provider credential (a key pair) | **yes** (provider-side) | §5 | yes | §5 |
| `SWAGGER_PASSWORD` | every service | operator credential | **yes** | set a new value of at least 16 characters and restart; nothing else depends on it | yes (Auth: through its secret source) | §6 |
| `BOOTSTRAP_OWNER_PASSWORD` | Auth CLI | one-time bootstrap input | not applicable | used once by `bootstrap-owner`; it is not a stored configuration secret. The owner then changes the password through the product | no | [Auth README](../../apps/auth-service/README.md), Operations |

There is no payment-gateway credential: Payment has only its development `test` provider.

## 3. The four Auth peppers cannot be rotated transparently

Each pepper is the key of a one-way HMAC whose **result** is stored or compared; the original input (a code, a key, a contact) is not
kept, so no stored value can be recomputed under a new pepper. Changing one is a breaking operation with these effects:

| Pepper | What stops working |
|---|---|
| `OPERATOR_CODE_PEPPER` | every outstanding operator login code (short-lived: operators request a new one) |
| `SECRET_KEY_PEPPER` | **every existing owner secret key fails verification**: owners must go through recovery or a forced reset |
| `THROTTLE_KEY_PEPPER` | throttle bucket identities change, so every counter restarts |
| `JOIN_CODE_PEPPER` | outstanding join codes, invitation codes and contact-verification codes no longer resolve, and the stored invitee-contact hashes no longer match (duplicate-contact detection starts over) |

A dual-pepper scheme does not exist and is not planned in A2. If a pepper is believed compromised, changing it is still the right
response; plan it as an incident, with the effects above announced.

## 4. `JWT_SECRET` and the JWT signing-key ring (ADR-0058)

**Supported from:** the ring in Auth images from A4.7 (#250) on; the deploy safeguards (no regenerated `JWT_SECRET`, the configuration
check before migrations) in images from **A4.8** on. Production configures no ring until an owner-authorized checkpoint does. Design:
[ADR-0058](../adr/0058-access-token-signing-key-ring.md) and the [A4 record](../architecture/core-v2-a4-authentication.md) §10.

### 4.1 How the keys work

- `JWT_SECRET` is the **legacy key**: it signs **kid-less** tokens (header `{"alg":"HS256"}`) when it is the active key, and verifies
  kid-less tokens while it is set.
- `JWT_SIGNING_KEYS` (`id:base64[,id:base64]`, at most **3** keys) and `JWT_ACTIVE_KEY_ID` (a ring id, or `legacy` meaning
  `JWT_SECRET`) are set **together**. A ring key signs with header `{"alg":"HS256","kid":"<id>"}`.
- Verification uses exactly one key: no `kid` → `JWT_SECRET` (refused once it is removed); a `kid` → that ring key only. There is no
  fallback to any other key.
- Ids are **public** (every token header shows them): use a date-style id such as `k2026-10`, never anything secret. `legacy` is reserved.
- An access token lives at most `ACCESS_TOKEN_TTL_SEC` (900 s by default, **3600 s at most**). A token refused because its key changed is
  recovered by a normal refresh: refresh tokens are opaque database rows that no signing key touches.

### 4.2 Rules for every step

1. **Owner authorization per step.** Each step below is a separate production change: the owner authorizes it, then
   `auth-service-deploy.yml` runs (approval of the protected `production` environment) with the digest that is deployed, or an
   approved newer one. Nothing in this section is ever part of another task.
2. **Recreate, never restart.** Docker fixes a container's environment when the container is created: `docker restart` (and the
   container's own restart policy) keeps the **old** keys and does **not** apply an edited `.env`. A key change takes effect only when
   the deploy script recreates the container. Never use `docker restart` or a hand-made `docker run` for a key change.
3. **The configuration check gates the step.** From A4.8 on, the deploy runs the image's own loader on the `.env`
   (`dist/cli/check-config.js`) **before any migration and before the running service is touched**; a refusal stops the deploy (no
   migration; the running service untouched; entries the deploy adds to `.env` may already be written). Run the same check on the server before dispatching ([deploy runbook](auth-service-deploy.md) §2) and compare its
   line with the mode the step expects (below). It prints the mode and key counts only, never a value or a ring id.
4. **Fresh material, never echoed, edited in place.** Generate each key on the server and write it with the procedure of §4.2.1;
   never paste, print, log or copy a key elsewhere (no ad-hoc copies of the `.env` either: they are backups of every key). Every key
   must differ from every other Auth key (the check refuses reuse across purposes).
5. **Image floor.** Once any `JWT_*` ring variable is in the server `.env`, deploy only Auth images **from A4.8 on** (§4.11).
6. **Evidence, names only:** the dispatch, the check line, the time the deploy finished, and the container names. Never a value.

#### 4.2.1 Editing the server `.env` safely

**One declaration per JWT variable.** Each of `JWT_SECRET`, `JWT_SECRET_FILE`, `JWT_SIGNING_KEYS`, `JWT_SIGNING_KEYS_FILE`,
`JWT_ACTIVE_KEY_ID` and `JWT_ACTIVE_KEY_ID_FILE` appears **at most once**, as a plain `NAME=value` line at the start of a line (no
leading whitespace, no `export`, no space before `=`). Never append a second declaration of a variable that exists: Docker would apply
only one of them, and the loader (so the configuration check) would never see the other. From A4.8 on the deploy refuses duplicate or
malformed JWT lines before changing anything; check before editing anyway.

Run the edits as the deploy user, in a shell whose history is not kept for these lines, on the server only. Key material never appears
on a command line: `printf`, `export` and `read` are shell builtins (no new process), and `awk` receives values through its environment
(`ENVIRON`), not its arguments. The edit goes to a temporary file in the same directory, which then **atomically replaces** the `.env`
with its mode kept (`0600`).

```bash
F="$HOME/nawara-core/auth-service/.env"
JWT_NAMES='JWT_SECRET JWT_SECRET_FILE JWT_SIGNING_KEYS JWT_SIGNING_KEYS_FILE JWT_ACTIVE_KEY_ID JWT_ACTIVE_KEY_ID_FILE'
count() { grep -c "^$1=" "$F" || true; }              # prints a number, never a value
jwt_ok() {                                           # STOP on a duplicate or malformed JWT line (the deploy's own rule)
  local n loose exact
  for n in $JWT_NAMES; do [ "$(count "$n")" -le 1 ] || { echo "STOP: $n is declared more than once"; return 1; }; done
  loose=$(grep -cE '^[[:space:]]*(export[[:space:]]+)?JWT_(SECRET|SIGNING_KEYS|ACTIVE_KEY_ID)(_FILE)?[[:space:]]*(=|$)' "$F" || true)
  exact=$(grep -cE '^JWT_(SECRET|SIGNING_KEYS|ACTIVE_KEY_ID)(_FILE)?=' "$F" || true)
  [ "$loose" = "$exact" ] || { echo "STOP: a malformed JWT line"; return 1; }
  echo "JWT lines OK"
}
edit_env() {                                         # edit_env '<awk program>': temp file, same mode, atomic replace
  local t; t=$(mktemp "$F.XXXXXX") || return 1
  if awk "$1" "$F" >"$t" && chmod --reference="$F" "$t" && mv -f "$t" "$F"; then return 0; fi
  rm -f "$t"; return 1
}
jwt_ok                                               # before every edit: continue only on "JWT lines OK"
```

| Change | Precondition | Command |
|---|---|---|
| **Add** a variable that is absent (step 1) | `count JWT_SIGNING_KEYS` and `count JWT_ACTIVE_KEY_ID` print `0` | `KEY=$(openssl rand -base64 32); printf 'JWT_SIGNING_KEYS=%s:%s\n' k2026-10 "$KEY" >>"$F"; printf 'JWT_ACTIVE_KEY_ID=legacy\n' >>"$F"; unset KEY` |
| **Replace** the active id (step 2, a rollback) | `count JWT_ACTIVE_KEY_ID` prints `1` | `export V=k2026-10; edit_env '/^JWT_ACTIVE_KEY_ID=/{print "JWT_ACTIVE_KEY_ID=" ENVIRON["V"]; next} {print}'; unset V` |
| **Add a key to the ring** (a later rotation) | `count JWT_SIGNING_KEYS` prints `1`; the id was never used | `export ADD="k2026-11:$(openssl rand -base64 32)"; edit_env '/^JWT_SIGNING_KEYS=/{print $0 "," ENVIRON["ADD"]; next} {print}'; unset ADD` |
| **Remove a key from the ring** (retire a ring key) | `count JWT_SIGNING_KEYS` prints `1`; the id is not the active one | `export ID=k2026-10; edit_env '/^JWT_SIGNING_KEYS=/{n=split(substr($0,18),a,","); o=""; for(i=1;i<=n;i++) if (index(a[i], ENVIRON["ID"] ":")!=1) o=o (o==""?"":",") a[i]; print "JWT_SIGNING_KEYS=" o; next} {print}'; unset ID` |
| **Replace** `JWT_SECRET`'s value (emergency, §4.12) | `count JWT_SECRET` prints `1` | `export NEWKEY=$(openssl rand -base64 32); edit_env '/^JWT_SECRET=/{print "JWT_SECRET=" ENVIRON["NEWKEY"]; next} {print}'; unset NEWKEY` |
| **Remove** a retired variable (step 4: `JWT_SECRET`) | `count JWT_SECRET` prints `1` | `edit_env '!/^JWT_SECRET=/'` |

**Validate before any deployment**, and stop on any mismatch: `jwt_ok`; each JWT name's `count` is the expected `0` or `1`;
`stat -c '%a' "$F"` prints `600`; the names-only listing `sed 's/=.*//' "$F"` shows the expected names; and the candidate image's
configuration check ([deploy runbook](auth-service-deploy.md) §2) prints the mode the step expects. Only then dispatch the deploy. A
failed edit leaves the previous file in place (the temporary file is removed); never "fix" a refusal by appending another line.

### 4.3 Step 0: legacy only, on a ring-capable image

Deploy an A4.8 (or later) image with the `.env` **unchanged**. Expected check: `JWT: legacy only (JWT_SECRET signs and verifies)`.
Tokens are byte-identical to an image without the ring. Image rollback to any earlier image is safe.

### 4.4 Step 1: add a verification key

Add `JWT_SIGNING_KEYS=<new id>:<fresh key>` and `JWT_ACTIVE_KEY_ID=legacy` (§4.2.1, **Add**); deploy. Expected check:
`JWT: ring (active: legacy, ring keys: 1, verification only)`. `JWT_SECRET` still signs; the new key only verifies. Rollback: remove the two
lines and deploy (safe), or roll the image back (safe: an older image ignores the two variables).

### 4.5 Step 2: switch the active signing key

Replace the value of `JWT_ACTIVE_KEY_ID` with `<new id>` (§4.2.1, **Replace**; never a second line); deploy. Expected check:
`JWT: ring (active: a ring key, ring keys: 1, legacy key: kept)`. New tokens carry
the `kid`; kid-less tokens still verify. **Record when the deploy finished**: the step-1 container is stopped during the swap (stop
grace at most 60 s), which starts the waiting period of §4.7.

### 4.6 Rollback, and what can bring old keys back

| Rollback | Effect |
|---|---|
| **Configuration** (`JWT_ACTIVE_KEY_ID` back to `legacy` or to the previous ring key, the newer key kept), then deploy | safe at every step **before** the previous key is removed. A return to the previous key **restarts** the §4.7 waiting period |
| **Image** to an image without the ring (before A4.7) | safe only at steps 0 and 1. After step 2 it rejects **every** ring-signed token until clients refresh. After step 4 it would also need `JWT_SECRET`, which may never be restored (§4.10): such a rollback is an emergency with a fresh legacy key |
| **Image** to an image before A4.8 | its own deploy script runs: it regenerates `JWT_SECRET` when absent and runs no configuration check (§4.11) |

- **Retained containers are instances.** Each deploy keeps the previous container stopped as
  `nawara-core-auth-service-previous-<timestamp>`, with the environment **it was created with**. Renaming one back
  ([deploy runbook](auth-service-deploy.md) §3), or the script's automatic restore after a failed health check, runs **its** keys and
  **its** active key again. Count it in §4.7 like any instance, and treat it as an image rollback when it predates the ring.
- **Backups.** `infra/backup/backup.sh` archives Auth's `.env` with the other secret files. A restored `.env` from before a key change
  carries the old keys (§4.10).

### 4.7 Step 3: the waiting period (3600 s + 5 min)

The previous signing key is removed no earlier than **3600 s + 5 min after the last Auth instance stopped issuing tokens with it**:
- the instant the **last** container whose active key was the previous key stopped: for one instance, the stop during the step-2
  deploy (§4.5); with several instances, the stop of the **last** of them to be recreated with the new active key; and any
  **retained or restarted** container (§4.6) that ran with the previous key active counts too, from the moment it was stopped again;
- 3600 s is the largest accepted `ACCESS_TOKEN_TTL_SEC`, so the rule holds whatever the configured lifetime; 5 min is the margin for
  clocks and the stop grace;
- any instance returning to the previous key (configuration rollback, a renamed-back container) **restarts** the count;
- while instances disagree on the active key, both keys must stay configured on every instance (ring keys verify on every instance that
  has them; a mix is safe only while every instance verifies both).

### 4.8 Step 4: retire `JWT_SECRET`

Only when **all** hold: the §4.7 period has passed; the deployed image is A4.8 or later (its
`apps/auth-service/deploy/provision-and-deploy.sh` never generates `JWT_SECRET` while any JWT key variable is present); the check on
the target `.env` (without `JWT_SECRET`) reports `legacy key: retired`; every retained `-previous-*` container that still holds
`JWT_SECRET` is removed with the owner's authorization, or the owner knowingly keeps it, accepting that renaming it back re-enables the
legacy key; and the owner authorizes the step, acknowledging the §4.6 limits.

Then **delete** the `JWT_SECRET` line (§4.2.1, **Remove**; do not leave it blank) and deploy. Expected check:
`JWT: ring (active: a ring key, ring keys: 1, legacy key: retired)`. Kid-less tokens are refused from then on.

### 4.9 Later rotations between ring keys

Repeat with ring keys only, at most 3 at a time, editing the one `JWT_SIGNING_KEYS` line in place (§4.2.1): add the next key (active
unchanged), deploy; activate it, deploy and record the time;
wait §4.7, measured from the last instance that stopped signing with the previous key; remove the previous key, deploy. Ids and keys
are never reused (§4.10).

### 4.10 Never reuse retired key material or ids

- A key that was removed (retired or compromised) is **never** configured again, as `JWT_SECRET` or in the ring, from any source. A new
  key is always freshly generated.
- A ring **id** that was ever used is never given to a new key: a stale token must never meet a different key under its old id.
- Old keys come back through: `.env` **backups** and their restores (replace the `JWT_*` lines of a restored `.env` taken before a key
  change with the current ones before deploying); **retained containers** (§4.6); an **older image's script** (§4.11); notes or copies
  outside the server. Each is checked before a retirement is declared complete.

### 4.11 Older images: what A4.8 cannot prevent

- The deploy script that runs is **the deployed image's own** (`docker run … cat deploy/provision-and-deploy.sh | bash`). An A4.8 script
  cannot protect against its replacement by an older image's script.
- Images **before A4.8** carry a script that **regenerates `JWT_SECRET`** whenever the line is absent (so a retired legacy key silently
  returns with an untracked value, and with `legacy` active it would even become the signing key) and that runs no configuration check.
- Images **before A4.7** ignore `JWT_SIGNING_KEYS` and `JWT_ACTIVE_KEY_ID` and **cannot verify ring-signed tokens**.
- Preventing a downgrade below A4.8 once a ring is configured would need a workflow-side gate (for example, `auth-service-deploy.yml`
  refusing a digest whose revision predates A4.8 while the server `.env` carries ring variables). That is a workflow and production
  policy change requiring **separate authorization**; it is not part of A4.8. Until then the image floor of §4.2 is enforced by the
  owner when choosing the digest to dispatch.

### 4.12 Emergency: a compromised key

The owner authorizes the change; the waiting period does **not** apply (a compromise overrides it); every token signed with the
compromised key is refused at once and clients refresh. Never delete `JWT_SECRET` and rely on a deploy to "generate a new one".
- **Production runs an image before A4.8 (today):** replace the `JWT_SECRET` **value in place** with a fresh one (§4.2.1, **Replace**
  `JWT_SECRET`), keeping the line, then deploy the current digest. Every access token is rejected. Do **not** remove the line: the older script
  would silently generate an untracked replacement.
- **A ring-capable image before A4.8 (A4.7):** as above; if a clean ring key exists, also make it the active key in the same change.
  `JWT_SECRET` is never removed under a script older than A4.8.
- **A4.8 or later:** in **one** change, make a clean ring key active (add a fresh one first if none exists) and delete `JWT_SECRET`;
  deploy. Expected check: `legacy key: retired`.
- **A compromised ring key:** remove it in one change; if it was active, make another ring key (or `legacy`) active in the same change.
- **Afterwards:** retained `-previous-*` containers that hold the compromised key are removed with the owner's authorization (renaming one
  back would re-enable it); backups taken before the change are marked as containing it and their `JWT_*` lines are never restored;
  the key and its id are never reused (§4.10); the evidence names variables only.

### 4.13 Checking without exposing a value

- The configuration check's one line (mode and counts), the deploy log's list of variable **names**, and `/auth/health`.
- Presence without the value: `grep -c '^JWT_SIGNING_KEYS=' "$HOME/nawara-core/auth-service/.env"`.
- Never `cat` the `.env`, never `grep` a key line without `-c`, never paste a key into a ticket, chat or log.

### 4.14 Owner checkpoints

| Checkpoint | Owner action |
|---|---|
| First deployment of an A4.8 (or later) image (step 0) | authorize the digest; approve `production` |
| Step 1, step 2, each later rotation step | authorize the `.env` change and the deploy; approve `production` |
| Step 4 (retirement) | confirm every §4.8 condition, including retained containers; authorize; approve `production` |
| An emergency (§4.12) | authorize the replacement or removal and the follow-up on containers and backups |
| Removing a retained container or marking a backup | separate explicit authorization (never implied by a deploy) |

## 5. Notification provider credentials

Provider keys are read at startup only and are shape-checked (`re_…` for Resend; `SK` + 32 hex and a 32-character secret for Twilio).

1. Create a **new** key at the provider (Resend: a new API key; Twilio: a new API key, which yields a new SID **and** secret; the account
   SID and the messaging-service SID are identifiers and do not change).
2. Deliver the new value(s): `NOTIFICATION_RESEND_API_KEY`, or `NOTIFICATION_TWILIO_API_KEY_SID` **and**
   `NOTIFICATION_TWILIO_API_KEY_SECRET` together.
3. Restart Notification and confirm a delivery succeeds (queued deliveries retry durably while a key is wrong).
4. Revoke the old key at the provider.

## 6. Handling secrets while operating

- Do not print a secret to read it back: `grep '^SWAGGER_' .env`, `cat .env` or `cat <caller>.token` put the value in the terminal
  scrollback (and a pasted log). Prefer a check that prints no value, for example `grep -c '^SWAGGER_PASSWORD=' .env`, and copy a value
  only when you need to use it.
- Do not type a secret inline in a command (`NAME=value command`): it stays in the shell history and the process list. Read it without
  echo (`read -rs`) or supply it from a file.
- A deploy never removes or rewrites an existing entry of a server `.env` (the scripts only add what is missing), so a rotation is
  always an explicit edit followed by a **deploy that recreates the container**: `docker restart` keeps the environment the container
  was created with and does not apply the edit.
- After a change, and before deploying a new image, the candidate-image configuration check prints only `OK` or `REFUSED`:
  [Auth](auth-service-deploy.md) §2, [Organization](organization-production.md) §2, [Audit](digest-deployments.md) §2.

## 7. Database roles and broker identities (what a credential is for)

- **Database, three roles per service:** the bootstrap owner of the database container (`<service>_admin`, or `auth` for Auth), the
  migration role (`<service>_migrator`, used only by the migration step) and the **runtime** role (`<service>_app`, DML only). A
  service's `DATABASE_URL` is always the runtime role: in production the services refuse `postgres`, `root`, `*_migrator`, `*_admin`
  (and `auth`) as the runtime user.
- **Broker:** the local Compose stack uses the broker's local-only `guest` account for every service. Production uses one identity per
  service, provisioned by `core-rabbitmq-provision.yml`, each limited to what that service publishes or consumes.

## 8. Not supported today (and where it belongs)

| Gap | Owner |
|---|---|
| JWT key ring / overlap window | done: A4.7 (ring) and A4.8 (deploy safeguards); see §4 |
| `_FILE` for Auth's `DATABASE_URL` and `RABBITMQ_URL`; Auth on the kit's reader | A4 |
| Production `_FILE` secret delivery (deploy scripts) | separately authorized production work (OD-A2-6) |
| Tooled database-credential rotation for services other than Auth | not planned in A2 |
| Pepper rotation | not planned |
| The operational CLIs reading through the kit's reader (`_FILE`, value-free errors) | done for the generic CLIs by A15.1 (the kit's four, Notification `secret-keys`, Audit `retention`; [A15 record](../architecture/core-v2-a15-developer-experience.md) §4); Auth's CLIs with A4; the Organization ownership CLI with A5 / F6 / F7 |
