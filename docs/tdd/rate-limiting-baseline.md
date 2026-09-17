# auth-service global request rate-limiting baseline

- **Status:** Implemented <!-- Draft | Reviewed | Implemented --> — unusual for this repo's
  normal Draft-before-code flow: the code below was already written and manually verified
  working before this TDD was written up. This document exists to bring already-shipped work
  into process conformance, not to plan work that hasn't happened yet.
- **Author:** Anwar (project owner)
- **Related SDD:** [docs/sdd/auth-service.md](../sdd/auth-service.md)
- **Related ADRs:** none. This is deliberately not ADR-worthy — `@nestjs/throttler` is an
  easily-reversible library/tooling choice, not an architectural decision with lasting
  consequences, the same treatment already given to the Swagger/OpenAPI integration.
- **Ticket/issue:** https://github.com/nawara-solutions/nawara-core/issues/19

## Problem

`docs/add/auth-service.md`'s non-functional-constraints section has flagged "rate limiting is
an undesigned gap" across essentially every public `auth-service` endpoint since early in this
design's history, and `docs/sdd/auth-service.md`'s Open questions section explicitly deferred
"login rate-limiting — `@nestjs/throttler` is a likely candidate" to a future TDD. This TDD
closes the **global-baseline** half of that gap: a floor that applies to every route in the
service with no per-controller wiring, protecting against gross abuse or misconfigured clients.
It does not close the endpoint-specific half — see Scope below.

## Approach

`@nestjs/throttler`, wired globally in `AppModule`:

- `ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])` — a single named-less throttler
  profile: 100 requests per 60,000ms (60s) window.
- `ThrottlerGuard` registered as `APP_GUARD` — a Nest global guard, so every route in every
  controller is covered automatically; no `@UseGuards(ThrottlerGuard)` or `@Throttle()`
  decorator needs to be added anywhere for the baseline to apply.

**Why 100 req/60s per IP:** this is a deliberately permissive, non-disruptive baseline, sized
to catch gross abuse or a badly misconfigured client (e.g. a retry loop with no backoff), not
to be the real defense for security-sensitive endpoints. It is generous enough that no
legitimate single client should ever hit it under normal use. The fine-grained, stricter limits
that security-sensitive endpoints (login, registration, code verification, secret-key login)
actually need are explicitly not what this number is trying to be — see Scope.

Keying is `@nestjs/throttler`'s default: per-IP, using the request's resolved IP address. No
custom `getTracker()`/storage override was written for this pass.

## Scope

**In scope:** the single global per-IP baseline described above, applied uniformly to every
route `auth-service` exposes, present or future.

**Explicitly out of scope, decided here as a deliberate boundary, not an oversight:**
per-endpoint stricter limits for the specific brute-force-sensitive endpoints
`docs/add/auth-service.md`'s non-functional-constraints section names by name:

- `POST /auth/login`
- `POST /auth/register`
- `POST /auth/admin/login/operator/request-code`
- `POST /auth/admin/login/operator/verify-code`
- `POST /auth/admin/operators/confirm`
- `POST /auth/admin/login/secret-key`
- the owner-only `AdminOperatorController` surface (per ADR-0012)

None of these endpoints exist as real code yet — `auth-service` currently has no implemented
business endpoints beyond the scaffold's default route plus this global guard. Without a real
endpoint to observe, there is no legitimate-retry pattern, no real client behavior, and no
actual abuse signature to size a per-endpoint threshold against; inventing specific numbers now
would be guessing, not designing. Per-endpoint `@Throttle()` overrides (tighter windows/limits,
and potentially IP+identifier-combined keying to resist distributed credential-stuffing) remain
each endpoint's own decision, to be made in that endpoint's own TDD at the point it is actually
implemented:

- `docs/tdd/auth-core-flow.md` — `POST /auth/login`, `POST /auth/register`.
- `docs/tdd/admin-owner-secret-key.md` — `POST /auth/admin/login/secret-key`.
- `docs/tdd/operator-login-and-confirmation.md` — `POST /auth/admin/login/operator/request-code`,
  `POST /auth/admin/login/operator/verify-code`, `POST /auth/admin/operators/confirm`.
- `docs/tdd/operator-administration.md` — the owner-only `AdminOperatorController` surface.

This TDD does not amend any of those TDDs; it only records where the follow-up work belongs.

## Files/components affected

- `apps/auth-service/src/app.module.ts` — modified. Added the `ThrottlerModule` import/
  registration and the `ThrottlerGuard` `APP_GUARD` provider.

## Edge cases

- **IP-based keying behind a shared NAT/proxy.** The global guard keys on IP address only
  (the library's default), which means many distinct real clients behind the same NAT, or
  behind a reverse proxy that doesn't forward the original client IP, are counted as one
  bucket. This is a known weak point, not solved in this pass. `auth-service`'s eventual
  Traefik-fronted production deployment will likely need `X-Forwarded-For`-aware IP resolution
  (`ThrottlerModule`'s `getTracker()` override, plus trusting Traefik as a proxy hop) — flagged
  here as a future concern for that deployment work, not addressed now.
- A single client legitimately issuing more than 100 requests/60s to `auth-service` (e.g. a
  future high-traffic consuming app) would be throttled by this baseline; no allowlist/
  per-consumer override exists yet. Not expected to occur at this project's current stage
  (no real consumer traffic yet), but noted as a limitation of a single global, undifferentiated
  limit.

## Data migration

N/A — no persistence involved; `@nestjs/throttler`'s default in-memory storage is used.

## Test plan

This was validated manually, not via an automated test suite entry:

- Ran `auth-service` locally with the configuration above.
- Issued 110 rapid requests against the one existing route.
- Confirmed the first 100 requests succeeded and the 101st received a `429 Too Many Requests`
  — exactly matching the configured `limit: 100`.

No automated test exists yet for this behavior. This is a gap, but it is consistent with the
rest of `auth-service`'s current state — the project has no test infrastructure wired up beyond
the scaffold's default spec files — not a gap unique to this feature. An automated regression
test (e.g. an e2e test hammering a route and asserting the `429` boundary) should be added once
the project has a real e2e test harness; not planned as part of this TDD.

## Rollout

Already effectively "rolled out" in the sense that it applies to every request cycle from the
moment this code ships — there is no feature flag, no migration, and no backwards-compatibility
concern to manage. The change is purely additive and one-directional: it can only ever turn a
previously-unthrottled request into a throttled one past the 100-req/60s-per-IP threshold, which
is the intended behavior, not a regression to guard against.
