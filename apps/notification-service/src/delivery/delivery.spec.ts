import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { retryDelayMs } from './backoff.js';
import { destinationIdentity } from './destination-limiter.js';
import { boundedCode } from './provider.js';
import { RenderError, render, type PinnedVersion } from './renderer.js';
import { TestProvider } from './test-provider.js';

const EMAIL: PinnedVersion = {
  channel: 'EMAIL', locale: 'en',
  variables: { code: { type: 'code', required: true, secret: true, maxLength: 12 }, when: { type: 'datetime', required: true }, name: { type: 'string', required: false, maxLength: 40 }, link: { type: 'url', required: false, maxLength: 200 }, n: { type: 'integer', required: false } },
  subject: 'Code for {{name}}', bodyText: 'Code {{code}} until {{when}}. {{n}}', bodyHtml: '<p>Hi {{name}} <a href="{{link}}">x</a></p>', smsMaxSegments: null,
};
const SMS: PinnedVersion = { channel: 'SMS', locale: 'en', variables: { code: { type: 'code', required: true, secret: true, maxLength: 12 }, s: { type: 'string', required: false, maxLength: 2048 } }, subject: null, bodyText: 'Code {{code}} {{s}}', bodyHtml: null, smsMaxSegments: 1 };
const WHEN = '2026-09-24T10:30:00Z';

