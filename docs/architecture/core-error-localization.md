# Core error localization: developer and maintainer guide

- **Status:** current. Describes the error-localization architecture as implemented in Core V1 (ADR-0054; refactor R3–R9).
- **Authority:** the source files linked here are authoritative. This guide explains them; it never replaces them. The decision record
  is [ADR-0054](../adr/0054-localized-error-messages-and-stable-error-codes.md); the client contract is
  [integration guide §24](core-product-integration-guide.md#error-responses-and-language-adr-0054).
- **Audience:** Core developers adding or changing a public API error; reviewers and maintainers.

## 1. What localization changes, and what it never changes

A Core error response has one shape: `{ statusCode, message, error, code?, requestId }`. Localization changes **only** how `message`
is presented. It never changes:

- the HTTP status;
- the `code` (the machine contract clients branch on; V1 codes are frozen, ADR-0054 D3);
- the response shape, `error` (the English status phrase), `requestId`, or Auth's extra `reason` field;
- the order or the number of elements of a `string[]` message.

**English is the compatibility baseline.** Every catalog `en` text is the English the API returned before localization, byte for
byte, and a request without `Accept-Language` (or with an unsupported, malformed or `*` value) gets exactly that English.

## 2. How a request is localized

```text
HTTP request
  → requestContextMiddleware          negotiates Accept-Language → RequestContext.locale (en | fr | ar)
  → service code throws a domain error through its error factory
  → httpError(status, code, texts, params?)
        body: { message: <English text>, code }
        catalog identity attached to the exception under a private symbol (never in the body)
  → KitExceptionFilter                renders the identity in RequestContext.locale (English if that text is missing)
  → response                          message localized; status, code, error, requestId unchanged
                                      Content-Language: <language(s) actually used>
                                      Vary: …, Accept-Language
```

| Step | Source |
|---|---|
| Negotiation | [`libs/service-kit/src/i18n/locale.ts`](../../libs/service-kit/src/i18n/locale.ts) (`resolveLocale`) |
| Request context | [`libs/service-kit/src/context/request-context.ts`](../../libs/service-kit/src/context/request-context.ts) (`requestContextMiddleware`) |
| Catalogs and rendering | [`libs/service-kit/src/i18n/catalog.ts`](../../libs/service-kit/src/i18n/catalog.ts) (`defineMessages`, `renderMessage`, `catalogProblems`) |
| Identity attachment | [`libs/service-kit/src/errors/http-error.ts`](../../libs/service-kit/src/errors/http-error.ts) (`httpError`, `attachLocalizedMessage`, `attachLocalizedMessageList`) |
| Rendering and headers | [`libs/service-kit/src/errors/exception.filter.ts`](../../libs/service-kit/src/errors/exception.filter.ts) (`KitExceptionFilter`) |
| Validation lists (R4) | [`libs/service-kit/src/errors/validation.pipe.ts`](../../libs/service-kit/src/errors/validation.pipe.ts), [`validation-messages.ts`](../../libs/service-kit/src/errors/validation-messages.ts) |
| Wiring | [`libs/service-kit/src/bootstrap.ts`](../../libs/service-kit/src/bootstrap.ts) (`configureApp` turns localization on). Auth keeps its own bootstrap and the `AuthExceptionFilter` subclass ([`apps/auth-service/src/errors.ts`](../../apps/auth-service/src/errors.ts)), ADR-0054 D11. |

The filter renders, in this order: an attached single identity; otherwise an attached list (element by element); otherwise a bare
HTTP status phrase (for example Nest's default `Not Found`) from the kit catalog. Anything unexpected stays an opaque 500 with a fixed
localized sentence (F13): no exception text, SQL, host, path or token ever reaches a response.

## 3. Language negotiation (`Accept-Language`)

- Supported: `en`, `fr`, `ar`. Default and fallback: `en`.
- A regional tag falls back to its language: `fr-CA` → `fr`, `ar-TN` → `ar`, `en-US` → `en`.
- Ranges are tried by q-value, highest first; equal q-values keep header order; `q=0` excludes a range
  (`fr;q=0, ar` → `ar`).
- `*` means English at its own q-value (`fr;q=0, *` → `en`).
- A malformed range is skipped; a missing, oversized or entirely unusable header gives English. Negotiation never fails a request.

## 4. Response headers

On every error response rendered by a localizing filter:

- **`Content-Language`** names the language of the text actually returned: `fr` when everything rendered in French, `en` on fallback,
  and **two values, for example `fr, en` or `ar, en`, when a list mixes localized elements with intentionally English ones** (§7, §8).
- **`Vary`** gains `Accept-Language`, keeping every existing value (CORS adds `Origin`) and never duplicating it.

Success responses and excluded paths (§9) get neither header.

## 5. Adding a single localized error

Each service owns its domain text in its own catalog and throws through its own error factory (§10). The kit owns only the mechanism
and the generic texts. Shape of a catalog and of a throw, as the kit's own tests use them:

```ts
import { defineMessages, httpError } from '@nawara/service-kit';

export const DEMO = defineMessages({
  company_missing: { en: 'Company not found.', fr: 'Société introuvable.', ar: 'الشركة غير موجودة.' },
  range: { en: 'Pick {min} to {max}.', fr: 'Choisissez de {min} à {max}.', ar: 'اختر من {min} إلى {max}.' },
});

throw httpError(404, 'company_not_found', DEMO.company_missing);
throw httpError(400, 'demo_range', DEMO.range, { min: 1, max: 5 });
```

- A catalog key is an internal identity, never a public field, and never the `code`.
- `{name}` placeholders must be identical in `en`, `fr` and `ar` (`catalogProblems` checks this).
- Parameters must be safe, server-computed values: a configured bound, a closed enum value (for example a status), a count, a
  server-defined field path. Machine values (statuses, enum values, `EMAIL` / `SMS`, header and field names) are inserted verbatim and
  never translated. Client values are governed by §8.
- `httpError` with a plain string instead of catalog texts produces an English-only message. That form is intentional where a message
  must stay English (§8); it is not a pending migration. Release's factories accept catalog texts only, so a raw string does not compile
  there.

## 6. Localized lists (`message: string[]`)

A `string[]` message is localized element by element with `attachLocalizedMessageList(exception, items)`, where each item is a
`LocalizedListItem` (`{ prefix, message }`) aligned with the array, or `undefined`:

- one identity per element; order and length are preserved;
- `prefix` is kept verbatim in front of the rendered text (for example a nested property path);
- an element whose item is `undefined` stays exactly English;
- a list mixing both is intentional, and `Content-Language` then names both languages (§4).

Consumers: the kit's R4 validation pipe (§7) and Notification's `validation_error` / `invalid_template_data` lists
([`apps/notification-service/src/api/notification-api.service.ts`](../../apps/notification-service/src/api/notification-api.service.ts)).

## 7. Validation errors (R4)

`LocalizedValidationPipe` keeps Nest's validation behaviour and output (`message: string[]`, `code: validation_error`, same order) and
attaches one identity per element from `VALIDATION_MESSAGES` (one entry per class-validator constraint). The property name a
class-validator message already carries (`property x should not exist`) is inserted verbatim in every language; no submitted value is
ever echoed. A message whose constraint has no catalog entry stays English. Services without class-validator DTOs (Audit, Billing,
Notification, Organization) validate manually and use their own catalog entries.

## 8. Client-derived values (ADR-0054 D10)

Localization happens only after an error has been classified as safe public information, and a catalog message may interpolate only
safe server-computed values. The only client-derived value a localized message may carry is a **request property name**, inserted
verbatim (it is never translated or interpreted), for example:

- class-validator's `property x should not exist` (§7);
- Organization's and Billing's `unknown field: {name}`, Notification's `{name}: is not a field of this request`;
- Notification's `{name}: is invalid` when `{name}` is a variable the template itself defines.

A few existing English messages echo another client-derived value. They are deliberately **not** in any catalog and stay exactly
English in every language (`Content-Language: en` for them):

| Service | Message | Client-derived value | Source |
|---|---|---|---|
| Organization | `unknown query parameter: <key>` | an arbitrary query key | [`common/pagination.ts`](../../apps/organization-service/src/common/pagination.ts) |
| Payment | `Currency <code> is not supported.` | the submitted currency | [`payments/payment.service.ts`](../../apps/payment-service/src/payments/payment.service.ts) |
| Payment | `Provider <id> is not enabled.` | the submitted provider id | [`providers/provider-registry.ts`](../../apps/payment-service/src/providers/provider-registry.ts) |
| Billing | snapshot-validation messages (`<field>.<path> is longer than …`, …) | key paths of the client's free-form JSON | [`domain/snapshots.ts`](../../apps/billing-service/src/domain/snapshots.ts), passed through in `domain/invoice-input.ts` and `invoices/invoice.repository.ts` |
| Billing | `currentPeriodEnd must be <date>: …` | a date derived from the client's period start | [`subscriptions/subscription.repository.ts`](../../apps/billing-service/src/subscriptions/subscription.repository.ts) |
| Notification | `<key>: is invalid` | an undeclared key of the caller's free-form `data` | [`api/notification-api.service.ts`](../../apps/notification-service/src/api/notification-api.service.ts) |

Notification decides by **provenance**, not by inspecting text: `variableValueProblems`
([`templates/variables.ts`](../../apps/notification-service/src/templates/variables.ts)) tags each problem `template` (localized) or
`data` (English), so one `invalid_template_data` list can legitimately mix both. Whether any of these English-only messages should
ever be localized is a separate, open policy decision; until then, do not give them a catalog identity.

## 9. Paths that are deliberately not localized (ADR-0054 D12)

- **Payment provider webhooks:** every response of the webhook route keeps its pre-localization rendering, with no localized message
  and no `Content-Language` / `Vary`. Payment passes the route prefix to `configureApp({ errorLocalizationExcludedPaths })`
  ([`apps/payment-service/src/main.ts`](../../apps/payment-service/src/main.ts)); the filter checks `excludedPathPrefixes`.
- The documentation basic-auth `401` (`text/plain`, written outside the filter), the shutdown-admission `503` (written by middleware),
  health and readiness bodies, and every success body.

These are design decisions, not gaps.

## 10. Service catalogs and error codes

There is **no global error-code registry**. Codes are owned by each service; generic codes (`not_found`, `validation_error`,
`rate_limited`, …) recur across services on purpose. A code may have several messages, and the same code may be used with different
HTTP statuses in different contexts, so code ↔ catalog key ↔ status is not one-to-one. The source catalogs are authoritative for the
texts; this index only points to them.

| Catalog | Owner | Source | Code strategy and factories | Special cases |
|---|---|---|---|---|
| `KIT_MESSAGES` | service-kit | [`errors/kit-messages.ts`](../../libs/service-kit/src/errors/kit-messages.ts) | generic texts (status phrases, `internal_failure`, `rate_limited`, …) | shared by every service |
| `VALIDATION_MESSAGES` | service-kit | [`errors/validation-messages.ts`](../../libs/service-kit/src/errors/validation-messages.ts) | `validation_error` (R4) | §7 |
| `AUTH_MESSAGES` | Auth | [`src/messages.ts`](../../apps/auth-service/src/messages.ts) | typed `AuthErrorCode`, `authError` ([`src/errors.ts`](../../apps/auth-service/src/errors.ts)) | own filter subclass; `reason` field |
| `ORGANIZATION_MESSAGES` | Organization | [`src/messages.ts`](../../apps/organization-service/src/messages.ts) | typed `OrganizationErrorCode`, `organizationError` ([`src/domain/errors.ts`](../../apps/organization-service/src/domain/errors.ts)) | D10 query key |
| `AUDIT_MESSAGES` | Audit | [`src/messages.ts`](../../apps/audit-service/src/messages.ts) | service-scoped string codes at call sites | Auth dependency errors |
| `RELEASE_MESSAGES` | Release | [`src/messages.ts`](../../apps/release-service/src/messages.ts) | service-scoped string codes; `adminError`, `releaseError`, `inputError`, `denialError` | catalog texts only |
| `FILE_MESSAGES` | File | [`src/messages.ts`](../../apps/file-service/src/messages.ts) | service-scoped string codes; `fileError` ([`upload/upload-http.ts`](../../apps/file-service/src/upload/upload-http.ts)) | ingest refusals rendered at the response; only the machine `failureCode` is stored |
| `PAYMENT_MESSAGES` | Payment | [`src/messages.ts`](../../apps/payment-service/src/messages.ts) | typed `ErrorCode`, `paymentError` ([`src/errors.ts`](../../apps/payment-service/src/errors.ts)) | D10 currency, provider; D12 webhooks |
| `BILLING_MESSAGES` | Billing | [`src/messages.ts`](../../apps/billing-service/src/messages.ts) | typed `BillingErrorCode`, `billingError` ([`src/domain/errors.ts`](../../apps/billing-service/src/domain/errors.ts)) | D10 snapshots, anchored period |
| `NOTIFICATION_MESSAGES` | Notification | [`src/messages.ts`](../../apps/notification-service/src/messages.ts) | service-scoped string codes; `fail` / `refuse` | list localization; D10 provenance; §11 |

## 11. Notification has two different locale concepts

| | API error language | Notification content locale |
|---|---|---|
| Decides | the language of an HTTP error `message` | the language of the delivered email or SMS |
| Input | the request's `Accept-Language` | the notification's requested `locale` (body / event), the template's published locales, `NOTIFICATION_DEFAULT_LOCALE` |
| Code | kit `resolveLocale` + `KitExceptionFilter` | Notification's own `resolveLocale` in [`intake/locale.ts`](../../apps/notification-service/src/intake/locale.ts), called from `intake/intent-core.ts` |
| Storage | in-memory code catalogs | versioned, published templates ([SDD §6.4](../sdd/notification-service.md)) |

`Accept-Language` never selects notification content: a send request's rendering locale comes from its body only, and a test
proves the header does not change it. The two functions share a name but not a responsibility; keep them separate (ADR-0054 D14).

## 12. Checklist: adding or changing a localized error

1. Decide whether the message may be localized: it must be safe public information, and any parameter must be server-computed (§5,
   §8). A path excluded by §9 stays as it is.
2. Add the entry to the owning service's catalog. For an existing message, `en` is the current English, byte for byte.
3. Add real French and Arabic (UTF-8 Arabic, no transliteration), with the same placeholders.
4. Throw through the service's existing factory (or `httpError`), passing the catalog entry and parameters; for a list, attach one
   identity per element.
5. Update the service's catalog test (English pinned, completeness) and its localization e2e suite (languages, status, `code`,
   `Content-Language`, `Vary`).

## 13. Where the tests are

| Concern | Tests |
|---|---|
| Negotiation | [`libs/service-kit/test/locale.spec.ts`](../../libs/service-kit/test/locale.spec.ts) |
| Catalog mechanism, filter, headers, D12 option, F13 | [`i18n-catalog.spec.ts`](../../libs/service-kit/test/i18n-catalog.spec.ts), [`localization.spec.ts`](../../libs/service-kit/test/localization.spec.ts) |
| Validation and list localization | [`validation-localization.spec.ts`](../../libs/service-kit/test/validation-localization.spec.ts) |
| Each service's catalog (complete, English pinned) | `apps/<service>/src/messages.spec.ts` |
| Each service over real HTTP (languages, codes, headers, D10, D12) | `apps/<service>/test/localization.e2e-spec.ts`; Auth: [`test/auth-localization.e2e-spec.ts`](../../apps/auth-service/test/auth-localization.e2e-spec.ts) |

These suites run in Core CI on every pull request and push. A change to `libs/service-kit` must be built before dependent services
are tested locally (services import the kit's built `dist/`).

## 14. Out of scope here

Error-code naming debt (ADR-0054 D3) and any global code registry are Core V2 candidates; the D10 policy question in §8 is a separate
owner decision. Neither is implied by this guide.
