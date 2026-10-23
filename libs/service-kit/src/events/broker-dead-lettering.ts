/**
 * Core V2 OD-BRK-1 (ADR-0057 §8 "OD-BRK-0", D1 to D3): an OPT-IN subscription topology with NO broker-driven dead-lettering.
 *
 * By default (no option) every consumer queue `Q` is declared exactly as before: `Q` with `x-dead-letter-exchange = <exchange>.dlx`, and
 * `Q.dead` bound to that fanout, which every consumer shares. A subscription created with `noBrokerDeadLettering(...)` instead:
 * - declares `Q` with NO `x-dead-letter-exchange` argument, so a broker-driven dead-lettering of `Q` (a reject without requeue, an
 *   expiry, an overflow) has no route: the broker DISCARDS the message (D3) instead of copying it raw anywhere;
 * - declares `Q.dead` but never binds it to `<exchange>.dlx`, and never declares that exchange for this subscription;
 * - keeps everything the kit itself does: `Q.retry` (it returns expired copies to `Q` through the default exchange), the bounded holds
 *   and requeues, and the confirmed, policy-applied (redacted) dead-letter copy that the kit publishes DIRECTLY to `Q.dead`.
 *
 * What the kit establishes, and what it cannot:
 * - it CAN: the queue's own arguments. A declaration whose arguments differ from an existing queue is refused by RabbitMQ (406
 *   PRECONDITION_FAILED), so an opted-in consumer never attaches to an old-topology queue (and a default one never attaches to an
 *   opted-in queue). The kit never deletes or re-creates a queue to resolve that: it fails closed.
 * - it CANNOT: a REGULAR policy (or an operator policy) applied to the queue by name, an existing binding left by an older declaration,
 *   or the identity's effective permissions. AMQP 0-9-1 exposes none of them to a client: a policy that adds a dead-letter exchange to an
 *   argument-less queue is invisible to every declaration, passive check and delivery, yet re-opens a raw broker dead-letter route. The
 *   kit therefore never claims to have checked them (`ConsumerStatus.topology.effectivePolicy = 'not_verified_by_kit'`).
 *
 * PRECONDITION (the contract this option carries): an opted-in consumer is NOT production-ready until an independently authorized,
 * protected verification of the broker's EFFECTIVE topology (queue arguments, regular and operator policies, effective dead-letter
 * settings, bindings of its private dead-letter queue, its identity's permissions) has passed, and keeps passing (OD-BRK-2). The factory
 * makes the caller state that explicitly. The in-memory bus has no broker topology and ignores the option.
 */
export interface NoBrokerDeadLettering {
  readonly mode: 'none';
  /** Who verifies the broker's effective topology: never the kit (see above). */
  readonly effectiveTopologyVerification: 'external';
}

const issued = new WeakSet<object>();

/** The opt-in. `effectiveTopologyVerification: 'external'` is required: the caller acknowledges the precondition above. Frozen. */
export function noBrokerDeadLettering(options: { effectiveTopologyVerification: 'external' }): NoBrokerDeadLettering {
  if (options?.effectiveTopologyVerification !== 'external') {
    throw new Error("noBrokerDeadLettering needs effectiveTopologyVerification: 'external' (the kit cannot verify effective broker policies)");
  }
  const option = Object.freeze({ mode: 'none' as const, effectiveTopologyVerification: 'external' as const });
  issued.add(option);
  return option;
}

/** Refuses (throws) a `brokerDeadLettering` value the kit did not issue: a subscription never starts with a forged or mistyped topology. */
export function assertBrokerDeadLettering(sub: { queue: string; brokerDeadLettering?: unknown }): void {
  const o = sub.brokerDeadLettering;
  if (o === undefined) return;
  if (typeof o !== 'object' || o === null || !issued.has(o)) throw new Error(`brokerDeadLettering for ${sub.queue}: only a value created by noBrokerDeadLettering() is accepted`);
}

/** What a consumer's status says about its topology when it opted in (absent for a default subscription: unchanged). */
export interface IsolatedTopologyStatus {
  brokerDeadLettering: 'none';
  /** The kit verified the queue's arguments only; effective policies, bindings and permissions are the external verification's. */
  effectivePolicy: 'not_verified_by_kit';
}
