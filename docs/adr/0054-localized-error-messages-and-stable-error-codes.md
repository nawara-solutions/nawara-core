# 0054. Error responses: a stable machine `code` and a server-localized `message` (EN / FR / AR)

- **Status:** Proposed <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X -->
- **Date:** 2026-10-01
- **Deciders:** Anwar (project owner, architecture owner)

> **Amends** the error convention of [ADR-0034](./0034-shared-service-kit-and-api-conventions.md) ("Errors: Nest's default
> `{ statusCode, message, error }` plus `requestId`") and the localization rule of the
> [product integration guide §24](../architecture/core-product-integration-guide.md#24-locale-and-time) ("Localize at presentation").
> Nothing else in ADR-0034 changes. **Acceptance decides architecture only: nothing is implemented by this ADR** (Core V1 refactor R1;
> implementation is R3 onward, see "Implementation stages").

## Context

The evidence is the Core V1 refactor R0 inventory (2026-10-01, `origin/main` `08475a5`).

**The error body today.** Every Core service except Auth installs the kit's `KitExceptionFilter`
(`libs/service-kit/src/errors/exception.filter.ts:41-68`) through `configureApp` (`libs/service-kit/src/bootstrap.ts:17-30`); Auth
installs `AuthExceptionFilter` (`apps/auth-service/src/errors.ts:83-106`), a subclass that additionally passes through extra fields of an
exception's own response object. The public shape is:

```json
{ "statusCode": 404, "message": "Not Found", "error": "Not Found", "code": "not_found", "requestId": "…" }
```

- `statusCode`: the HTTP status.
- `message`: human text written at the throw site, passed through verbatim; a `string`, or a `string[]` for class-validator failures
  (and for Notification's own field problems, `apps/notification-service/src/api/notification-api.service.ts:12-14`).
- `error`: the English HTTP status text (`STATUS_TEXT`, `exception.filter.ts:15-18`).
- `code`: optional; present only when the throw site supplied one (the additive field recorded in ADR-0034's payment refinement).
- `requestId`: the request id. The correlation id travels only in the `X-Correlation-Id` header, never in the body.
- Auth only: `reason: 'session_ceiling_reached'` on the refresh-session-ceiling 401 (`apps/auth-service/src/auth/auth.service.ts:175-176`),
  kept for wire compatibility beside the same value in `code`.

**Machine codes.** About 113 distinct codes exist, all `lower_snake_case`, mostly service-specific: typed unions in Auth
(`AuthErrorCode`, 33), Billing (`BillingErrorCode`, 23), Organization (`OrganizationErrorCode`, 13) and Payment (`ErrorCode`, 15), and
string codes in File, Audit, Notification, Release and the kit (`rate_limited`, `shutting_down`, `operation_not_permitted`,
`hierarchy_unavailable`). Inter-service clients branch on `code`, never on text (for example
`apps/billing-service/src/payment-integration/payment-client.ts:179`). Several public paths carry **no** `code`:

- class-validator failures from the global `ValidationPipe` (kit `bootstrap.ts:25`, Auth `main.ts:23`; no `exceptionFactory`), whose
  `message` is Nest's default English array;
- 25 bare Nest exceptions (`UnauthorizedException`, `ServiceUnavailableException`, `BadRequestException`, `NotFoundException`): 17 in
  services, 8 in the kit (service-token and service-or-user guards, the Auth client);
- body-parser client errors (`exception.filter.ts:57-61`);
- the opaque `500 Internal server error` (`exception.filter.ts:62-64`).

Known naming inconsistencies: `operation_not_allowed` / `operation_not_permitted`, `organization_not_allowed` /
`organization_not_permitted`, `invalid_transition` / `invalid_state_transition`, generic `not_found` beside `file_not_found`,
`company_not_found`, … .

**Language today.** No Core API negotiates a language: no `Accept-Language` handling, no message catalog, no i18n dependency. Every
`message` is English. The integration guide §24 says a client localizes at presentation and must never parse a human `message`.
Notification localizes **content** (its templates, per BCP 47 locale, `apps/notification-service/src/intake/locale.ts:11-18`); that is a
different concern. **No Core API returns a human-readable success message**: success bodies are DTOs, lists are `{ items, nextCursor }`,
and words such as `status: 'ok'`, `status: 'recovery_required'` or `received: true` are machine values.

**Security.** Stage 22 F13 made the filter the place where raw failures become safe public errors: anything that is not an
`HttpException` is an opaque 500, client errors raised by middleware get a generic message, and logs carry `describeFailure` facts,
never the raw message.

**The pressure.** Core V1 serves products in English, French and Arabic. Under §24 every consumer must keep its own complete
code-to-text catalog for every Core error, and consumers that are not a rich frontend (a script, a partner, a support tool) get English
only. The products want one canonical wording per error in all three languages, while every behaviour stays driven by the stable code.

## Options considered

1. **Client-only localization (today).** Core returns English `message`; each client maps `code` to its own text.
   - Pro: the backend stays simple; each frontend controls its wording.
   - Con: every consumer keeps a full code-to-translation catalog for every Core service, so translations are duplicated and drift;
     consumers without a catalog get English only; paths without a `code` cannot be localized by a client at all.
2. **Server-side localized `message` with a stable `code`.** Core renders `message` in the language the client negotiates
   (`Accept-Language`), with English fallback; `code` stays the language-neutral contract.
   - Pro: one canonical catalog per service; consistent wording for every consumer; the machine contract does not change.
   - Cost: the backend owns translations and their completeness; responses vary by language (`Vary`); tests become language-aware.
3. **A structured localization payload** (`{ "messageKey": "…", "params": { … } }`) for the client to render.
   - Pro: maximal client control.
   - Con: a new public field set and parameter schema per error, i.e. a new API contract to version and document; the client still owns
     every translation (option 1's main cost); nothing in Core needs it today. Deferred: it is an API redesign, not a V1 refactor.
4. **Also localize the `error` field.** Rejected: `error` is the HTTP status phrase, which some clients and tools already read; a
   language-dependent `error` would add risk and no value beside a localized `message`.

## Decision

We choose **option 2**. Rules D1 to D14 are normative for every Core HTTP service that uses the shared error architecture.

### D1. Two layers: a machine contract and a presentation text

- `code` is the machine-readable contract: stable, language-neutral, the only field a client may branch on.
- `statusCode` is stable and keeps its existing semantics.
- `message` is presentation text. It may be localized and its wording may improve over time; a wording change is a presentation change,
  never a behaviour change.
- **Clients MUST NOT parse, match, branch on or derive behaviour from `message`**, in any language. This rule from §24 is unchanged; what
  changes is that Core, not only the client, may now render the text in the client's language.

### D2. The error body keeps its shape

```json
{ "statusCode": 404, "message": "<localized text>", "error": "Not Found", "code": "not_found", "requestId": "…" }
```

- The fields stay `statusCode`, `message`, `error`, `code`, `requestId`. **No envelope** (`{ data: … }`), **no `details`, no `metadata`,
  no `messageKey`**, no correlation id in the body.
- The type of `message` does not change for any existing response: a `string` stays a `string`, a `string[]` stays a `string[]`.
- Auth's `reason` field stays, unchanged (D11).

### D3. `code` is stable; V1 codes are frozen

- Every existing code keeps its exact spelling and meaning in V1. The inconsistencies listed in Context are **known compatibility debt**,
  recorded here and **not renamed**; renaming is a breaking change for V2 at the earliest.
- New codes are **`lower_snake_case`** (every existing code already is), describe the condition rather than the wording, and are
  domain-specific when a generic name would be ambiguous (`file_not_found` rather than another `not_found` meaning). A generic shared
  code is used only for truly shared semantics.
- A code is never derived from, or equal to, a translated or English text, and never computed at runtime from a message.

### D4. Direction: every shared-architecture error carries a `code`

Every public error rendered by the shared error architecture will carry a `code` (implementation: R3 / R4 / R5 / R6). The rule
removes the code-less paths listed in Context:

| Path | Code (direction) | Existing or new |
|---|---|---|
| class-validator failure | `validation_error` | **existing** (Auth, File, Release, Notification) |
| bare 401 from a guard | `unauthenticated` | **existing** (Auth, Audit) |
| bare 403 from a guard | `forbidden` | **existing** (Auth, Organization) |
| bare 404 | `not_found` | **existing** (most services) |
| rate limit | `rate_limited` | **existing** (kit, Auth, Audit, File, Release) |
| shutdown admission (503) | `shutting_down` | **existing** (kit `health/http-drain.ts:66`) |
| unexpected failure (opaque 500) | `internal_error` | **new: an R3 decision**, does not exist today |
| body-parser client errors (413, malformed JSON, …) | one code per status; names chosen in R3 | **new: an R3 decision**. Candidate words such as `payload_too_large` and `malformed_body` already exist as non-HTTP identifiers (audit-contract refusal reasons, `libs/audit-contract/src/errors.ts:11`; a Payment webhook outcome, `apps/payment-service/src/webhooks/webhook.service.ts:64,78`); R3 checks for such collisions before choosing |
| a dependency the request needs is unavailable (bare 503 from the Auth client and similar) | `hierarchy_unavailable` where that is the meaning; otherwise a name chosen in R3 | **existing / R3 decision** |

R3 confirms the new names against D3 before any implementation; nothing in this table is implemented by this ADR.

### D5. `message` is localized; `error` is not

- `message` is rendered in the negotiated language (D7). For a class-validator failure (`string[]`), **each element** is localized,
  keeping the array and its order.
- `error` stays the existing English HTTP status text in V1 (`"Not Found"`, `"Bad Request"`, …). Option 4 is rejected.
- Illustration only (not a catalog): `code: "company_not_found"` → `en` "Company not found." · `fr` "Société introuvable." ·
  `ar` "الشركة غير موجودة.". The `code` and `statusCode` are identical in the three responses.

### D6. Default and no-header compatibility

- The default language is **`en`**: when no supported language is requested, or the header is missing, unsupported or malformed.
- **English text is frozen where it exists**: with no `Accept-Language` (or any request that resolves to `en`), an existing error path
  returns its current English `message` **byte-for-byte**. Localization adoption must not reword English messages; a deliberate English
  wording change is a separate, reviewed presentation change.
- The exception is security: where F13 (D10) requires a message to become more generic, security wins.

### D7. Language negotiation (`Accept-Language`)

- Supported V1 languages: **`en`, `fr`, `ar`** (BCP 47 base languages).
- Source: the `Accept-Language` request header only. No user, organization, platform or phone-number based inference; no query
  parameter; no cookie.
- Resolution, per language range in preference order: exact match, then the base language (`en-US` → `en`, `fr-FR` → `fr`, `ar-TN` →
  `ar`); the first supported result wins; otherwise `en`. This mirrors Notification's resolution order (exact, base, default) without
  sharing its storage.
- Preference order: q-values, highest first; `q=0` excludes a range; equal q-values keep header order. A `*` range stands for `en`
  at its own q-value (so `fr;q=0, *` gives `en`, and `ar, *;q=0.5` gives `ar`). Tags compare case-insensitively.
- Bounded before parsing: a header longer than **256 characters** is treated as absent; at most **10** ranges are considered; a range
  that is not a well-formed language tag is skipped. The parser never throws and never rejects a request: negotiation failure is `en`.
- The resolved language lives in the kit's request context next to the request and correlation ids; it never changes those ids (D9).

### D8. Response headers

- Every error response rendered by the shared filter carries **`Content-Language`** with the language actually used (`en`, `fr` or
  `ar`, including the `en` default) and **`Vary: Accept-Language`**, **appended** to any existing `Vary` value (CORS already varies on
  `Origin`), never replacing it.
- Success responses, which are not localized, are unchanged: no new headers, no new caching semantics.
- The excluded responses of D12 are unchanged.

### D9. Request and correlation ids are untouched

Localization changes no part of request-id or correlation-id generation, validation, propagation, response headers, event propagation,
the Audit envelope or log fields. The body keeps `requestId` and gains no `correlationId`.

### D10. Security (F13) invariants

- Localization happens **after** an error has been classified into safe public information. Only an `HttpException` thrown deliberately
  by Core code, or a generic class the filter already maps, is ever localized.
- A catalog entry may interpolate **only** typed, safe parameters computed by the service (a bound from configuration, an enum value
  such as a payment status, a count). It never interpolates an exception message, SQL or database text, a hostname, a filesystem path,
  a token, a password, an authorization header, broker details or any infrastructure detail.
- Unknown and internal failures stay opaque: the localized `internal_error` text is a fixed sentence with no parameter.
- The only client-derived value a message may contain is what class-validator already echoes today: the name of a property the client
  sent (`property x should not exist`). In every language it is inserted verbatim as a parameter, exactly as the English message carries
  it today (never translated, never interpreted), within the size the body limit already bounds. No other client value is echoed.
- Changes to `KitExceptionFilter` or `AuthExceptionFilter` are made **only with F13 regression tests**: sentinel database hosts,
  passwords, filesystem paths, tokens and raw exception text injected into failures must appear in no EN, FR or AR response body and no
  log line.

### D11. Auth compatibility

- Auth keeps `reason` (`session_ceiling_reached`) beside `code`; its `message` is localized like any other.
- Everything `AuthExceptionFilter` renders (including Auth's body-parser errors, which reach the same filter) follows D4, D5 and D8 once
  Auth adopts the mechanism (R5); Auth's own bootstrap is kept for that.
- `/auth/health` keeps its exact body (`{ "status": "ok" | "unavailable" }`).
- Auth keeps its own bootstrap, including its body-parser behaviour; it is **not** moved wholesale onto `configureApp` in V1. Full
  Auth / service-kit convergence is Core V2 A1.
- WebAuthn protocol values, configuration and DTOs are out of scope of this ADR.

### D12. Not localized in V1

Unless a later decision says otherwise, these stay exactly as they are:

- Payment provider webhook responses: **every** response of the webhook route, including the `404` / `400` its controller raises through
  the filter (`apps/payment-service/src/webhooks/webhooks.controller.ts:24-31`). The route is provider-facing; it gains no `code`, no
  localization and no new header in V1;
- the documentation basic-auth `401` (`text/plain` `Unauthorized`, `*/src/docs/basic-auth.ts`);
- the shutdown-admission `503` body (it already has `code: 'shutting_down'`; it is written by middleware, not the filter, so D8 does not
  apply to it);
- health and readiness bodies (`/health`, `/ready`, `/auth/health`);
- success bodies and machine status values (`status`, `received`, `recovery_required`, …);
- WebAuthn protocol values;
- audit event names, event types, telemetry identifiers, error codes and structured-log identifiers;
- internal log messages.

### D13. Ownership and storage of the text

- The **service-kit** owns the mechanism: language resolution, the catalog interface, rendering in the shared filter, the
  `Content-Language` / `Vary` behaviour, the shared error factory, and the text of the **generic** codes (`validation_error`,
  `unauthenticated`, `forbidden`, `not_found`, `rate_limited`, `shutting_down`, `internal_error`, the body-parser codes, the
  class-validator constraint messages).
- **Each service owns its domain text** in its own catalog (Auth, Organization, Billing, Payment, File, Notification, Audit, Release).
  The kit stays infrastructure only; domain wording never moves into it.
- Storage: **typed, in-memory TypeScript catalogs** with one entry per message and an `en`, `fr` and `ar` text each, checked complete at
  compile and test time. One code may have several messages (Auth's `validation_error` has several), so the catalog key is an internal
  message identifier owned by the service; it is **not** a public field (option 3 stays deferred). The `en` text of an existing message
  is its current English wording (D6).
- At runtime, a message that lacks the negotiated language (a defect that the completeness checks exist to prevent) falls back to its
  `en` text, and `Content-Language` reports `en`: the header always names the language of the text actually returned.
- No database lookup, file read, network call or translation service at runtime; no new i18n dependency is needed.

### D14. Arabic, and the Notification boundary

- Arabic text is real UTF-8 Arabic, never transliteration. JSON responses are already `application/json; charset=utf-8`.
- Core adds no right-to-left presentation behaviour; direction and layout belong to the client.
- API error localization and Notification template localization stay separate systems: Notification keeps its versioned, published
  templates and `NOTIFICATION_DEFAULT_LOCALE`; API error catalogs are code-owned and in memory. They may share resolution semantics,
  not storage.

## Compatibility

For a client that sends **no** `Accept-Language`, every existing API behaves as before: the same HTTP status, the same response shape,
the same existing `code`, the same English `message`, the same `requestId` behaviour, the same correlation headers and the same Auth
`reason`. The visible differences are additive: a `code` where one was missing (D4) and the `Content-Language` / `Vary` headers on
error responses (D8). Localization is opt-in through language negotiation, with English fallback.

## Consequences

**Positive**

- English, French and Arabic error text, consistent across every consumer, from one canonical catalog per service.
- `code` becomes the complete machine contract (D4), so client behaviour never depends on text in any language.
- Consumers no longer each own a full Core translation catalog.
- Security stays central: localization sits behind the same filter that enforces F13.

**Negative**

- The backend owns translations: every supported message needs a complete `en` / `fr` / `ar` entry, and someone must write and review
  French and Arabic wording.
- Tests become language-aware (status and code identical across languages; text differs; English unchanged).
- Error responses vary by language, so caches and proxies must honour `Vary: Accept-Language`.
- A wording change in any language is now an API presentation change and is reviewed as one.
- Developers need conventions for catalog keys, parameters and new codes.

**Follow-up**

- Integration guide §24 is updated with this ADR (client responsibilities).
- An error-code catalog per service and contract tests are part of the documentation stage (R7+).
- The naming debt of D3 is a V2 candidate.

## Implementation stages (not authorized by this ADR)

| Stage | Scope |
|---|---|
| R2 | Billing security logging correction (raw `e.message` in `payment-dispatcher.ts:97`, `payment-reconciler.ts:83`; independent of this ADR) |
| R3 | Shared foundation in the kit: shared error factory, mandatory-code path (D4), language resolver (D7), catalog mechanism (D13), filter integration, `Content-Language` / `Vary` (D8), F13 regression tests (D10) |
| R4 | Validation localization (D5: `string[]` kept, each element localized, `validation_error`) |
| R5 | Auth adoption (its filter subclass, 33 codes, `reason`) |
| R6 | The remaining services |
| R7+ | Cleanup, regression validation, documentation and the error-code catalog, certification |
