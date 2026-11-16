import type { ChannelModel, GetMessage } from 'amqplib';
import type pg from 'pg';
import { expect } from 'vitest';
import { waitFor } from './process.js';

/**
 * Core V2 DO-68 (test aid shared by the certifications that run the live audit-service): the cross-process delivery check first written as the
 * last case of `s0c14-overlap-certification`, generalized so that every suite producing financial audit intents can assert them under the same
 * contract. It reads EVERY audit intent Billing and Payment committed during the calling suite (`outbox` rows named `audit.*`) and requires:
 *   * each was published by its producer's relay;
 *   * each reached the live audit-service EXACTLY ONCE, under its producer's own source and event id, as the action its outbox recorded;
 *   * the `required` actions (the families the calling suite drives) are among them, so a regression that stops producing one is caught;
 *   * audit-service dead-lettered none of them (only the redacted identity-probe shape, a 2-byte malformed envelope, is tolerated).
 * It covers what the calling suite produces, nothing more: it is never evidence of production-wide completeness (DO-69 stays open). Dead
 * letters are read and put back unchanged.
 */
export async function assertAuditDelivery(o: {
  billingAdmin: pg.Pool;
  paymentAdmin: pg.Pool;
  auditAdmin: pg.Pool;
  amqpConn: ChannelModel;
  required: readonly string[];
  diagnostics: () => string;
}): Promise<{ intents: number; actions: string[]; deadLetters: number }> {
  type Intent = { id: string; name: string; publishedAt: Date | null; source: string };
  const intents = async (): Promise<Intent[]> => [
    ...(await o.billingAdmin.query(`SELECT id, name, "publishedAt" FROM outbox WHERE name LIKE 'audit.%'`)).rows.map((r) => ({ ...r, source: 'billing-service' })),
    ...(await o.paymentAdmin.query(`SELECT id, name, "publishedAt" FROM outbox WHERE name LIKE 'audit.%'`)).rows.map((r) => ({ ...r, source: 'payment-service' })),
  ];
  await waitFor(async () => (await intents()).every((r) => r.publishedAt !== null), 90_000, `every audit intent published\n${o.diagnostics()}`);
  const all = await intents();
  const key = (source: string, id: string) => `${source}:${id}`;
  const stored = async () => (await o.auditAdmin.query(
    `SELECT "eventId", "sourceService", action FROM audit_record WHERE "sourceService" IN ('billing-service', 'payment-service')`)).rows as Array<{ eventId: string; sourceService: string; action: string }>;
  await waitFor(async () => {
    const have = new Set((await stored()).map((r) => key(r.sourceService, r.eventId)));
    return all.every((r) => have.has(key(r.source, r.id)));
  }, 120_000, `audit-service to record every intent\n${o.diagnostics()}`);
  const rows = await stored();
  const byKey = new Map<string, string[]>();
  for (const r of rows) byKey.set(key(r.sourceService, r.eventId), [...(byKey.get(key(r.sourceService, r.eventId)) ?? []), r.action]);
  expect(all.filter((r) => !byKey.has(key(r.source, r.id))).map((r) => r.name), 'an intent never stored').toEqual([]);
  expect(all.filter((r) => (byKey.get(key(r.source, r.id)) ?? []).length !== 1).map((r) => r.name), 'an intent stored more than once').toEqual([]);
  expect(all.filter((r) => byKey.get(key(r.source, r.id))?.[0] !== r.name.slice('audit.'.length)).map((r) => r.name), 'an intent stored as another action').toEqual([]);
  const actions = [...new Set(all.map((r) => r.name.slice('audit.'.length)))].sort();
  expect(actions, 'the families this suite drives').toEqual(expect.arrayContaining([...o.required]));
  const ch = await o.amqpConn.createChannel();
  const deadMessages: GetMessage[] = [];
  for (let m = await ch.get('audit-service.audit.dead', { noAck: false }); m; m = await ch.get('audit-service.audit.dead', { noAck: false })) deadMessages.push(m);
  const dead = deadMessages.map((m) => JSON.parse(m.content.toString()) as Record<string, unknown>);
  for (const m of deadMessages) ch.nack(m, false, true);
  await ch.close();
  expect(dead.filter((d) => !(d.redacted === true && d.reason === 'malformed_envelope' && d.bodyBytes === 2)), 'an audit dead letter other than the identity probe').toEqual([]);
  return { intents: all.length, actions, deadLetters: dead.length };
}
