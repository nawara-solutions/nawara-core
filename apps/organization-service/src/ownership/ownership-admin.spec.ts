import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JsonLogger } from '@nawara/service-kit';
import { OwnershipAdmin, OwnershipError, type AdminDb } from './ownership-admin.js';

const PERSON = 'Jane Q. Person';
const SNAPSHOT = readFileSync(new URL('../../test/fixtures/hierarchy-snapshot.v1.json', import.meta.url), 'utf8');

/**
 * V2 A12.4.3: an ownership refusal logs its operational code as `errorCode`, which the logger shows, never under a bare `code` key,
 * which the logger redacts by design (W2: Auth carries a secret under `code`). V2 A12.4.5: the operator's `--actor` is a person's name
 * (schema 0004), so it is evidence in `ownership_event` only, never an operational log field. A refusal path and the offline snapshot
 * check only, against a fake database that is in PREPARED: nothing is transitioned (G7 / F6 / F7 stay locked).
 */
describe('ownership operational log', () => {
  function setup() {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const inserts: unknown[][] = [];
    const db: AdminDb = {
      query: (async (sql: string, params: unknown[] = []) => {
        if (/INSERT INTO ownership_event/.test(sql)) inserts.push(params);
        return /FROM ownership_state/.test(sql) ? { rows: [{ phase: 'PREPARED' }], rowCount: 1 } : { rows: [], rowCount: 1 };
      }) as never,
      tx: (async (fn: (q: AdminDb) => Promise<unknown>) => fn(db)) as never,
    };
    const admin = new OwnershipAdmin(db, { environment: 'test', correlationId: 'corr-12345678', log: (event, fields) => events.push({ event, fields }) });
    return { admin, events, inserts };
  }
  const render = (events: Array<{ event: string; fields: Record<string, unknown> }>) => {
    const lines: string[] = [];
    const logger = new JsonLogger('organization-service', 'info', (l) => lines.push(l));
    for (const e of events) logger.info(e.event, e.fields);
    return lines;
  };

  it('ownership_activation_rejected carries errorCode, visible through the JsonLogger; the actor is in the audit row, not the line', async () => {
    const { admin, events, inserts } = setup();
    await expect(admin.activate(PERSON, 'ACTIVATE-AUTHORITY')).rejects.toBeInstanceOf(OwnershipError);

    const rejected = events.find((e) => e.event === 'ownership_activation_rejected');
    expect(rejected?.fields).toEqual({ errorCode: 'not_activatable' });
    expect(events.some((e) => 'code' in e.fields || 'actor' in e.fields)).toBe(false);
    expect(inserts.some((p) => p.includes(PERSON))).toBe(true); // audit evidence unchanged

    const lines = render(events);
    expect(JSON.parse(lines.find((l) => l.includes('ownership_activation_rejected'))!)).toMatchObject({ msg: 'ownership_activation_rejected', errorCode: 'not_activatable' });
    expect(lines.join('\n')).not.toContain('Jane');
  });

  it('the offline snapshot check logs the digest and counts, never the actor', () => {
    const { admin, events } = setup();
    const v = admin.verifySnapshotText(PERSON, SNAPSHOT);
    const lines = render(events);
    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: 'ownership_snapshot_verified', snapshotDigest: v.snapshot.digests.whole });
    expect(lines.join('\n')).not.toContain('Jane');
  });
});
