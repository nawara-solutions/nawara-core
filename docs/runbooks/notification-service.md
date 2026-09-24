# notification-service runbooks

Operational procedures for the Notification Service (Stage 16.9). Signals are structured JSON log lines (`msg` field); Core has no
metrics platform, so alert rules are log-based (§1). Never paste a key, token, destination, code or provider response into a ticket,
chat or command history. Every placeholder below (`<…>`) is yours to fill; no real value appears in this document.

Related: [service README](../../apps/notification-service/README.md), [SDD](../sdd/notification-service.md),
[Stage 16.9 record](../architecture/stage-16/stage-16-9-security-operations.md), [production readiness](../architecture/production-readiness.md).

## 1. Signals and alert rules

| Signal (`msg` starts with) | Level | Alert when | Runbook |
|---|---|---|---|
| `provider_auth_fault` | error | any occurrence (credentials or account refused) | §4 |
| `provider_config_fault` | error | any occurrence (wrong SID, sender, path, geo permission) | §4 |
| `notification_provider_failure … code=provider_rate_limited` | warn | sustained: > 20 in 10 min | §5 |
| `notification_provider_failure … code=provider_unreachable` / `provider_unavailable` / `provider_gateway_timeout` / `provider_timeout` | warn | sustained: > 20 in 10 min | §6 |
| `notification_ops_snapshot … oldestDueAgeSec=N` | info | N > 300 for 3 consecutive snapshots | §7 |
| `notification_ops_snapshot … due=N` | info | N growing for 15 min | §7 |
| `notification_ops_snapshot … staleLeases=N` / `notification_delivery_lease_recovered` | info / warn | N > 0 for 3 snapshots, or > 10 recoveries in 10 min | §7 |
| `notification_delivery_unconfirmed` | warn | > 10 in 1 h (or any for a SECURITY template, per product policy) | §8 |
| `notification_delivery_failed` with `code=retries_exhausted` | warn | > 10 in 1 h | §6 |
| `notification_delivery_failed` with `bucket=notif_dest` and `code=rate_limited` | warn | > 20 in 1 h (abuse or a producer loop) | §9 |
| `notification_secret_key_missing` | error | any occurrence | §10 |
| `notification_secret_purge_pass_failure`, `notification_retention_pass_failure`, `notification_worker_pass_failure` | error | 3 in 5 min | §11 |

Readiness (`/ready`) covers the database, migrations and RabbitMQ only: a provider outage never takes the service out of rotation.

## 2. Secret-encryption key rotation and retirement (`NOTIFICATION_SECRET_KEYS`)

Codes are sealed with the active key and purged at terminal state or `expiresAt`, so an old key empties on its own; nothing is
re-encrypted.

1. Generate a key: `openssl rand -base64 32`. Store it in the secret store only.
2. Deploy with both keys, the new one active: `NOTIFICATION_SECRET_KEYS=k1:<old>,k2:<new>`, `NOTIFICATION_SECRET_ACTIVE_KEY_ID=k2`.
   New codes use `k2`; `k1` codes still open.
3. Wait until `k1` is unused: `npm run secret-keys -w notification-service -- usage` (or `node dist/cli/secret-keys.js usage` in the
   image, `DATABASE_URL` = the runtime role) shows no `k1` row. Typically `max(expiresAt)` of `k1` rows plus one purge interval;
   a row with `anyWithoutExpiry: true` keeps the key until its deliveries end.
4. Verify: `… secret-keys -- retire-check k1` exits **0** (it exits 3 while `k1` is active or referenced).
5. Deploy with `NOTIFICATION_SECRET_KEYS=k2:<new>` only. Destroy `k1` in the secret store.

**Do not** remove a key while `retire-check` exits 3: its codes become undeliverable (`FAILED render_failed`) and the
`notification_secret_key_missing` alarm fires. **Rollback:** put the old key back in the ring (never remove the new one while it is
active or referenced).

## 3. Request-hash key rotation (`NOTIFICATION_REQUEST_HASH_KEY`)

New requests are hashed with the current key; a retry is compared under the current key and up to two previous keys.
1. Generate a new key. Deploy `NOTIFICATION_REQUEST_HASH_KEY=<new>`, `NOTIFICATION_REQUEST_HASH_PREVIOUS_KEYS=<old>`.
2. Keep the previous key at least for the callers' retry window (recommended: 7 days; no caller retries an `Idempotency-Key` longer).
3. Remove `NOTIFICATION_REQUEST_HASH_PREVIOUS_KEYS`. A retry of a request accepted under the removed key now gets
   `422 idempotency_key_reused` (never a second intent).

**Do not** swap the key without listing the old one as previous (honest retries would get `422`). **Rollback:** make the old key
current again and list the new one as previous.

## 4. Provider credentials and sender changes (Resend, Twilio)

Credentials come only from the environment (or `*_FILE`); nothing is stored in the database, so rotation is a configuration deploy.

