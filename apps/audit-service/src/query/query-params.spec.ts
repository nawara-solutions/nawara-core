import { HttpException } from '@nestjs/common';
import { decodeCursor, encodeCursor, parseOrganizationPath, parseQuery, queryFingerprint } from './query-params.js';

const ORG = '3c1d9b0e-2a4f-4b8e-8f6a-5d7e9c0b1a22';
const W = { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' };
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpException) return `${e.getStatus()}:${(e.getResponse() as { code: string }).code}`;
    return `threw:${(e as Error).message}`;
  }
  return 'ok';
};

describe('parseQuery (strict, closed grammars; nothing coerced, clamped or ignored)', () => {
  it('parses the window half-open, the default limit and every filter', () => {
    const q = parseQuery({ ...W, limit: '100', action: 'membership.revoked', category: 'business', actorType: 'user', actorId: ORG, resourceType: 'membership', resourceId: ORG,
      subjectType: 'user', subjectId: ORG, sourceService: 'auth-service', outcome: 'succeeded', correlationId: 'corr-0001-abcd' }, 'organization');
    expect(q.window).toEqual({ from: new Date(W.from), to: new Date(W.to) });
    expect(q.limit).toBe(100);
    expect(q.filters).toEqual({ action: 'membership.revoked', category: 'business', actor: { type: 'user', id: ORG }, resource: { type: 'membership', id: ORG },
      subject: { type: 'user', id: ORG }, sourceService: 'auth-service', outcome: 'succeeded', correlationId: 'corr-0001-abcd' });
    expect(parseQuery(W, 'organization').limit).toBe(50);
  });

  it('time windows: exactly 92 days (organization) and 31 days (platform) pass; one millisecond more is window_too_large', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const plus = (ms: number) => new Date(from.getTime() + ms).toISOString();
    expect(codeOf(() => parseQuery({ from: from.toISOString(), to: plus(92 * 86_400_000) }, 'organization'))).toBe('ok');
    expect(codeOf(() => parseQuery({ from: from.toISOString(), to: plus(92 * 86_400_000 + 1) }, 'organization'))).toBe('400:window_too_large');
    expect(codeOf(() => parseQuery({ from: from.toISOString(), to: plus(31 * 86_400_000) }, 'platform'))).toBe('ok');
    expect(codeOf(() => parseQuery({ from: from.toISOString(), to: plus(31 * 86_400_000 + 1) }, 'platform'))).toBe('400:window_too_large');
    expect(codeOf(() => parseQuery({ from: from.toISOString(), to: plus(32 * 86_400_000) }, 'platform'))).toBe('400:window_too_large'); // the 92-day rule is not the platform's
  });

  it.each([
    ['missing from', { to: W.to }],
    ['missing to', { from: W.from }],
    ['inverted', { from: W.to, to: W.from }],
    ['empty window', { from: W.from, to: W.from }],
    ['offset instead of Z', { from: '2026-09-01T00:00:00+01:00', to: W.to }],
    ['no zone', { from: '2026-09-01T00:00:00', to: W.to }],
    ['date only', { from: '2026-09-01', to: W.to }],
    ['impossible date', { from: '2026-02-30T00:00:00Z', to: W.to }],
    ['infinity', { from: '-infinity', to: 'infinity' }],
    ['now / epoch keywords', { from: 'epoch', to: 'now' }],
    ['microseconds', { from: '2026-09-01T00:00:00.000001Z', to: W.to }],
    ['limit 0', { ...W, limit: '0' }],
    ['limit 101', { ...W, limit: '101' }],
    ['limit negative', { ...W, limit: '-1' }],
    ['limit float', { ...W, limit: '1.5' }],
    ['limit NaN', { ...W, limit: 'NaN' }],
    ['limit huge', { ...W, limit: '99999999999999999999' }],
    ['limit with spaces', { ...W, limit: ' 5' }],
    ['limit leading zero', { ...W, limit: '05' }],
    ['unknown action', { ...W, action: 'membership.promoted' }],
    ['action wildcard', { ...W, action: 'membership.%' }],
    ['action regex', { ...W, action: 'membership.*' }],
    ['unknown category', { ...W, category: 'everything' }],
    ['unknown outcome', { ...W, outcome: 'failed' }],
    ['unknown source', { ...W, sourceService: 'evil-service' }],
    ['actorType without actorId', { ...W, actorType: 'user' }],
    ['actorId without actorType', { ...W, actorId: ORG }],
    ['user actor not a UUID', { ...W, actorType: 'user', actorId: "x' OR '1'='1" }],
    ['resource id not a UUID', { ...W, resourceType: 'membership', resourceId: '_%' }],
    ['subject type injection', { ...W, subjectType: 'user; DROP TABLE audit_record', subjectId: ORG }],
    ['correlation with control char', { ...W, correlationId: 'corr\n0001abcd' }],
    ['correlation with bidi', { ...W, correlationId: 'corr\u202e0001abcd' }],
    ['huge value', { ...W, action: 'a'.repeat(10_000) }],
    ['repeated parameter (array)', { ...W, action: ['membership.revoked', 'file.deleted'] }],
    ['repeated from', { from: [W.from, '2020-01-01T00:00:00Z'], to: W.to }],
    ['empty value', { ...W, category: '' }],
    ['unknown parameter', { ...W, organization_id: ORG }],
    ['prototype key', JSON.parse(`{"from":"${W.from}","to":"${W.to}","__proto__":"x"}`)],
    ['organizationId on the organization route (the path is the scope)', { ...W, organizationId: ORG }],
    ['platform flag on the organization route', { ...W, platform: 'true' }],
  ])('%s → 400', (_label, input) => {
    expect(codeOf(() => parseQuery(input, 'organization'))).toMatch(/^400:/);
  });

  it('platform route: all by default, one organization, or platform-level only; never both, never a list', () => {
    expect(parseQuery(W, 'platform').target).toEqual({ kind: 'platform', target: 'all' });
    expect(parseQuery({ ...W, organizationId: ORG }, 'platform').target).toEqual({ kind: 'platform', target: 'organization', organizationId: ORG });
    expect(parseQuery({ ...W, platform: 'true' }, 'platform').target).toEqual({ kind: 'platform', target: 'platform' });
    for (const bad of [{ ...W, organizationId: ORG, platform: 'true' }, { ...W, platform: 'false' }, { ...W, organizationId: '*' }, { ...W, organizationId: [ORG, ORG] }, { ...W, organizationId: ORG.toUpperCase() }]) {
      expect(codeOf(() => parseQuery(bad, 'platform'))).toMatch(/^400:invalid_query$/);
    }
  });

  it('the organization path must be a canonical UUID', () => {
    expect(parseOrganizationPath(ORG)).toBe(ORG);
    for (const bad of [ORG.toUpperCase(), 'null', '*', '', `${ORG} OR 1=1`, undefined]) expect(codeOf(() => parseOrganizationPath(bad))).toBe('400:invalid_scope');
  });
});

