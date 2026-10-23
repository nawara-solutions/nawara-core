import { PermanentEventFailure, type EventEnvelope, type HandlerTrust } from '@nawara/service-kit';

/** The refusals Notification's handler adds behind the kit's own (defence in depth: the kit never hands these over). */
export const TRUST_REFUSALS = ['untrusted_no_decision', 'untrusted_origin_mismatch'] as const;

/**
 * Core V2 S1e-4 (ADR-0057 §13.5, "S0-C6" Notification): the envelope intake may rely on, from the kit's trust decision only. Notification
 * is verified-only: the handler runs for an ACCEPTED decision (a verified original, its verified redelivery, or a replay matching the
 * stored verified observation), and anything else (no decision at all, a compatibility decision) is refused here, permanently and before
 * intake, so it never reaches the `(sourceService, sourceEventId)` de-duplication or a delivery.
 * - `id`, `name` and `source` are the trusted origin's (the broker-verified delivery's, or the stored verified observation's), and must
 *   be this delivery's own (`untrusted_origin_mismatch` otherwise);
 * - `correlationId` comes only from a verified original's own delivery; a replay's header is never trusted (it is not stored), so a
 *   replayed event is recorded without one;
 * - `version` is the verified original's; a replay keeps its header, which only gates the mapping (anything but the mapped version is
 *   refused `unsupported_version`): it can never change what is recorded or sent. The body is the verified one in every case (the keyed
 *   commitment covers every byte).
 */
export function trustedIntakeEvent(event: EventEnvelope, trust: HandlerTrust | undefined): EventEnvelope {
  if (trust?.decision !== 'accept') throw new PermanentEventFailure('untrusted_no_decision');
  const o = trust.origin;
  if (o.eventId !== event.id || o.name !== event.name || o.source !== event.headers.source) throw new PermanentEventFailure('untrusted_origin_mismatch');
  const headers = { ...event.headers };
  delete headers.correlationId; // never this delivery's own: only a verified original's (below)
  return {
    ...event,
    id: o.eventId,
    name: o.name,
    headers: {
      ...headers,
      eventId: o.eventId,
      source: o.source,
      version: o.version.available ? o.version.value : event.headers.version,
      ...(o.correlationId.available ? { correlationId: o.correlationId.value } : {}),
    },
  };
}
