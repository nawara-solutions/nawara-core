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
| **Signing key** (JWT) | every token signed with the old key is rejected |
| **Caller token / digest** | caller and callee change together; the callee accepts two digests per caller, which gives an overlap |
| **Infrastructure or provider credential** | changed at the database, the broker or the provider, then delivered and the service restarted |

## 2. Matrix

`_FILE`: "yes" means the value may be supplied as `NAME_FILE=/path`. Production delivers configuration as a plain `--env-file` today; no
`_FILE` delivery is active (owner decision OD-A2-6).

| Secret | Service | Kind | Supported today | How / effect | `_FILE` | Procedure |
|---|---|---|---|---|---|---|
| `JWT_SECRET` | Auth | signing key (HS256) | **not transparently** | one key: a change rejects every access token already issued (at most `ACCESS_TOKEN_TTL_SEC`, 15 minutes by default). Refresh tokens are opaque and stored hashed, so a session obtains a new access token by refreshing. No key id, no second verification key (**A4**) | yes | §4 |
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

## 4. `JWT_SECRET`

Today: generate a new value (`openssl rand -base64 32`), deliver it, restart Auth. Every access token issued before the restart is
rejected; clients recover by refreshing. There is no overlap window. A verification key ring (key ids, accepting the previous key
while signing with the new one) is **A4** work and is not implemented.

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
  always an explicit edit followed by a restart.
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
| JWT key ring / overlap window | A4 |
| `_FILE` for Auth's `DATABASE_URL` and `RABBITMQ_URL`; Auth on the kit's reader | A4 |
| Production `_FILE` secret delivery (deploy scripts) | separately authorized production work (OD-A2-6) |
| Tooled database-credential rotation for services other than Auth | not planned in A2 |
| Pepper rotation | not planned |
| The operational CLIs reading through the kit's reader (`_FILE`, value-free errors) | follow-up (A15); Auth's CLIs with A4; the Organization ownership CLI with A5 / F6 / F7 |