describe('renderer (SDD §6.3)', () => {
  it('renders the pinned version: text substitution, datetime per locale and platform zone, deterministic', () => {
    const m = render(EMAIL, { code: '123456', when: WHEN, name: 'Ann', n: 7 }, 'a@example.test', 'UTC');
    expect(m).toEqual({ channel: 'EMAIL', destination: 'a@example.test', subject: 'Code for Ann', text: 'Code 123456 until Sep 24, 2026, 10:30 AM. 7', html: '<p>Hi Ann <a href="">x</a></p>' });
    expect(render(EMAIL, { code: '123456', when: WHEN, name: 'Ann', n: 7 }, 'a@example.test', 'UTC')).toEqual(m);
    expect(render(EMAIL, { code: '1', when: WHEN }, 'a@example.test', 'Africa/Tunis').text).toContain('11:30 AM'); // UTC+1
    expect(render({ ...EMAIL, locale: 'fr' }, { code: '1', when: WHEN }, 'a@example.test', 'UTC').text).toContain('24 sept. 2026');
  });

  it('HTML-escapes variables in the HTML part only; the text part is text', () => {
    const m = render(EMAIL, { code: '1', when: WHEN, name: '<b>"x"&\'', link: 'https://e.test/?a=1&b="2"' }, 'a@example.test', 'UTC');
    expect(m.html).toBe('<p>Hi &lt;b&gt;&quot;x&quot;&amp;&#39; <a href="https://e.test/?a=1&amp;b=&quot;2&quot;">x</a></p>');
    expect(m.subject).toBe('Code for <b>"x"&\'');
  });

  it('refuses a subject line break (no header injection), a non-https url, a wrong type or a missing required value', () => {
    const bad: Record<string, unknown>[] = [
      { code: '1', when: WHEN, name: 'a\r\nBcc: x@evil.test' },
      { code: '1', when: WHEN, link: 'http://e.test' },
      { code: '1', when: WHEN, link: 'javascript:alert(1)' },
      { code: '1', when: 'not a date' },
      { code: '1', when: WHEN, n: 1.5 },
      { code: '1', when: WHEN, n: '7' },
      { code: 7, when: WHEN },
      { code: '1', when: WHEN, name: 'x'.repeat(41) },
      { when: WHEN },
    ];
    for (const values of bad) {
      expect(() => render(EMAIL, values, 'a@example.test', 'UTC'), JSON.stringify(Object.keys(values))).toThrow(RenderError);
    }
  });

  it('an unknown placeholder in a (corrupt) version is render_failed, and the error never carries a value', () => {
    try {
      render({ ...EMAIL, bodyText: '{{other}} {{code}}' }, { code: 'SECRET-123', when: WHEN }, 'a@example.test', 'UTC');
      throw new Error('no throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RenderError);
      expect((e as RenderError).code).toBe('render_failed');
      expect(String((e as Error).message) + String((e as Error).stack)).not.toContain('SECRET-123');
    }
  });

  it('an SMS over its smsMaxSegments is content_too_long (the provider is never called with it)', () => {
    expect(render(SMS, { code: '1', s: 'x'.repeat(100) }, '+21620000000', 'UTC').text).toHaveLength(107);
    try {
      render(SMS, { code: '1', s: 'x'.repeat(200) }, '+21620000000', 'UTC');
      throw new Error('no throw');
    } catch (e) {
      expect((e as RenderError).code).toBe('content_too_long');
    }
    expect(() => render(SMS, { code: '1', s: 'ب'.repeat(80) }, '+21620000000', 'UTC')).toThrow(RenderError); // UCS-2: 70 per segment
  });
});

describe('retry backoff (SDD §8.3)', () => {
  const o = { baseMs: 1000, ceilingMs: 60_000 };
  it('base x 2^(n-1), jitter +-20 %, capped by the ceiling', () => {
    expect(retryDelayMs(1, { ...o, random: () => 0.5 })).toBe(1000);
    expect(retryDelayMs(2, { ...o, random: () => 0.5 })).toBe(2000);
    expect(retryDelayMs(3, { ...o, random: () => 0 })).toBe(3200);
    expect(retryDelayMs(3, { ...o, random: () => 0.999999 })).toBe(4800);
    expect(retryDelayMs(20, { ...o, random: () => 0.999999 })).toBe(60_000);
    for (let i = 0; i < 1000; i++) {
      const d = retryDelayMs(4, o);
      expect(d).toBeGreaterThanOrEqual(6400);
      expect(d).toBeLessThanOrEqual(9600);
    }
  });
  it('honours a Retry-After hint, never above the ceiling', () => {
    expect(retryDelayMs(1, { ...o, retryAfterMs: 5000, random: () => 0.5 })).toBe(5000);
    expect(retryDelayMs(1, { ...o, retryAfterMs: 10, random: () => 0.5 })).toBe(1000);
    expect(retryDelayMs(1, { ...o, retryAfterMs: 999_999, random: () => 0.5 })).toBe(60_000);
  });
});

describe('the test provider (SDD §8.4)', () => {
  const send = (channel: 'EMAIL' | 'SMS', destination: string) => new TestProvider(channel).send({ channel, destination, text: 't' }, { reference: 'd', attemptId: 'a1', idempotencyKey: 'k', signal: new AbortController().signal });
  it('the scenario is chosen by the destination only', async () => {
    expect(await send('EMAIL', 'user@example.test')).toEqual({ kind: 'accepted', providerMessageId: 'test-a1' });
    expect(await send('EMAIL', 'user+retry@example.test')).toMatchObject({ kind: 'rejected', failureClass: 'retryable', code: 'test_unavailable' });
    expect(await send('EMAIL', 'user+429@example.test')).toMatchObject({ kind: 'rejected', failureClass: 'retryable', retryAfterMs: 2000 });
    expect(await send('EMAIL', 'user+reject@example.test')).toMatchObject({ kind: 'rejected', failureClass: 'terminal', code: 'test_rejected' });
    expect(await send('EMAIL', 'user+ambiguous@example.test')).toEqual({ kind: 'ambiguous', code: 'test_ambiguous' });
    expect(await send('EMAIL', 'x@retry+domain.test')).toMatchObject({ kind: 'accepted' }); // the local part only
    expect(await send('SMS', '+21620000001')).toMatchObject({ failureClass: 'retryable' });
    expect(await send('SMS', '+21620000002')).toMatchObject({ failureClass: 'terminal' });
    expect(await send('SMS', '+21620000003')).toMatchObject({ kind: 'ambiguous' });
    expect(await send('SMS', '+21620000429')).toMatchObject({ retryAfterMs: 2000 });
    expect(await send('SMS', '+21620000009')).toMatchObject({ kind: 'accepted' });
  });
  it('hang never resolves (the engine bounds it)', async () => {
    const r = await Promise.race([send('SMS', '+21620000004'), new Promise((resolve) => setTimeout(() => resolve('pending'), 50))]);
    expect(r).toBe('pending');
  });
});

describe('bounded provider codes', () => {
  it('keeps a bounded code, replaces anything else by the fallback (never provider text)', () => {
    expect(boundedCode('test_rejected', 'f')).toBe('test_rejected');
    for (const bad of ['Invalid number +216...', '', 'A', '1abc', 'x'.repeat(65), undefined, 42, { a: 1 }]) expect(boundedCode(bad, 'fallback')).toBe('fallback');
  });
});

describe('destination limiter identity (D21)', () => {
  const key = randomBytes(32);
  it('an HMAC under the dedicated key with domain separation: deterministic, per channel and exact destination, never a plain hash', () => {
    const id = destinationIdentity(key, 'SMS', '+21698000001');
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(destinationIdentity(key, 'SMS', '+21698000001')).toBe(id);
    expect(destinationIdentity(randomBytes(32), 'SMS', '+21698000001')).not.toBe(id);
    expect(destinationIdentity(key, 'EMAIL', '+21698000001')).not.toBe(id);
    for (const [a, b] of [['a.b@x.test', 'ab@x.test'], ['a@x.test', 'A@x.test'], ['a@x.test', 'a+t@x.test']]) {
      expect(destinationIdentity(key, 'EMAIL', a)).not.toBe(destinationIdentity(key, 'EMAIL', b));
    }
    for (const plain of ['+21698000001', 'SMS|+21698000001', 'nawara.notification.destination-limit.v1|SMS|+21698000001']) {
      expect(createHash('sha256').update(plain).digest('hex')).not.toBe(id);
    }
  });
});
