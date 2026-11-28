# Refund response recovery (Payment, development and simulation only)

Core V2 D-R1D / D-R1E (migrations `0039`, `0040`). The separate process that applies stored refund dispatch answers no decision applied:
for example, after a crash, or after a failed decision transaction. **Development and simulation only.** It is refused when `NODE_ENV=production`.
No production role, credential or deployment exists for it.

- **What it does:** applies each stored answer once, with the same decision the dispatch would have made, under the attempt lock.
- **What it never does:**
  - call a provider;
  - record a send or an answer;
  - record refund failure finality (a recovered rejection is an uncertified `failed`, which D-R1B treats as possibly payable);
  - release, retry, reallocate or schedule anything.
- **What the database enforces** for the recovery role, whatever privileges it is later given:
  - **identity:** the role is registered in `refund_recovery_role`;
  - **status changes:** only a transition matched, at commit, by its own recovery application of a stored answer of that attempt, provider and key;
  - **application effects:** only the effect the decision gives;
  - **outbox:** only its own two audit intents, byte-exact;
  - **never:** a payment update or `workAfter`.

**Secrets.** Never paste a password, connection string or `.env` line into a ticket, chat or command history. Every `<…>` is yours to fill in.

Related:
- design: [`core-v2-d-r1-refund-finality.md`](../architecture/core-v2-d-r1-refund-finality.md) §4b;
- [payment-service README](../../apps/payment-service/README.md);
- migrations `0039_dr1d_durable_dispatch_responses.sql` and `0040_dr1e_recovery_authority.sql`.

## 1. Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `REFUND_RECOVERY_DATABASE_URL` | yes | none | The recovery role's connection to Payment's database. **Never** payment-service's `DATABASE_URL`; there is no fallback to it. |
| `PAYMENT_REFUND_RESPONSE_RECOVERY_AFTER_MS` | no | `30000` | Only answers stored longer ago than this are applied (1 000 to 3 600 000). A technical window: it proves no provider finality and permits no dispatch. |
| `NODE_ENV` | no | none | `production` is refused. |

The process reads nothing else and connects to nothing else: no broker, no Auth, no provider.

## 2. The restricted role, in order

1. **Create the role.** Locally, `infra/postgres/init` creates `payment_refund_recovery` on a fresh volume when `PAYMENT_REFUND_RECOVERY_PASSWORD` is set (`.env.example` carries a development value). It gets LOGIN, CONNECT on `payment` and USAGE on the schema, nothing more. It must not be a member of any role.
2. **Apply Payment's migrations** (`npm run migrate -w payment-service`, as the migrator). Migration `0040` grants and registers the conventional role when it already exists.
3. **For a role created after the migrations,** the schema owner runs `SELECT payment_grant_refund_recovery('<role>'::regrole);` once.

   The grant refuses any role that:
   - can record finality, sends or answers (column-level grants included);
   - owns the schema;
   - is a superuser, or bypasses row security;
   - is a member of another role.

   It registers the role permanently. A dropped and recreated role is a new role: run the grant again.

Never give the recovery role more rights. Even if someone does, the database refuses it finality, sends, answers, foreign events and scheduling by its registered identity, and the process refuses to start (exit 4).

## 3. Running it

- **One pass:** `npm run refund-recovery -w payment-service -- --once`, from a built `dist/`.
- **Continuous:** `npm run refund-recovery -w payment-service` (a pass every 5 s).
- **Local compose (opt-in):** `docker compose --profile db --profile refund-recovery up -d payment-refund-recovery`. The `db` profile alone never starts it.

Each pass prints one JSON line, `{"pass":"refund_response_recovery","applied":<n>}`, with counts only.

**Exit codes** (every message is fixed text: never a connection string, credential, role or database name):

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | `--once` completed | nothing |
| 2 | configuration refused (missing or malformed variable, production, out-of-range window, unknown argument) | fix the variable; do not point it at `DATABASE_URL` |
| 3 | the recovery database cannot be reached, or refused the credentials | check the database is up and the recovery password; never substitute another role |
| 4 | authority refused: the role is not a proper, registered recovery role | run the grant (§2); revoke any extra rights or memberships |
| 1 | any other failure | read the error name; retry; escalate if it persists |

## 4. Shutdown, supervision and multiple workers

- **Graceful shutdown:** SIGTERM or SIGINT finishes the current pass, then closes the pool. The compose service allows 15 s.
- **Supervision:** the compose service restarts `on-failure` up to five times, so a configuration, connection or authority refusal stops visibly instead of looping. Outside compose, use your own supervisor with the same bounded-restart rule.
- **Multiple workers are safe.** Each answer is applied once: the attempt row lock serializes, and the application's primary key refuses a second. A second worker only finds nothing left to do.

## 5. Detecting stalled recovery, and what the Owner sees

- **The Owner sees stalled work.** PAY-12 (Owner only, Company-scoped) lists `refund_dispatch_response_unapplied`: a stored answer no decision applied after `PAYMENT_REFUND_RESPONSE_ITEM_AFTER_MINUTES` (default 15). If recovery is not running, or keeps failing, these items accumulate.
- **Unanswered sends are separate.** `refund_dispatch_send_unobserved` lists sends with no stored answer, an UNKNOWN outcome. Recovery cannot resolve those; only the existing status reads do. They stay visible even after the attempt reaches a final state.
- **Logs to watch:** `refund_dispatch_response_recovery_failure` (one answer failed, retried next pass) and `refund_dispatch_response_recovered` (applied).
- **No metric yet.** Core has no metrics platform for this process; alert routing is an operational prerequisite before any non-development use.

## 6. Behaviour when recovery is unavailable

Nothing moves. While an attempt has a stored, unapplied answer, payment-service does not work it: no resend and no status read. The answer waits, durable and Owner-visible. Starting recovery later applies it once.

## 7. Ordering and rollback

**Order:**
1. migrations `0039` and `0040`;
2. the role and its grant (§2);
3. start the process.

Payment-first is safe: without the process, answers simply wait (§6).

**Rollback:**
- Stop the process.
- To withdraw its connection, revoke CONNECT from the role. The registry row is permanent and append-only, and keeps refusing that identity.
- Never delete applications, answers or sends: they are evidence.
- Do not roll back migration `0040`. Its guards are what keep a recovery identity from acting as the dispatch.

## 8. Troubleshooting without exposing secrets

- **Check the role's rights** as the schema owner (this prints no secret):

  ```sql
  SELECT has_any_column_privilege('<role>', 'refund_attempt_failure_finality', 'INSERT')
  ```

  Then confirm the role is registered: `SELECT count(*) FROM refund_recovery_role WHERE role = '<role>'::regrole::oid`.
- **Stuck answers:** look at the PAY-12 `refund_dispatch_response_unapplied` items (`detail.classification` and `detail.attemptStatus`), and the `refund_dispatch_response_recovery_failure` log line for the same observation.
- **Never connect the process as another role to "unstick" it.** The database refuses any role other than a registered recovery role from acting as recovery, and it refuses the runtime role recovery's label.