**Resend API key:** create a second key in Resend (sending access) → deploy `NOTIFICATION_RESEND_API_KEY=<new>` → verify a
`notification_delivery_sent … provider=resend` line and no `provider_auth_fault` → revoke the old key in Resend. **Twilio API key:**
create a new API key (SID + secret) → deploy `NOTIFICATION_TWILIO_API_KEY_SID` / `_SECRET` → verify a `provider=twilio` send →
delete the old key in Twilio. **Rollback:** redeploy the previous values (only before revoking them).

**Senders:** `NOTIFICATION_EMAIL_FROM` (a Resend-verified domain: SPF, DKIM; DMARC advised) and
`NOTIFICATION_TWILIO_MESSAGING_SERVICE_SID` (its senders, alphanumeric IDs and country rules live in Twilio). A change is a deploy;
verify the domain or Messaging Service first. No migration is involved; callers can never set a sender.

**On `provider_auth_fault` / `provider_config_fault`:** impact: that channel's deliveries retry with backoff and end
`FAILED retries_exhausted` after `NOTIFICATION_MAX_ATTEMPTS` (about 7.5 min at the defaults); codes may expire. Action: check the
key's status in the provider console, the Messaging Service / geo permissions, the sending domain; fix the configuration and deploy.
**Do not** raise `NOTIFICATION_MAX_ATTEMPTS` to "wait it out"; **do not** paste the failing key anywhere.

## 5. Provider rate limiting (`provider_rate_limited`)

The worker already honours `Retry-After` (bounded by `NOTIFICATION_RETRY_CEILING_MS`) and backs off per delivery; nothing hammers
the provider. Action: check the provider plan and throughput limits; if sustained, lower `NOTIFICATION_WORKER_CONCURRENCY` or ask
the provider for a higher limit. **Do not** restart the service to "clear" it (the schedule is in the database).

## 6. Provider outage (`provider_unreachable`, `provider_unavailable`, gateway / timeout)

Impact: deliveries on that channel back off (at most `NOTIFICATION_MAX_ATTEMPTS` calls each, then `retries_exhausted`); the API and
event intake keep accepting work; `/ready` stays 200. Ambiguous results (timeout, 502 / 504) follow the frozen §8.5 policy. Action:
check the provider status page; nothing to do in Notification while it recovers. After a long outage, `retries_exhausted`
deliveries are final: producers re-request (a user asks for a new code). There is no circuit breaker (Stage 16.9 record §8).

## 7. Delivery backlog

Detect: `notification_ops_snapshot` (`due`, `oldestDueAgeSec`, `retrying`, `staleLeases`). Query (runtime role, no personal data):

```sql
SELECT channel, count(*) AS due, min("nextAttemptAt") AS oldest_due, count(*) FILTER (WHERE attempts > 0) AS retrying
  FROM notification_delivery WHERE status = 'PENDING' AND "nextAttemptAt" <= now() GROUP BY channel;
SELECT count(*) FILTER (WHERE "leaseUntil" >= now()) AS sending, count(*) FILTER (WHERE "leaseUntil" < now()) AS stale_leases
  FROM notification_delivery WHERE status = 'SENDING';
```

Causes: provider degradation (§5, §6); too few workers (`NOTIFICATION_WORKER_CONCURRENCY`, replicas); database pressure. Stale leases
are recovered automatically every pass (attempt evidence decides). **Do not** update delivery rows by hand; **do not** reset
`SENDING` rows to `PENDING` (a started attempt may have reached the provider).

## 8. `UNCONFIRMED` investigation

`UNCONFIRMED` = the provider may or may not have delivered (a lost answer), and the message was not a resendable code. Look at the
attempt rows (outcome `AMBIGUOUS`, `failureCode`, `latencyMs`) and the provider console by `providerMessageId` when present. Nothing
is resent automatically (by design: no duplicate alerts). A spike usually means provider timeouts (§6) or worker kills (`worker_lost`).

## 9. Destination limiting (`notif_dest`)

`FAILED rate_limited bucket=notif_dest`: one destination got more than `NOTIFICATION_RATE_DESTINATION_LIMIT` sends in
`NOTIFICATION_RATE_DESTINATION_WINDOW_SEC` (30 per hour by default) across all callers: abuse, or a producer loop. Find the producer
from the `caller` / `template` of the intents (never by searching destinations in logs: there are none). The limiter state holds only
HMACs.

**Limiter key rotation** (`NOTIFICATION_DESTINATION_LIMIT_KEY`): deploy the new key with the old one as
`NOTIFICATION_DESTINATION_LIMIT_PREVIOUS_KEY`; both buckets are counted (no reset, no burst). After one window, remove the previous
key. Removing it early resets every destination's count once.

## 10. `notification_secret_key_missing`

A live ciphertext references a key id absent from `NOTIFICATION_SECRET_KEYS`: a key was removed too early. Impact: those codes fail
`render_failed` when due. Action: restore the key in the ring immediately (from the secret store) and redeploy; then follow §2.

## 11. Worker pass failures (secret purge, retention, delivery)

The loops retry every interval; the failure lines carry the error class and code only. Usually database availability (check the
kit's database signals). A persistent secret-purge failure means codes stay sealed past their terminal state: fix the database issue;
the purge catches up by itself (bounded batches). Retention only removes expired rate-limit windows; a failure there is harmless for
correctness (the limiter resets expired windows itself).
