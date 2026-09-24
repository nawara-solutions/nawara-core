# 0019. Twilio as the SMS gateway provider

- **Status:** Accepted (2026-09-24, Stage 16.8; see the acceptance note)
- **Date:** 2026-09-17
- **Deciders:** Anwar (project owner)
- **GitHub issue:** https://github.com/nawara-solutions/nawara-core/issues/18

## Context

ADR-0011 flagged, in its own Consequences, a shared, undesigned dependency: "No SMS gateway or
provider is chosen anywhere in this repo yet. A phone-registered operator's
`admin.operator_code_issued` event has nowhere real to be delivered until that infrastructure
lands — flagged here as a shared, undesigned dependency, the same move ADR-0007 made for its own
still-undesigned issuance hand-off." ADR-0015 later sharpened the same gap rather than resolving
it, extending it to cover a second event: "As of ADR-0015, this same gap now also covers
`admin.operator_confirmation_code_issued` events for phone-registered operators — one shared,
undesigned dependency, not two separate ones" (per `docs/add/auth-service.md`'s open questions).
Neither ADR-0011 nor ADR-0015 names a provider; both explicitly leave the question open.

Per the architecture already documented elsewhere in this repo, `auth-service` itself never
calls an SMS gateway directly. `docs/sdd/payment-service.md` states this pattern plainly for the
analogous case of payment notifications: "actual push/SMS/email is entirely
`notification-service`'s job." `CLAUDE.md` describes `notification-service` the same way:
it "dispatches push (FCM), SMS, and email based on generic events (`{userId, channel, template,
data}`)... No knowledge of what triggered the notification." Consistent with that,
`auth-service` only ever publishes an event — `channel: "sms"`, a `destination`, and a `code`, per
`admin.operator_code_issued`'s and `admin.operator_confirmation_code_issued`'s documented shapes
— for `notification-service` to consume and act on; `auth-service`'s own design is not what
needs an SMS provider.

That said, `notification-service` currently has **zero design documents of any kind** — no ADD,
no SDD. This is a real, separate, and materially larger gap than the one this ADR closes. This
ADR is deliberately scoped narrow: it names the SMS provider `notification-service` will
eventually use, and nothing more. It does not design `notification-service`'s integration, its
event-consumption logic, or any part of its architecture — that remains entirely open, undesigned
future work.

## Options considered

Kept proportionate to how narrow this decision actually is — there isn't a wide field of
genuinely-considered alternatives here, and inventing extra ones to pad this section would misstate
how the decision was actually made:

1. **A Tunisia/MENA-regional SMS aggregator.** Rejected for now, not on technical merit but for
   lack of one: no specific vendor has actually been evaluated, and picking a name without that
   evaluation would be an uninformed guess dressed up as a considered decision. This is worth
   revisiting once `notification-service`'s real integration work starts and actual volume/cost
   data exists to evaluate a regional vendor against — not before.
2. **Twilio (chosen).** A global SMS API provider with an official Node SDK, accessed through a
   generic `SmsGateway` interface `notification-service` will eventually implement — deliberately
   mirroring `payment-service`'s own already-established pattern for exactly this kind of
   provider choice. Per `CLAUDE.md`: "Gateway adapters (Flouci, Konnect, Paymee, Stripe) live
   behind a common interface so adding a gateway doesn't touch business logic." Twilio is a
   safe, well-documented, globally reliable default — it works in Tunisia today and anywhere
   else this repo's consuming apps might expand to — and, critically, putting it behind an
   interface from day one means this specific vendor choice is cheap to revisit later (e.g.
   swapping to a regional provider once real volume/cost numbers exist) without touching
   `notification-service`'s business logic. That's the same property that already makes
   `payment-service`'s own gateway swaps low-risk.

## Decision

We name **Twilio** as the SMS gateway provider `notification-service` will use once its own
design and implementation exist.

We also define, at the interface level only — not a full implementation, since
`notification-service` doesn't exist yet to implement it — the minimal shape a future
`SmsGateway` interface should have:

```ts
interface SmsGateway {
  send(destination: string, body: string): Promise<{ success: boolean }>;
}
```

This is deliberately minimal, mirroring `payment-service`'s own gateway-adapter interfaces in
spirit: just enough to name the contract shape (a destination and a message body in, a
success/failure result out) without over-constraining a design that hasn't been done yet.
`notification-service`'s eventual real ADD/SDD is free to add to this shape (delivery-status
callbacks, provider-specific metadata, error detail) as that design actually gets done — nothing
here should be read as freezing that future design's options.

## Consequences

- Resolves the specific gap ADR-0011 and ADR-0015 each flagged: "no SMS gateway or provider is
  chosen anywhere in this repo yet." Per this repo's ADR-immutability rule, ADR-0011's and
  ADR-0015's own text is not edited to reflect this — only this new ADR, and the living
  `docs/add/auth-service.md`/`docs/sdd/auth-service.md` open-questions entries, record the
  resolution.
- **Explicitly does not resolve `notification-service`'s complete lack of design documentation.**
  Stated plainly so this ADR's narrow scope isn't misread as having solved something much
  larger: `notification-service` has no ADD and no SDD as of this decision, and naming a vendor
  here does nothing to change that. That remains a separately-tracked, much bigger gap.
- Explicitly does **not** decide retry/failure-handling policy for a failed SMS send,
  delivery-status tracking, or cost/rate controls on SMS usage — all of that is
  `notification-service`'s own future design work, once it exists.
- `auth-service`'s own design is completely unaffected by this decision. It never calls Twilio,
  or any SMS gateway, directly — per the architecture already established (`CLAUDE.md`,
  `docs/sdd/payment-service.md`), it only ever publishes an event with `channel: "sms"`. This
  ADR is really a `notification-service`/vendor decision that happens to close a gap
  `auth-service`'s own design docs flagged first.
- Once `notification-service`'s real design work begins, its own ADD/SDD should reference this
  ADR for *why* Twilio specifically, rather than re-litigating the provider choice — but should
  feel free to revisit it later (e.g. via a superseding ADR) once real volume/cost data makes a
  regional aggregator (Option 1) a genuinely comparable choice.

## Acceptance note (2026-09-24, Stage 16.8)

The project owner accepted this ADR (roadmap decision D3) when Stage 16.8 integrated the real providers. The decision itself (Twilio
as the SMS provider) is unchanged. How it is applied, recorded here rather than edited into the text above:
- **Transport:** Twilio Programmable Messaging over direct HTTPS (`POST /2010-04-01/Accounts/{AccountSid}/Messages.json`), with **no
  Twilio SDK** and no new dependency, so every call is bounded and cancellable by the delivery engine.
- **Interface:** the `SmsGateway` sketch above is superseded by the notification-service `ChannelProvider` port (SDD §8.4).
- **Sender:** a Twilio **Messaging Service SID** (server configuration, never caller-controlled); alphanumeric sender IDs and numbers are
  managed inside that Messaging Service.
- **Credentials:** a Twilio API key (SID + secret), not the account auth token, from the runtime environment only.
- **Destinations:** canonical E.164 only; Notification never adds or infers a country code.
- **Idempotency:** the Messages API has no request idempotency key, so an ambiguous send relies on the SDD §8.5 policy alone.

Detail: [Stage 16.8 record](../architecture/stage-16/stage-16-8-email-sms-providers.md).
