# 0047. Resend as the notification email provider

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** Anwar (project owner)
- **Related:** [ADR-0046](./0046-notification-service-architecture.md) (notification architecture), [ADR-0019](./0019-twilio-as-sms-gateway-provider.md)
  (the SMS counterpart), [notification-service SDD](../sdd/notification-service.md) §8.4–§8.5, roadmap decision D2 in
  [Stage 16.1](../architecture/stage-16/stage-16-1-decisions-and-roadmap.md) §2 (the requirements this ADR had to meet),
  [Stage 16.8 record](../architecture/stage-16/stage-16-8-email-sms-providers.md).

## Context

The notification-service delivery engine (Stage 16.7) calls providers through a `ChannelProvider` port and was certified with a test
provider only. Roadmap decision D2 deferred the email vendor to the owner and required, before Stage 16.8, a vendor that offers:
a transactional HTTPS API returning a message id; documented failure classes (4xx / 429 / 5xx) and rate-limit signals; a no-delivery
test mode; sender-domain verification (SPF / DKIM / DMARC); UTF-8 content including Arabic; acceptable data-processing terms; and a
plain HTTPS API that needs no heavy SDK; a cost model at the expected volume; deliverability in Tunisia / MENA and for the planned
locales including Arabic; and the data-processing location and terms. A request-level idempotency key, where offered, directly reduces
the duplicate risk of the SDD §8.5 ambiguity policy (a resend after a lost answer).

**What could not be shown from the repository** (these stay open after this decision; see Consequences): the repository has
no volume forecast, so no cost comparison at the expected volume was made for any option; no option's inbox deliverability in
Tunisia / MENA was measured (only Arabic UTF-8 transport, which every option supports, is verified by the adapter tests); and the
data-processing agreement and sending region were not reviewed.

## Options considered

1. **Resend.** HTTPS JSON (`POST /emails`), bearer API key, message id in the response, documented error names per status, verified
   sending domains (SPF / DKIM), and a documented **`Idempotency-Key`** header: the same key with the same payload within 24 hours
   returns the original response and sends nothing; the same key with a different payload is `409 invalid_idempotent_request`; a
   concurrent duplicate is `409 concurrent_idempotent_requests`; keys are 1–256 characters, scoped per endpoint.
2. **Postmark.** HTTPS JSON, a strong transactional reputation and a `POSTMARK_API_TEST` token that accepts and delivers nothing; no
   request idempotency key.
3. **Amazon SES v2.** Many regions (including EU and Bahrain), low cost; requests need AWS SigV4 signing (an SDK or a hand-written
   signer), a sandbox to exit, and no request idempotency key.

## Decision

We chose **Resend** (option 1), called over **direct HTTPS with Node's built-in `fetch`: no Resend SDK**, so the delivery engine can
bound and abort every call and the image gains no dependency. It is the only option whose idempotency key turns the frozen worst case
of an ambiguous send ("a one-time code may arrive twice") into "deduplicated by the provider" for resends within its window, at no
cost to the rest of the architecture.

- **Idempotency key:** `nawara-notification/<deliveryId>/<n>`, where `n` counts the delivery's definite retryable answers so far. It
  is unchanged by an ambiguous attempt (the §8.5 resend carries the key whose answer was lost) and changes after a definite provider
  answer, because Resend does not document whether a failed request's key may be reused. It is derived from internal ids only.
- **Sender:** `NOTIFICATION_EMAIL_FROM` (a display name and an address on a Resend-verified domain) is server configuration; callers
  cannot set a sender, reply-to or header.
- **Content:** the rendered subject, text and optional HTML are sent as they are; no Resend template is used, so nothing is
  interpolated by the provider.

## Consequences

- **Easier:** an ambiguous email (a timeout, a reset connection, a gateway 502 / 504) resent within 24 hours with the same payload is
  not delivered twice. Replacing the vendor later touches one adapter.
- **Not claimed:** exactly-once email. Beyond 24 hours, after a payload change (for example a runtime whose date formatting differs),
  or when an answer is lost and the delivery is not a code (it then ends `UNCONFIRMED` and is never resent), the SDD §8.5 behaviour is
  unchanged. A `409` idempotency conflict is itself treated as ambiguous.
- **Operations:** the sending domain must be verified (SPF, DKIM; DMARC recommended) before production; a `403` for an unverified
  domain or a bad key is alerted as `provider_auth_fault`. The API key comes from the runtime environment (or `*_FILE`) only.
- **Open before production (owner):** the cost at the expected volume, a deliverability pilot to Tunisian / MENA mailboxes (in
  Arabic, French and English), and the data-processing agreement and sending region (legal). None of them changes the adapter; a
  negative result is a superseding ADR and one new adapter.
- **Follow-up:** a live sandbox smoke with a Resend test key (opt-in, never in CI); delivery-status webhooks remain out of V1.
