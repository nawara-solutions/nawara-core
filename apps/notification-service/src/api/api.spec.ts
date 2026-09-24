import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, canonicalJson } from '@nawara/service-kit';
import { NotificationCallerPolicy } from './caller-policy.js';
import { requestHash, sameRequestHash } from './request-hash.js';
import { IDEMPOTENCY_KEY, parseSendRequest } from './send-request.js';

const entry = (over: Record<string, unknown> = {}) => ({ templates: ['membership.approved'], channels: ['EMAIL'], organizations: 'none', ...over });
const policy = (callers: Record<string, unknown>) => JSON.stringify({ callers });

describe('NOTIFICATION_SERVICE_POLICY (SDD §11.2): parsed at startup, deny by default', () => {
  it('parses an explicit policy per registered caller', () => {
    const p = NotificationCallerPolicy.parse(policy({ a: entry(), b: entry({ templates: ['membership.approved', 'identity.operator_login_code'], channels: ['EMAIL', 'SMS'], organizations: 'request' }) }), ['a', 'b']);
    expect([...p.of('a')!.templates]).toEqual(['membership.approved']);
    expect(p.of('b')!.organizations).toBe('request');
    expect(p.of('c')).toBeUndefined();
  });
  it('no tokens and no policy is fine (nothing can call)', () => {
    expect(NotificationCallerPolicy.parse(undefined, []).of('a')).toBeUndefined();
  });
  it.each([
    ['a registered caller without an entry', undefined, ['a'], /required/],
    ['a registered caller missing from the policy', policy({ a: entry() }), ['a', 'b'], /"b" has no NOTIFICATION_SERVICE_POLICY entry/],
    ['an entry for a caller with no token', policy({ a: entry(), x: entry() }), ['a'], /"x", which has no registered service token/],
    ['invalid JSON', '{callers', ['a'], /valid JSON/],
    ['no callers object', JSON.stringify({ a: entry() }), ['a'], /\{"callers"/],
    ['an extra top-level key', JSON.stringify({ callers: { a: entry() }, admin: true }), ['a'], /\{"callers"/],
    ['a wildcard template', policy({ a: entry({ templates: ['*'] }) }), ['a'], /invalid template key/],
    ['an empty templates list', policy({ a: entry({ templates: [] }) }), ['a'], /non-empty templates/],
    ['IN_APP', policy({ a: entry({ channels: ['IN_APP'] }) }), ['a'], /channel other than EMAIL \/ SMS/],
    ['PUSH', policy({ a: entry({ channels: ['PUSH'] }) }), ['a'], /channel other than/],
    ['an unknown organizations mode', policy({ a: entry({ organizations: 'any' }) }), ['a'], /"none" or "request"/],
    ['an unknown property (a category)', policy({ a: entry({ categories: ['SECURITY'] }) }), ['a'], /unknown property "categories"/],
  ])('refuses %s', (_l, raw, registered, message) => {
    expect(() => NotificationCallerPolicy.parse(raw as string | undefined, registered as string[])).toThrow(ConfigError);
    expect(() => NotificationCallerPolicy.parse(raw as string | undefined, registered as string[])).toThrow(message as RegExp);
  });
});

describe('the send request (SDD §7.2): every field typed and bounded, unknown fields refused', () => {
  const good = { template: 'membership.approved', channels: [{ channel: 'EMAIL', destination: 'p@example.test' }] };
  it('accepts the minimal and the full request, defaults applied', () => {
    expect(parseSendRequest(good)).toEqual({ value: { template: 'membership.approved', organizationId: null, recipient: null, locale: null, channels: good.channels, data: {}, scheduledAt: null, expiresAt: null } });
    const full = { ...good, organizationId: '8c2f1e4a-1111-4222-8333-944455556666', recipient: { type: 'user', id: 'u-1' }, locale: 'fr-TN', data: { a: 1 }, scheduledAt: '2030-01-01T00:00:00Z', expiresAt: '2030-01-02T00:00:00.000Z' };
    expect('value' in parseSendRequest(full)).toBe(true);
  });
  it.each([
    [null], [[]], ['text'], [{ ...good, template: 'Not A Key' }], [{ ...good, channels: [] }], [{ ...good, channels: [...good.channels, ...good.channels, ...good.channels] }],
    [{ ...good, channels: [{ channel: 'EMAIL' }] }], [{ ...good, channels: [{ channel: 'EMAIL', destination: 'p@example.test', provider: 'x' }] }],
    [{ ...good, organizationId: 'org-1' }], [{ ...good, recipient: { type: 'User', id: 'u' } }], [{ ...good, recipient: { type: 'user', id: 'u', email: 'x' } }],
    [{ ...good, locale: 'french' }], [{ ...good, data: [] }], [{ ...good, scheduledAt: '2030-01-01' }], [{ ...good, expiresAt: 5 }],
    [{ ...good, status: 'SENT' }], [{ ...good, category: 'SECURITY' }], [{ ...good, subject: 'x' }], [{ ...good, bodyText: 'x' }], [{ ...good, caller: 'x' }],
  ])('refuses %j', (body) => {
    expect('problems' in parseSendRequest(body)).toBe(true);
  });
  it('problems name fields, never values', () => {
    const r = parseSendRequest({ ...good, secretField: 'SENTINEL-123', locale: 'SENTINEL-456' });
    expect(JSON.stringify(r)).not.toContain('SENTINEL');
  });
  it('Idempotency-Key: 8-128 of [A-Za-z0-9._:-]', () => {
    for (const k of ['abcdefgh', 'order:42.retry_1-x', 'a'.repeat(128)]) expect(IDEMPOTENCY_KEY.test(k)).toBe(true);
    for (const k of ['short', 'a'.repeat(129), 'has space', 'semi;colon', 'é-accent-key']) expect(IDEMPOTENCY_KEY.test(k)).toBe(false);
  });
});

describe('the request hash: HMAC-SHA-256 over the canonical request (Stage 16.6 decision)', () => {
  const key = randomBytes(32);
  const body = { template: 'identity.operator_login_code', channels: [{ channel: 'SMS', destination: '+21620000003' }], data: { code: '482913', expiresAt: '2030-01-01T00:00:00Z' } };
  it('is stable across property order and whitespace (the kit canonical JSON)', () => {
    const reordered = JSON.parse(JSON.stringify({ data: { expiresAt: body.data.expiresAt, code: body.data.code }, channels: body.channels, template: body.template }, null, 4));
    expect(requestHash(key, reordered)).toBe(requestHash(key, body));
  });
  it('changes with any field, the secret code included, and with the key', () => {
    const h = requestHash(key, body);
    expect(requestHash(key, { ...body, data: { ...body.data, code: '482914' } })).not.toBe(h);
    expect(requestHash(key, { ...body, template: 'identity.contact_verification_code' })).not.toBe(h);
    expect(requestHash(randomBytes(32), body)).not.toBe(h);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it('is not the unkeyed SHA-256 of the canonical request (with or without the domain prefix)', () => {
    const doc = canonicalJson(body);
    expect(requestHash(key, body)).not.toBe(createHash('sha256').update(doc).digest('hex'));
    expect(requestHash(key, body)).not.toBe(createHash('sha256').update(`nawara.notification.api.v1|${doc}`).digest('hex'));
  });
  it('compares in constant time and refuses anything but two 32-byte digests', () => {
    const h = requestHash(key, body);
    expect(sameRequestHash(h, h)).toBe(true);
    expect(sameRequestHash(h, requestHash(key, { ...body, template: 'x.y' }))).toBe(false);
    expect(sameRequestHash(h, h.slice(0, 62))).toBe(false);
    expect(sameRequestHash('', '')).toBe(false);
  });
});