describe('cursor (opaque, bound to the exact query, position only)', () => {
  const scope = { kind: 'organization' as const, organizationId: ORG };
  const window = { from: new Date(W.from), to: new Date(W.to) };
  const fp = queryFingerprint('caller-a', scope, {}, window);
  const pos = { occurredAtUs: '1788220800123456', id: '42' };

  it('round-trips a position for the same query', () => {
    expect(decodeCursor(encodeCursor(pos, fp), fp)).toEqual(pos);
  });

  it('is bound to caller, scope, organization, every filter and the window', () => {
    const c = encodeCursor(pos, fp);
    const others = [
      queryFingerprint('caller-b', scope, {}, window),
      queryFingerprint('caller-a', { kind: 'organization', organizationId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c44' }, {}, window),
      queryFingerprint('caller-a', { kind: 'platform', target: 'all' }, {}, window),
      queryFingerprint('caller-a', { kind: 'platform', target: 'organization', organizationId: ORG }, {}, window),
      queryFingerprint('caller-a', scope, { action: 'file.deleted' }, window),
      queryFingerprint('caller-a', scope, { category: 'security' }, window),
      queryFingerprint('caller-a', scope, {}, { from: window.from, to: new Date(W.to.replace('02T', '03T')) }),
    ];
    expect(new Set(others).size).toBe(others.length);
    for (const other of others) expect(codeOf(() => decodeCursor(c, other))).toBe('400:invalid_cursor');
  });

  it.each([
    ['empty', ''],
    ['not base64url', '***'],
    ['truncated', encodeCursor(pos, fp).slice(0, 10)],
    ['huge', 'A'.repeat(5000)],
    ['base64 of non-JSON', Buffer.from('not json').toString('base64url')],
    ['JSON array', Buffer.from('[1,2]').toString('base64url')],
    ['missing field', Buffer.from(JSON.stringify({ v: 1, t: pos.occurredAtUs, q: fp })).toString('base64url')],
    ['extra field', Buffer.from(JSON.stringify({ v: 1, t: pos.occurredAtUs, i: pos.id, q: fp, organizationId: ORG })).toString('base64url')],
    ['future version', Buffer.from(JSON.stringify({ v: 2, t: pos.occurredAtUs, i: pos.id, q: fp })).toString('base64url')],
    ['wrong types', Buffer.from(JSON.stringify({ v: 1, t: 1788220800123456, i: 42, q: fp })).toString('base64url')],
    ['SQL in the position', Buffer.from(JSON.stringify({ v: 1, t: "1 OR 1=1", i: pos.id, q: fp })).toString('base64url')],
    ['id not a positive integer', Buffer.from(JSON.stringify({ v: 1, t: pos.occurredAtUs, i: '0', q: fp })).toString('base64url')],
    ['forged fingerprint', Buffer.from(JSON.stringify({ v: 1, t: pos.occurredAtUs, i: pos.id, q: '0'.repeat(24) })).toString('base64url')],
  ])('%s → 400 invalid_cursor', (_label, raw) => {
    expect(codeOf(() => decodeCursor(raw, fp))).toBe('400:invalid_cursor');
  });

  it('an altered position with the right fingerprint only moves inside the same authorized query (accepted, as a position)', () => {
    const altered = Buffer.from(JSON.stringify({ v: 1, t: '1', i: '1', q: fp })).toString('base64url');
    expect(decodeCursor(altered, fp)).toEqual({ occurredAtUs: '1', id: '1' });
  });
});
