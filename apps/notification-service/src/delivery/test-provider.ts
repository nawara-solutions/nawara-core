import type { ChannelProvider, ProviderCallContext, ProviderResult } from './provider.js';
import type { RenderedMessage } from './renderer.js';

/**
 * The TEST provider (SDD §8.4): delivers nowhere, sends nothing over a network, and is refused in production (configuration). It lets a
 * development stack, the production image smoke and manual runs exercise every engine path deterministically. The scenario is chosen by
 * the destination, so no request field or header can drive it:
 *
 *   | scenario     | EMAIL local part contains | SMS ends with |
 *   |--------------|---------------------------|---------------|
 *   | retryable    | `+retry`                  | `0001`        |
 *   | 429 + hint   | `+429`                    | `0429`        |
 *   | terminal     | `+reject`                 | `0002`        |
 *   | ambiguous    | `+ambiguous`              | `0003`        |
 *   | hang         | `+hang`                   | `0004`        |
 *   | accepted     | anything else             | anything else |
 *
 * It keeps no copy of the message and logs nothing.
 */
export class TestProvider implements ChannelProvider {
  readonly id = 'test';
  readonly capabilities = { idempotencyKey: true };

  constructor(readonly channel: 'EMAIL' | 'SMS') {}

  send(message: RenderedMessage, ctx: ProviderCallContext): Promise<ProviderResult> {
    const d = message.destination;
    const is = (email: string, sms: string) => (this.channel === 'EMAIL' ? d.split('@')[0].includes(email) : d.endsWith(sms));
    if (is('+hang', '0004')) return new Promise<ProviderResult>(() => undefined);
    if (is('+retry', '0001')) return Promise.resolve({ kind: 'rejected', failureClass: 'retryable', code: 'test_unavailable' });
    if (is('+429', '0429')) return Promise.resolve({ kind: 'rejected', failureClass: 'retryable', code: 'test_rate_limited', retryAfterMs: 2000 });
    if (is('+reject', '0002')) return Promise.resolve({ kind: 'rejected', failureClass: 'terminal', code: 'test_rejected' });
    if (is('+ambiguous', '0003')) return Promise.resolve({ kind: 'ambiguous', code: 'test_ambiguous' });
    return Promise.resolve({ kind: 'accepted', providerMessageId: `test-${ctx.attemptId}` });
  }
}
