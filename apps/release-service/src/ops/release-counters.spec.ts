import { describe, expect, it } from 'vitest';
import { ADMIN_OPERATIONS, ADMIN_OUTCOMES, AUTOMATION_OPERATIONS, AUTOMATION_OUTCOMES, ReleaseCounters } from './release-counters.js';
import { COMPATIBILITY_OUTCOMES, CompatibilityCounters } from '../compatibility/compatibility-counters.js';

describe('release-service operational counters (Stage 20.6): bounded by construction', () => {
  it('a fixed grid: operation × outcome, zeros included, in a fixed order; drained on read', () => {
    const c = new ReleaseCounters();
    c.automation.count('register', 'changed');
    c.automation.count('register', 'changed');
    c.automation.count('publish', 'denied');
    c.admin.count('withdraw', 'auth_timeout');
    const a = c.automation.drain();
    expect(a).toHaveLength(AUTOMATION_OPERATIONS.length * AUTOMATION_OUTCOMES.length);
    expect(Object.fromEntries(a)).toMatchObject({ register_changed: 2, publish_denied: 1, register_failed: 0 });
    expect(c.admin.drain()).toHaveLength(ADMIN_OPERATIONS.length * ADMIN_OUTCOMES.length);
    expect(Object.fromEntries(c.automation.drain()).register_changed).toBe(0); // reset
  });

  it('no value can create a new label: unknown operations or outcomes (a product, a version, a caller) are dropped', () => {
    const c = new ReleaseCounters();
    for (const junk of ['drive', '1.2.3', 'drive-ci', 'c0ffee00-0000-4000-8000-000000000001', '10.0.0.1']) {
      c.automation.count(junk as never, 'changed');
      c.automation.count('register', junk as never);
      c.admin.count(junk as never, junk as never);
    }
    const labels = [...c.automation.drain(), ...c.admin.drain()].map(([k]) => k);
    expect(labels.length).toBe(AUTOMATION_OPERATIONS.length * AUTOMATION_OUTCOMES.length + ADMIN_OPERATIONS.length * ADMIN_OUTCOMES.length);
    for (const l of labels) expect(l).toMatch(/^[a-z_]+$/);
  });

  it('the compatibility counters are a closed outcome set too', () => {
    const c = new CompatibilityCounters();
    c.count('available', 3);
    c.count('rate_limited');
    const d = c.drain();
    expect(Object.keys(d.counts)).toEqual([...COMPATIBILITY_OUTCOMES]);
    expect(d.counts).toMatchObject({ available: 1, rate_limited: 1 });
    expect(d.latency).toEqual({ count: 1, avgMs: 3, maxMs: 3 });
  });
});
