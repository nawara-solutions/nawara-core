import { describe, expect, it, vi } from 'vitest';
import { RefundAttemptService } from './refund-attempt.service.js';
import type { ProviderCapabilities } from '../providers/provider.port.js';

/** Core V2 R3 (PAY-08 I): matching authority comes ONLY from an adapter's explicit declaration; without it a failed attempt is `unknown`, never `none`. */
describe('failedAttemptEvidence: adapter matching authority (Core V2 R3)', () => {
  const service = (capabilities: Partial<ProviderCapabilities> | null, row?: Record<string, unknown>) => {
    const query = vi.fn(async () => ({ rows: [row ?? { fact: null, indexPending: false, malformed: false, notified: false }] }));
    const s = Object.create(RefundAttemptService.prototype) as Record<string, unknown>;
    s['db'] = { query };
    s['providers'] = { tryGet: () => (capabilities === null ? undefined : { capabilities }) };
    return { s: s as unknown as { evidenceAfterFailure(a: Record<string, unknown>): Promise<string> }, query };
  };
  const failed = { id: 'a', status: 'failed', provider: 'p', providerRefundId: 'ref' };

  it('an adapter that does not declare refundReferenceScope, or is not enabled, reads `unknown` and is never compared', async () => {
    for (const caps of [{}, { refundReferenceScope: undefined }, null]) {
      const { s, query } = service(caps as Partial<ProviderCapabilities> | null);
      expect(await s.evidenceAfterFailure(failed)).toBe('unknown');
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('a declared adapter is compared; a failed attempt without a provider reference is `none` (nothing can name it)', async () => {
    expect(await service({ refundReferenceScope: 'provider' }).s.evidenceAfterFailure(failed)).toBe('none');
    expect(await service({ refundReferenceScope: 'provider' }, { fact: { unmatched: true }, indexPending: true, malformed: true, notified: true }).s.evidenceAfterFailure(failed)).toBe('unmatched_fact');
    expect(await service({ refundReferenceScope: 'provider' }, { fact: { unmatched: false }, indexPending: false, malformed: false, notified: false }).s.evidenceAfterFailure(failed)).toBe('unknown');
    expect(await service({ refundReferenceScope: 'provider' }, { fact: null, indexPending: true, malformed: false, notified: true }).s.evidenceAfterFailure(failed)).toBe('unknown');
    expect(await service({ refundReferenceScope: 'provider' }, { fact: null, indexPending: false, malformed: true, notified: true }).s.evidenceAfterFailure(failed)).toBe('unknown');
    expect(await service({ refundReferenceScope: 'provider' }, { fact: null, indexPending: false, malformed: false, notified: true }).s.evidenceAfterFailure(failed)).toBe('notification_pending');
    expect(await service(null).s.evidenceAfterFailure({ ...failed, providerRefundId: null })).toBe('none');
  });
});
