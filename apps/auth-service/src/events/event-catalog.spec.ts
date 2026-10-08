import { describe, expect, it } from 'vitest';
import type { DomainEvents } from '../common/ports.js';
import type { Queryable } from '../db/db.service.js';
import { AUTH_EVENT_VERSION, CODE_BEARING_EVENTS } from './domain-events.js';
import { PRODUCED_EVENTS, renderEventContract } from './event-catalog.js';

/**
 * Compile-time negative controls (V2 A3M.2): `npm run typecheck` fails if any of these lines stops being an error, i.e. if `emit`
 * stops being typed from the catalog. Never called.
 */
export function emitTypingControls(events: DomainEvents, q: Queryable): void {
  const ok = { userId: 'u', organizationId: 'o', channel: 'email', destination: null, timestamp: 't' } as const;
  void events.emit(q, 'membership.revoked', ok);
  // @ts-expect-error a name the catalog does not declare
  void events.emit(q, 'user.deleted', ok);
  // @ts-expect-error a field the catalog does not declare
  void events.emit(q, 'membership.revoked', { ...ok, extra: 1 });
  // @ts-expect-error a declared field missing
  void events.emit(q, 'membership.revoked', { userId: 'u', organizationId: 'o', channel: 'email', destination: null });
  // @ts-expect-error a channel outside the declared values
  void events.emit(q, 'membership.revoked', { ...ok, channel: 'sms' });
  // @ts-expect-error null where the catalog does not allow it
  void events.emit(q, 'membership.revoked', { ...ok, organizationId: null });
}

describe('auth-service event catalog (V2 A3M.2)', () => {
  it('contracts/events.json is exactly this catalog (regenerate with `vitest -u` after a deliberate contract change)', async () => {
    await expect(renderEventContract()).toMatchFileSnapshot('../../contracts/events.json');
  });

  it('the code-bearing events are exactly CODE_BEARING_EVENTS, whose rows the purge deletes (ADR-0052 decision 5)', () => {
    const flagged = Object.entries(PRODUCED_EVENTS).filter(([, e]) => 'codeBearing' in e && e.codeBearing).map(([n]) => n).sort();
    expect(flagged).toEqual([...CODE_BEARING_EVENTS].sort());
    for (const name of CODE_BEARING_EVENTS) expect(Object.keys(PRODUCED_EVENTS[name].payload)).toContain('code');
  });

  it('every event is published at AUTH_EVENT_VERSION', () => {
    for (const e of Object.values(PRODUCED_EVENTS)) expect(e.version).toBe(AUTH_EVENT_VERSION);
  });
});
