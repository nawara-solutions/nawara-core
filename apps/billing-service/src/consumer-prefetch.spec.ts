import { describe, expect, it } from 'vitest';
import { consumerPrefetch } from './app.module.js';

describe('consumer prefetch derived from the database pool (Stage 15.8)', () => {
  it.each([
    [10, 5], // the defaults: half the pool
    [1, 1], // never zero
    [3, 1],
    [4, 2],
    [20, 10],
    [100, 10], // capped: a bigger window only holds more messages unacknowledged
  ])('pool %i → prefetch %i', (pool, prefetch) => {
    expect(consumerPrefetch(pool)).toBe(prefetch);
  });
});
