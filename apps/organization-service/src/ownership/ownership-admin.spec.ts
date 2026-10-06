import { describe, expect, it } from 'vitest';
import { JsonLogger } from '@nawara/service-kit';
import { OwnershipAdmin, OwnershipError, type AdminDb } from './ownership-admin.js';

/**
 * V2 A12.4.3: an ownership refusal logs its operational code as `errorCode`, which the logger shows, never under a bare `code` key,
 * which the logger redacts by design (W2: Auth carries a secret under `code`). A refusal path only, against a fake database that is in
 * PREPARED: nothing is transitioned (G7 / F6 / F7 stay locked).
 */
describe('ownership refusals log errorCode', () => {
  it('ownership_activation_rejected carries errorCode, visible through the JsonLogger', async () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const db: AdminDb = {
      query: (async (sql: string) => (/FROM ownership_state/.test(sql) ? { rows: [{ phase: 'PREPARED' }], rowCount: 1 } : { rows: [], rowCount: 1 })) as never,
      tx: (async (fn: (q: AdminDb) => Promise<unknown>) => fn(db)) as never,
    };
    const admin = new OwnershipAdmin(db, { environment: 'test', correlationId: 'corr-12345678', log: (event, fields) => events.push({ event, fields }) });
    await expect(admin.activate('op', 'ACTIVATE-AUTHORITY')).rejects.toBeInstanceOf(OwnershipError);

    const rejected = events.find((e) => e.event === 'ownership_activation_rejected');
    expect(rejected?.fields).toEqual({ actor: 'op', errorCode: 'not_activatable' });
    expect(events.some((e) => 'code' in e.fields)).toBe(false);

    const lines: string[] = [];
    new JsonLogger('organization-service', 'info', (l) => lines.push(l)).info(rejected!.event, rejected!.fields);
    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: 'ownership_activation_rejected', errorCode: 'not_activatable' });
  });
});
