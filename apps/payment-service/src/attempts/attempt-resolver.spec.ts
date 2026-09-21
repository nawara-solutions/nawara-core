import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttemptResolver } from './attempt-resolver.js';

/**
 * Audit finding M-02: an attempt whose provider is disabled or unknown must be skipped and left unresolved, never abort the pass
 * for the attempts behind it. (An `applyStatus` error INSIDE the per-attempt boundary is covered by R-06 in
 * `test/review-adversarial.e2e-spec.ts`; this is the provider LOOKUP that used to sit outside that boundary.)
 */
const OLD = new Date(Date.now() - 3_600_000).toISOString();
const attempt = (id: string, provider: string, status: 'unknown' | 'initiated' | 'submitted' = 'unknown', initiatedAt = OLD) => ({
  id, provider, status, initiatedAt, submittedAt: OLD, providerTransactionId: null, merchantReference: id,
});

describe('AttemptResolver provider isolation', () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => void logs.push(String(m)));
  });
  afterEach(() => vi.restoreAllMocks());

  const build = (rows: unknown[], enabled: string[]) => {
    const fetched: string[] = [];
    const applied: string[] = [];
    const provider = { capabilities: { timeoutMs: 200, visibilityLagMs: 50 }, fetchStatus: vi.fn(async (ref: string) => { fetched.push(ref); return { kind: 'pending' as const }; }) };
    // Mirrors ProviderRegistry: `get` throws for a provider that is not enabled, `tryGet` answers undefined.
    const registry = {
      get: vi.fn((id: string) => { if (!enabled.includes(id)) throw new Error(`Provider ${id} is not enabled.`); return provider; }),
      tryGet: vi.fn((id: string) => (enabled.includes(id) ? provider : undefined)),
    };
    const attempts = { applyStatus: vi.fn(async (id: string) => void applied.push(id)) };
    const resolver = new AttemptResolver({ query: async () => ({ rows }) } as never, registry as never, attempts as never);
    return { resolver, fetched, applied, attempts };
  };

  it.each([
    ['disabled (a provider that was enabled when the attempt was made)', 'acme'],
    ['unknown (an id no provider has ever had)', 'no-such-provider'],
  ])('a %s provider does not abort the pass: the attempts before and after it are processed, it stays unresolved', async (_name, missing) => {
    const { resolver, fetched, applied, attempts } = build([attempt('A', 'test'), attempt('B', missing), attempt('C', 'test')], ['test']);

    await expect(resolver.drainOnce()).resolves.toEqual({ resolved: 2 });

    expect(fetched).toEqual(['A', 'C']); // the provider is never asked about B
    expect(applied).toEqual(['A', 'C']);
    expect(attempts.applyStatus).not.toHaveBeenCalledWith('B', expect.anything(), expect.anything(), expect.anything());
  });

  it('emits the stable provider-unavailable outcome with the attempt id and provider id, and nothing else', async () => {
    const { resolver } = build([attempt('B-attempt-id', 'acme'), attempt('A', 'test')], ['test']);
    await resolver.drainOnce();
    const line = logs.find((l) => l.startsWith('attempt_resolver_provider_unavailable'));
    expect(line).toBe('attempt_resolver_provider_unavailable attempt=B-attempt-id provider=acme — left unresolved');
    expect(logs.filter((l) => l.startsWith('attempt_resolver_provider_unavailable'))).toHaveLength(1); // one per unavailable attempt, none for the healthy one
    expect(logs.some((l) => l.includes('could not be resolved'))).toBe(false); // not reported as a failure of the attempt
  });

  it('a provider-unavailable attempt at the head of the queue does not starve the ones behind it', async () => {
    const { resolver, applied } = build([attempt('poison', 'acme'), attempt('A', 'test'), attempt('C', 'test')], ['test']);
    await resolver.drainOnce();
    await resolver.drainOnce();
    expect(applied).toEqual(['A', 'C', 'A', 'C']); // every pass reaches the healthy attempts
  });

  it('keeps the wait-window rule for an available provider: a fresh initiated attempt is not asked about yet', async () => {
    const fresh = attempt('fresh', 'test', 'initiated', new Date().toISOString());
    const stuck = attempt('stuck', 'test', 'initiated', OLD);
    const { resolver, fetched } = build([attempt('B', 'acme', 'initiated'), fresh, stuck], ['test']);
    await resolver.drainOnce();
    expect(fetched).toEqual(['stuck']);
  });

  it('no provider enabled at all: every attempt is skipped and the pass still completes', async () => {
    const { resolver, applied } = build([attempt('A', 'test'), attempt('B', 'acme')], []);
    await expect(resolver.drainOnce()).resolves.toEqual({ resolved: 0 });
    expect(applied).toEqual([]);
    expect(logs.filter((l) => l.startsWith('attempt_resolver_provider_unavailable'))).toHaveLength(2);
  });
});
