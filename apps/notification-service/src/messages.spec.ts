import { catalogProblems, renderMessage } from '@nawara/service-kit';
import { describe, expect, it } from 'vitest';
import { NOTIFICATION_MESSAGES } from './messages.js';
import { parseSendRequest } from './api/send-request.js';
import { variableValueProblems, validateVariableValues, type VariableSchema } from './templates/variables.js';

/** ADR-0054 D6 / D13 (Core V1 refactor R6.7): Notification's catalog is complete in en / fr / ar and renders the pre-R6.7 English. */
describe('NOTIFICATION_MESSAGES', () => {
  const en = (id: keyof typeof NOTIFICATION_MESSAGES, params?: Record<string, string | number>) => renderMessage(NOTIFICATION_MESSAGES[id], 'en', params).text;

  it('is complete: every message has non-empty en, fr and ar text with identical placeholders', () => {
    expect(catalogProblems(NOTIFICATION_MESSAGES)).toEqual([]);
  });

  it('renders, with its parameters, exactly the English Notification returned before R6.7', () => {
    const before: [string, string][] = [
      [en('idempotencyKeyRequired'), 'The Idempotency-Key header is required.'],
      [en('templateNotAllowed'), 'This caller may not use this template.'],
      [en('channelNotAllowed'), 'This caller may not use this channel.'],
      [en('organizationNotAllowed'), 'This caller may not address an organization.'],
      [en('duplicateChannel'), 'A channel is listed twice: one delivery per channel.'],
      [en('scheduledAtRange', { max: 2592000 }), 'scheduledAt must be in the future and at most 2592000 s ahead.'],
      [en('expiresAtRange'), 'expiresAt must be in the future and after scheduledAt.'],
      [en('unknownTemplate'), 'No published version of this template exists for this channel.'],
      [en('invalidDestinationOne', { channel: 'SMS' }), 'The SMS destination is not valid (SMS: E.164 such as +21620000000; EMAIL: an address).'],
      [en('invalidDestinationTwo', { first: 'SMS', second: 'EMAIL' }), 'The SMS and EMAIL destination is not valid (SMS: E.164 such as +21620000000; EMAIL: an address).'],
      [en('notificationNotFound'), 'Notification not found.'],
      [en('deliveryInProgress', { cancelled: 2, sending: 1 }), '2 pending deliveries were cancelled; 1 already being sent cannot be recalled.'],
      [en('idempotencyKeyReused'), 'This Idempotency-Key was already used with a different request.'],
      [en('idempotencyKeyFormat'), 'Idempotency-Key: must be 8-128 characters of letters, digits and . _ : -'],
      [en('bodyMustBeObject'), 'the body must be a JSON object'],
      [en('notAField', { name: 'subject' }), 'subject: is not a field of this request'],
      [en('templateKey'), 'template: must be a template key'],
      [en('organizationId'), 'organizationId: must be a uuid or null'],
      [en('recipient'), 'recipient: must be {"type", "id"} (a lowercase type, an id of 1-128 characters)'],
      [en('locale'), 'locale: must be a BCP 47 locale'],
      [en('channelsCount', { max: 2 }), 'channels: must list 1-2 channels'],
      [en('channelItem', { index: 1, channels: 'EMAIL | SMS' }), 'channels[1]: must be {"channel": EMAIL | SMS, "destination": a string of 1-320 characters}'],
      [en('dataObject'), 'data: must be an object'],
      [en('utcDateTime', { field: 'scheduledAt' }), 'scheduledAt: must be an ISO 8601 UTC date-time'],
      [en('variableInvalid', { name: 'code' }), 'code: is invalid'],
    ];
    expect(before).toHaveLength(Object.keys(NOTIFICATION_MESSAGES).length); // every entry is pinned
    for (const [rendered, expected] of before) expect(rendered).toBe(expected);
  });

  it('translates every message for real, never leaks a catalog key, and keeps EMAIL / SMS / identifiers verbatim', () => {
    for (const [id, texts] of Object.entries(NOTIFICATION_MESSAGES)) {
      expect(texts.fr, id).not.toBe(texts.en);
      expect(texts.ar, id).toMatch(/[؀-ۿ]/);
      for (const text of [texts.en, texts.fr, texts.ar]) expect(text, id).not.toMatch(/undefined|NOTIFICATION_MESSAGES/);
    }
    for (const id of ['invalidDestinationOne', 'invalidDestinationTwo'] as const) {
      for (const l of ['fr', 'ar'] as const) expect(NOTIFICATION_MESSAGES[id][l]).toMatch(/SMS.*EMAIL/s);
      expect(NOTIFICATION_MESSAGES[id].fr + NOTIFICATION_MESSAGES[id].ar).not.toMatch(/\band\b/);
    }
  });
});

describe('provenance (D10) and English compatibility of the API problem lists', () => {
  it('the parser keeps its English problems exactly and gives each one an identity', () => {
    const r = parseSendRequest({ template: 'x', channels: [], subject: 'SECRET' });
    expect('problems' in r).toBe(true);
    if (!('problems' in r)) return;
    expect(r.problems).toEqual(['subject: is not a field of this request', 'template: must be a template key', 'channels: must list 1-2 channels']);
    expect(r.localized).toHaveLength(r.problems.length);
    expect(r.localized.map((i) => i.prefix + renderMessage(i.message.texts, 'en', i.message.params).text)).toEqual(r.problems);
  });

  it('a variable problem names its source: the template schema (server) or the caller\'s data (client); the English is unchanged', () => {
    const schema: VariableSchema = { code: { type: 'code', required: true, maxLength: 8 } };
    const values = { code: '30-59', clientKey: 1 };
    expect(variableValueProblems(schema, values).map((p) => p.source)).toEqual(['template', 'data']);
    expect(variableValueProblems(schema, values).map((p) => p.text)).toEqual(validateVariableValues(schema, values));
  });
});
