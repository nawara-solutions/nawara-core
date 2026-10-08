import { describe, expect, it } from 'vitest';
import { EVENT_MAP, INTAKE_BINDINGS } from '../intake/event-map.js';
import { CONSUMED_EVENTS, renderEventContract } from './event-catalog.js';

describe('notification-service event catalog (V2 A3M.2)', () => {
  it('contracts/events.json is exactly the intake mapping rendered as a contract (regenerate with `vitest -u` after a deliberate change)', async () => {
    await expect(renderEventContract()).toMatchFileSnapshot('../../contracts/events.json');
  });

  it('is rendered from EVENT_MAP, not maintained apart: one entry per mapping, the same names the queue binds', () => {
    expect(CONSUMED_EVENTS.map((c) => `${c.source}|${c.name}|${c.version}`)).toEqual(EVENT_MAP.map((m) => `${m.source}|${m.name}|${m.version}`));
    expect([...new Set(CONSUMED_EVENTS.map((c) => c.name))].sort()).toEqual([...INTAKE_BINDINGS].sort());
    for (const [i, c] of CONSUMED_EVENTS.entries()) expect(Object.keys(c.requires).sort()).toEqual(Object.keys(EVENT_MAP[i].payload).sort());
  });
});
