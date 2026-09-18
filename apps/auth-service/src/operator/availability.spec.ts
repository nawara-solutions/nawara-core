import { describe, expect, it } from 'vitest';
import { zonedToUtc } from './availability.service.js';

describe('zonedToUtc (shift end -> instant)', () => {
  it('UTC is the identity', () => expect(zonedToUtc(2026, 3, 4, 17, 0, 'UTC').toISOString()).toBe('2026-03-04T17:00:00.000Z'));
  it('a fixed-offset zone (Tunisia, UTC+1)', () => expect(zonedToUtc(2026, 3, 4, 17, 0, 'Africa/Tunis').toISOString()).toBe('2026-03-04T16:00:00.000Z'));
  it('handles daylight saving on both sides of the change (New York, DST begins 2026-03-08)', () => {
    expect(zonedToUtc(2026, 3, 7, 17, 0, 'America/New_York').toISOString()).toBe('2026-03-07T22:00:00.000Z'); // EST, UTC-5
    expect(zonedToUtc(2026, 3, 9, 17, 0, 'America/New_York').toISOString()).toBe('2026-03-09T21:00:00.000Z'); // EDT, UTC-4
  });
});
