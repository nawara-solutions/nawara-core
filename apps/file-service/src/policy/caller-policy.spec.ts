import { describe, expect, it } from 'vitest';
import { ConfigError } from '@nawara/service-kit';
import { FILE_OPERATIONS, FileCallerPolicy } from './caller-policy.js';
import { FILE_MEDIA_TYPES } from './media-types.js';

const CEILING = 25 * 1024 * 1024;
const parse = (callers: unknown, registered: string[] = Object.keys(callers as object)) => FileCallerPolicy.parse(JSON.stringify({ callers }), registered, CEILING);
const uploader = { operations: ['upload', 'read', 'attach', 'delete', 'issue_ticket'], organizations: 'request', mediaTypes: ['application/pdf', 'image/jpeg'], maxBytes: 10_485_760 };
const reader = { operations: ['read'], organizations: 'none' };

describe('FILE_SERVICE_POLICY', () => {
  it('parses an explicit policy per caller: operations, organization mode, media types and a size ceiling', () => {
    const p = parse({ 'core-drive': uploader, 'core-notification': reader });
    expect(p.of('core-drive')).toEqual({
      operations: new Set(FILE_OPERATIONS), organizations: 'request', mediaTypes: new Set(['application/pdf', 'image/jpeg']), maxBytes: 10_485_760,
    });
    expect(p.of('core-notification')).toEqual({ operations: new Set(['read']), organizations: 'none', mediaTypes: undefined, maxBytes: undefined });
  });

  it('deny by default: an unknown caller and an operation not granted are refused', () => {
    const p = parse({ 'core-notification': reader });
    expect(p.allows('core-notification', 'read')).toBe(true);
    for (const op of ['upload', 'delete', 'attach', 'issue_ticket'] as const) expect(p.allows('core-notification', op)).toBe(false);
    expect(p.allows('someone-else', 'read')).toBe(false);
    expect(p.of('someone-else')).toBeUndefined();
    expect(FileCallerPolicy.parse(undefined, [], CEILING).allows('anyone', 'read')).toBe(false); // no policy, no caller: nothing allowed
  });

  it('every registered caller needs an entry, and an entry needs a registered caller', () => {
    expect(() => FileCallerPolicy.parse(undefined, ['core-drive'], CEILING)).toThrow(/required/);
    expect(() => parse({ 'core-drive': uploader }, ['core-drive', 'core-billing'])).toThrow(/"core-billing" has no FILE_SERVICE_POLICY entry/);
    expect(() => parse({ 'core-drive': uploader }, [])).toThrow(/no registered service token/);
  });

  it.each([
    ['not JSON', '{callers'],
    ['a wrong top level', JSON.stringify({ policies: {} })],
    ['an extra top-level key', JSON.stringify({ callers: {}, other: 1 })],
    ['a non-object entry', JSON.stringify({ callers: { a: [] } })],
    ['an unknown property', JSON.stringify({ callers: { a: { ...reader, admin: true } } })],
    ['no operations', JSON.stringify({ callers: { a: { operations: [], organizations: 'none' } } })],
    ['an unknown operation', JSON.stringify({ callers: { a: { operations: ['read', 'list'], organizations: 'none' } } })],
    ['a wildcard operation', JSON.stringify({ callers: { a: { operations: ['*'], organizations: 'none' } } })],
    ['a repeated operation', JSON.stringify({ callers: { a: { operations: ['read', 'read'], organizations: 'none' } } })],
    ['no organization mode', JSON.stringify({ callers: { a: { operations: ['read'] } } })],
    ['an unknown organization mode', JSON.stringify({ callers: { a: { operations: ['read'], organizations: 'any' } } })],
    ['an uploader without media types', JSON.stringify({ callers: { a: { operations: ['upload'], organizations: 'none', maxBytes: 10 } } })],
    ['a ticket issuer without media types', JSON.stringify({ callers: { a: { operations: ['issue_ticket'], organizations: 'none', maxBytes: 10 } } })],
    ['a media type outside the V1 allow-list', JSON.stringify({ callers: { a: { operations: ['upload'], organizations: 'none', mediaTypes: ['image/svg+xml'], maxBytes: 10 } } })],
    ['an executable media type', JSON.stringify({ callers: { a: { operations: ['upload'], organizations: 'none', mediaTypes: ['application/x-msdownload'], maxBytes: 10 } } })],
    ['an uploader without maxBytes', JSON.stringify({ callers: { a: { operations: ['upload'], organizations: 'none', mediaTypes: ['image/png'] } } })],
    ['maxBytes above the ceiling (a caller raising its own limit)', JSON.stringify({ callers: { a: { operations: ['upload'], organizations: 'none', mediaTypes: ['image/png'], maxBytes: CEILING + 1 } } })],
    ['maxBytes zero', JSON.stringify({ callers: { a: { operations: ['upload'], organizations: 'none', mediaTypes: ['image/png'], maxBytes: 0 } } })],
    ['maxBytes not an integer', JSON.stringify({ callers: { a: { operations: ['upload'], organizations: 'none', mediaTypes: ['image/png'], maxBytes: '10' } } })],
    ['media types on a read-only caller', JSON.stringify({ callers: { a: { operations: ['read'], organizations: 'none', mediaTypes: ['image/png'] } } })],
    ['maxBytes on a read-only caller', JSON.stringify({ callers: { a: { operations: ['read'], organizations: 'none', maxBytes: 10 } } })],
  ])('refuses %s at startup', (_label, raw) => {
    expect(() => FileCallerPolicy.parse(raw, ['a'], CEILING)).toThrow(ConfigError);
  });

  it('the V1 allow-list is exactly the frozen one (ADR-0048 F13)', () => {
    expect([...FILE_MEDIA_TYPES]).toEqual(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
  });
});
