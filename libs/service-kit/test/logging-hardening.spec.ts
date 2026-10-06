import { describe, expect, it } from 'vitest';
import { EVENT_NAME, INVALID_TOKEN, JsonLogger, LOG_ENVELOPE_FIELDS, MAX_RECORD_LENGTH, SAFE_ID, getRequestContext, isSensitiveKey, runWithEventContext, runWithRequestContext, safeSerialize, safeToken, scrubText } from '../src/index.js';

/**
 * V2 A12.4.2: the negative controls of the shared logging boundary. Each one is deterministic (state, not timing). A secret is a marker
 * the test can look for in the WHOLE emitted text, so a leak through any field, key or placeholder is caught.
 */
type Line = Record<string, any>;
const capture = (level: 'debug' | 'info' | 'warn' | 'error' = 'debug') => {
  const raw: string[] = [];
  const logger = new JsonLogger('kit-test', level, (l) => raw.push(l));
  return { raw, logger, lines: (): Line[] => raw.map((l) => JSON.parse(l) as Line), text: () => raw.join('\n') };
};
const SECRET = 'S3CR3T-MARKER-7f1e';
const PII = 'pii.marker@example.org';

describe('category A: secrets are redacted by key (1-7)', () => {
  it('1-2. nested objects and arrays', () => {
    const c = capture();
    c.logger.info('x', { a: { b: { password: SECRET } }, list: [{ refreshToken: SECRET }, { ok: 1 }], deep: [[{ apiKey: SECRET }]] });
    expect(c.text()).not.toContain(SECRET);
    expect(c.lines()[0].list[1]).toEqual({ ok: 1 });
  });

  it('3. normalized keys: case and separators', () => {
    for (const key of ['Authorization', 'set-cookie', 'Set_Cookie', 'x-api-key', 'X_API_KEY', 'Access-Token', 'accesstoken', 'PRIVATE_KEY', 'connection-string', 'sessionId', 'session_id', 'webauthnChallenge', 'stepUpToken', 'secretKey', 'passwd', 'totp', 'otp_secret', 'DSN', 'jwt', 'credentialId', 'pepper', 'signature']) {
      expect(isSensitiveKey(key), key).toBe(true);
      const c = capture();
      c.logger.info('x', { [key]: SECRET });
      expect(c.text(), key).not.toContain(SECRET);
    }
  });

  it('4-7. bare `code` and secret *Code names stay redacted (W2); unknown *Code fails closed', () => {
    for (const key of ['code', 'Code', 'joinCode', 'invitationCode', 'totpCode', 'verificationCode', 'recoveryCode', 'resetCode', 'smsCode', 'rawCode']) {
      expect(isSensitiveKey(key), key).toBe(true);
      const c = capture();
      c.logger.info('x', { [key]: SECRET });
      expect(c.text(), key).not.toContain(SECRET);
    }
  });
});

describe('the operational-code allowlist corrects the old over-redaction (8-10)', () => {
  it('8-10. statusCode, errorCode, providerCode and the other approved names stay visible; challengeId too', () => {
    const fields = { statusCode: 503, errorCode: '57014', providerCode: 'rate_limited', failureCode: 'f', reasonCode: 'r', exitCode: 1, taxCode: 'VAT', productCode: 'p', currencyCode: 'TND', countryCode: 'TN', challengeId: 'ch-1' };
    const c = capture();
    c.logger.info('x', fields);
    expect(c.lines()[0]).toMatchObject(fields);
    for (const k of Object.keys(fields)) expect(isSensitiveKey(k), k).toBe(false);
    for (const k of ['notPublished', 'footprint', 'status', 'outcome', 'eventId', 'durationMs', 'kind', 'name', 'operation']) expect(isSensitiveKey(k), k).toBe(false);
  });
});

describe('category B: direct PII is redacted by key (11)', () => {
  it('11. email, phone, ip, user agent, address, recipient, destination, contact, names', () => {
    for (const key of ['email', 'emailAddress', 'phone', 'phoneNumber', 'msisdn', 'ip', 'clientIp', 'ipAddress', 'clientAddress', 'remoteAddress', 'userAgent', 'user-agent', 'address', 'recipient', 'destination', 'inviteeContact', 'fullName', 'firstName', 'last_name', 'displayName']) {
      expect(isSensitiveKey(key), key).toBe(true);
      const c = capture();
      c.logger.info('x', { [key]: PII });
      expect(c.text(), key).not.toContain(PII);
    }
  });
});

describe('free-text scrubbing in msg and string fields (12-17)', () => {
  const cases: Array<[string, string]> = [
    ['12. Bearer', `call failed: Authorization: Bearer ${SECRET}.x-y`],
    ['13. Basic', `Authorization: Basic ${SECRET}==`],
    ['12b. quoted Bearer', `Authorization: Bearer "${SECRET}"`],
    ['15b. secret key=value in free text', `retry with password=${SECRET} token="${SECRET}" api_key=${SECRET}`],
    ['14. URL credentials', `connect postgres://svc:${SECRET}@db:5432/x failed`],
    ['15. secret query value', `GET https://h/x?a=1&access_token=${SECRET}&b=2`],
    ['15. secret query value (code)', `GET /cb?state=s&code=${SECRET}`],
    ['15. secret query value (X-Amz-Signature)', `https://bucket/o?X-Amz-Credential=${SECRET}&X-Amz-Signature=${SECRET}`],
    ['16. bare JWT', `token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIke1NFQ1JFVH0ifQ.${SECRET}`],
    ['17. file ticket path', `https://files.example/file/t/${SECRET}?x=1`],
  ];
  for (const [name, text] of cases) {
    it(name, () => {
      const c = capture();
      c.logger.info(text, { detail: text, nested: [text] });
      expect(c.text()).not.toContain(SECRET);
    });
  }

  it('operational code= and key= words in free text are kept', () => {
    expect(scrubText('notification_delivery_failed code=retries_exhausted key=value')).toBe('notification_delivery_failed code=retries_exhausted key=value');
  });

  it('keeps the useful, non-secret structure of a URL', () => {
    expect(scrubText('GET https://h.example/x?a=1&token=t0k&b=2')).toBe('GET https://h.example/x?a=1&token=[redacted]&b=2');
    expect(scrubText('postgres://svc:pw@db:5432/x')).toBe('postgres://svc:[redacted]@db:5432/x');
    expect(scrubText('/file/t/abc?x=1')).toBe('/file/t/[redacted]?x=1');
  });
});

describe('hostile and special values never throw (18-30)', () => {
  it('18. a throwing getter is not invoked', () => {
    let calls = 0;
    const o = Object.defineProperty({ ok: 1 }, 'bad', { enumerable: true, get: () => { calls++; throw new Error(SECRET); } });
    const c = capture();
    expect(() => c.logger.info('x', { o })).not.toThrow();
    expect(calls).toBe(0);
    expect(c.lines()[0].o).toEqual({ ok: 1, bad: '[accessor]' });
  });

  it('18c. a Symbol.toStringTag or Symbol.toPrimitive getter is never invoked', () => {
    let calls = 0;
    const o = { a: 1 };
    Object.defineProperty(o, Symbol.toStringTag, { get: () => { calls++; return 'Date'; } });
    Object.defineProperty(o, Symbol.toPrimitive, { get: () => { calls++; return () => SECRET; } });
    const c = capture();
    c.logger.info('x', { o });
    expect(calls).toBe(0);
    expect(c.lines()[0].o).toEqual({ a: 1 });
  });

  it('18b. toJSON and inspection hooks are never called', () => {
    let calls = 0;
    const o = { a: 1, toJSON: () => { calls++; return SECRET; } };
    const c = capture();
    c.logger.info('x', { o });
    expect(calls).toBe(0);
    expect(c.text()).not.toContain(SECRET);
  });

  it('19. a Proxy whose traps throw', () => {
    const trap = () => { throw new Error(SECRET); };
    const p = new Proxy({}, { ownKeys: trap, getOwnPropertyDescriptor: trap, get: trap, getPrototypeOf: trap });
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    const c = capture();
    expect(() => c.logger.info('x', { p, revoked, list: [p] })).not.toThrow();
    expect(c.lines()[0]).toMatchObject({ p: '[unserializable]', revoked: '[unserializable]', list: ['[unserializable]'] });
    expect(c.text()).not.toContain(SECRET);
  });

  it('20. BigInt, bounded', () => {
    const c = capture();
    c.logger.info('x', { n: 12345678901234567890n, huge: 10n ** 200n });
    expect(c.lines()[0].n).toBe('12345678901234567890n');
    expect(c.lines()[0].huge.length).toBeLessThanOrEqual(64);
  });

  it('21. circular references', () => {
    const a: any = { name: 'a' };
    a.self = a;
    a.list = [a];
    const c = capture();
    c.logger.info('x', { a });
    expect(c.lines()[0].a).toEqual({ name: 'a', self: '[circular]', list: ['[circular]'] });
  });

  it('21b. a value shared twice (not a cycle) is serialized both times', () => {
    const shared = { v: 1 };
    expect(safeSerialize({ x: shared, y: shared })).toEqual({ x: { v: 1 }, y: { v: 1 } });
  });

  it('22. depth bound (6)', () => {
    let deep: any = { leaf: true };
    for (let i = 0; i < 20; i++) deep = { d: deep };
    const s = JSON.stringify(safeSerialize(deep));
    expect(s).toContain('[truncated]');
    expect(s).not.toContain('leaf');
  });

  it('23. array bound (50)', () => {
    const out = safeSerialize(Array.from({ length: 1000 }, (_, i) => i)) as unknown[];
    expect(out).toHaveLength(51);
    expect(out[50]).toBe('[+950 items]');
    const sparse: unknown[] = [];
    sparse.length = 4_000_000_000;
    expect((safeSerialize(sparse) as unknown[]).length).toBe(51);
  });

  it('24. object-key bound (50)', () => {
    const o = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    const out = safeSerialize(o) as Record<string, unknown>;
    expect(Object.keys(out)).toHaveLength(51);
    expect(out['[+keys]']).toBe(450);
  });

  it('25. record bound (16 KiB): envelope and msg stay, fields are replaced', () => {
    const c = capture();
    const big = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, 'x'.repeat(2000)]));
    runWithRequestContext({ requestId: 'req-12345678', correlationId: 'corr-12345678' }, () => c.logger.warn('big_record', big));
    expect(c.raw[0].length).toBeLessThanOrEqual(MAX_RECORD_LENGTH);
    expect(c.lines()[0]).toMatchObject({ level: 'warn', service: 'kit-test', msg: 'big_record', requestId: 'req-12345678', fieldsTruncated: true });
    expect(c.lines()[0].f0).toBeUndefined();
  });

  it('26-27. Buffer, typed arrays and ArrayBuffer are metadata only', () => {
    const c = capture();
    c.logger.info('x', { b: Buffer.from(SECRET), u: new Uint16Array(4), ab: new ArrayBuffer(7), dv: new DataView(new ArrayBuffer(3)) });
    expect(c.lines()[0]).toMatchObject({ b: `[binary ${SECRET.length} bytes]`, u: '[binary 8 bytes]', ab: '[binary 7 bytes]', dv: '[binary 3 bytes]' });
    expect(c.text()).not.toContain(SECRET);
  });

  it('28. valid and invalid Date', () => {
    expect(safeSerialize({ d: new Date('2026-10-06T10:00:00Z'), bad: new Date('nope') })).toEqual({ d: '2026-10-06T10:00:00.000Z', bad: '[invalid date]' });
  });

  it('29-30. Map and Set are placeholders, never their contents', () => {
    const c = capture();
    c.logger.info('x', { m: new Map([['password', SECRET]]), s: new Set([SECRET, PII]) });
    expect(c.lines()[0]).toMatchObject({ m: '[Map 1]', s: '[Set 2]' });
    expect(c.text()).not.toContain(SECRET);
  });

  it('symbols, functions, undefined, NaN and Infinity', () => {
    expect(safeSerialize({ s: Symbol('x'), f: () => 1, u: undefined, n: NaN, i: Infinity, list: [undefined] })).toEqual({ s: '[symbol]', f: '[function]', n: null, i: null, list: [null] });
  });

  it('a __proto__ key is data, not a prototype change', () => {
    const out = safeSerialize(JSON.parse('{"__proto__":{"polluted":true},"a":1}')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(({} as any).polluted).toBeUndefined();
    expect(out.a).toBe(1);
  });

  it('a secret in a KEY name is scrubbed too', () => {
    const c = capture();
    c.logger.info('x', { [`Bearer ${SECRET}`]: 1 });
    expect(c.text()).not.toContain(SECRET);
  });
});

describe('errors and stacks (31-34)', () => {
  it('31. an Error field is its facts: type, code, kind; never message, cause or stack', () => {
    const e = Object.assign(new Error(`connect failed for ${PII} with ${SECRET}`, { cause: new Error(SECRET) }), { code: 'ECONNREFUSED' });
    const pg = Object.assign(new (class DatabaseError extends Error {})(`duplicate key value (email)=(${PII})`), { code: '23505', detail: PII });
    const c = capture();
    c.logger.warn('x', { err: e, pg });
    expect(c.lines()[0].err).toEqual({ errorType: 'Error', errorCode: 'ECONNREFUSED', errorKind: 'network_unreachable' });
    expect(c.lines()[0].pg).toEqual({ errorType: 'DatabaseError', errorCode: '23505' });
    expect(c.text()).not.toContain(SECRET);
    expect(c.text()).not.toContain(PII);
  });

  it('31b. an Error whose properties are getters is classified without running them', () => {
    let calls = 0;
    const e = new Error('m');
    Object.defineProperty(e, 'code', { get: () => { calls++; return SECRET; } });
    Object.defineProperty(e, 'message', { get: () => { calls++; return SECRET; } });
    expect(safeSerialize(e)).toEqual({ errorType: 'Error' });
    expect(calls).toBe(0);
  });

  it('32-34. frames only, never the message, at most 20 frames', () => {
    const header = `Error: login failed for ${PII}\n    with ${SECRET} on a second line`;
    const frames = Array.from({ length: 40 }, (_, i) => `    at fn${i} (/app/dist/x.js:${i}:1)`).join('\n');
    const c = capture();
    c.logger.error('request failed', `${header}\n${frames}\n  [cause]: Error: ${SECRET}`, 'Ctx');
    const stack: string = c.lines()[0].stack;
    expect(stack.split('\n')).toHaveLength(20);
    expect(stack.split('\n')[0]).toBe('at fn0 (/app/dist/x.js:0:1)');
    expect(c.text()).not.toContain(SECRET);
    expect(c.text()).not.toContain(PII);
  });

  it('a stack with no frames is omitted', () => {
    const c = capture();
    c.logger.error('x', `Error: ${SECRET}`, 'Ctx');
    expect(c.lines()[0].stack).toBeUndefined();
    expect(c.text()).not.toContain(SECRET);
  });
});

describe('the envelope is the logger’s (35-36)', () => {
  it('35. caller fields cannot overwrite ts, level, service, msg, context, requestId, correlationId or stack', () => {
    const c = capture();
    const forged = Object.fromEntries(LOG_ENVELOPE_FIELDS.map((k) => [k, `forged-${k}`]));
    runWithRequestContext({ requestId: 'req-12345678', correlationId: 'corr-12345678' }, () => c.logger.warn('real', forged));
    const line = c.lines()[0];
    expect(line).toMatchObject({ level: 'warn', service: 'kit-test', msg: 'real', requestId: 'req-12345678', correlationId: 'corr-12345678' });
    expect(line.ts).not.toBe('forged-ts');
    expect(line.context).toBeUndefined();
    expect(line.stack).toBeUndefined();
    expect(line.fieldsTruncated).toBeUndefined();
    expect(c.text()).not.toContain('forged-');
  });

  it('35b. case and separator variants of envelope names are dropped too', () => {
    const c = capture();
    c.logger.info('x', { Level: 'error', SERVICE: 'forged', request_id: 'forged', Dropped_Fields: 'forged' });
    expect(c.lines()[0].droppedFields).toEqual(['Level', 'SERVICE', 'request_id', 'Dropped_Fields']);
    expect(c.text()).not.toContain('forged');
  });

  it('36. droppedFields lists the dropped NAMES only, and cannot be spoofed', () => {
    const c = capture();
    c.logger.info('x', { level: 'error', droppedFields: ['nothing'], ok: 1 });
    expect(c.lines()[0].droppedFields).toEqual(['level', 'droppedFields']);
    expect(c.lines()[0]).toMatchObject({ level: 'info', ok: 1 });
  });
});

describe('injection, size and total failure (37-41)', () => {
  it('37. CR, LF and control characters cannot forge a line or break the JSON', () => {
    const c = capture();
    c.logger.info('a\r\n{"level":"error","msg":"forged"}\u001b[31m\u0000', { f: 'x\ny' });
    expect(c.raw).toHaveLength(1);
    // eslint-disable-next-line no-control-regex -- intentional: the raw line must hold none of these characters
    expect(c.raw[0]).not.toMatch(/[\r\n\u0000\u001b]/);
    expect(c.lines()[0].level).toBe('info');
  });

  it('38. huge strings are bounded (msg and fields)', () => {
    const c = capture();
    c.logger.info('m'.repeat(1_000_000), { f: 'f'.repeat(1_000_000) });
    expect(c.lines()[0].msg.length).toBe(2000);
    expect(c.lines()[0].f.length).toBe(2000);
  });

  it('39. a record that cannot be built becomes a minimal line; the caller is unaffected', () => {
    const c = capture();
    const message = { toString: () => { throw new Error('x'); } };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => c.logger.info(revoked.proxy as never, revoked.proxy as never)).not.toThrow();
    expect(() => c.logger.error(message, revoked.proxy, 'Ctx')).not.toThrow();
    expect(c.lines().every((l) => l.service === 'kit-test')).toBe(true);
  });

  it('39b. when JSON.stringify itself fails, the fallback line is written', () => {
    const c = capture();
    const original = JSON.stringify;
    let first = true;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      if (first) {
        first = false;
        throw new Error('stringify failed');
      }
      return original(...args);
    }) as typeof JSON.stringify;
    try {
      expect(() => c.logger.warn('x', { a: 1 })).not.toThrow();
    } finally {
      JSON.stringify = original;
    }
    expect(c.lines()[0]).toMatchObject({ level: 'warn', service: 'kit-test', msg: 'log_record_unserializable' });
  });

  it('40. a failing sink never reaches the caller', () => {
    const logger = new JsonLogger('kit-test', 'debug', () => {
      throw new Error('stdout closed');
    });
    for (const call of [() => logger.info('x'), () => logger.warn('x', { a: 1 }), () => logger.error('x', 'Error: e\n at y', 'C'), () => logger.debug('x'), () => logger.log('x'), () => logger.verbose('x'), () => logger.fatal('x')]) {
      expect(call).not.toThrow();
    }
  });

  it('41. log levels are unchanged', () => {
    for (const [level, expected] of [['debug', ['debug', 'info', 'warn', 'error']], ['info', ['info', 'warn', 'error']], ['warn', ['warn', 'error']], ['error', ['error']]] as const) {
      const c = capture(level);
      c.logger.debug('d');
      c.logger.info('i');
      c.logger.warn('w');
      c.logger.error('e');
      expect(c.lines().map((l) => l.level), level).toEqual(expected);
    }
  });
});

describe('safeToken and runWithEventContext', () => {
  it('safeToken returns a valid value as is and never echoes a bad one', () => {
    expect(safeToken('corr-12345678', SAFE_ID)).toBe('corr-12345678');
    expect(safeToken('billing.payment_completed', EVENT_NAME)).toBe('billing.payment_completed');
    for (const bad of [`bad\n${SECRET}`, 'x'.repeat(500), '', 42, null, undefined, { toString: () => SECRET }]) {
      expect(safeToken(bad, SAFE_ID)).toBe(INVALID_TOKEN);
    }
    expect(safeToken('corr-12345678', /x/g)).toBe(INVALID_TOKEN);
    const global = /^[a-z]+$/g;
    expect([safeToken('abc', global), safeToken('abc', global)]).toEqual(['abc', 'abc']); // lastIndex is reset
  });

  it('runWithEventContext restores requestId/correlationId from a valid event and never echoes a hostile header', () => {
    const seen: unknown[] = [];
    runWithEventContext({ id: '00000000-0000-4000-8000-000000000001', headers: { correlationId: 'corr-12345678' } }, () => seen.push(getRequestContext()));
    runWithEventContext({ id: '00000000-0000-4000-8000-000000000002', headers: { correlationId: `x\n${SECRET}` } }, () => seen.push(getRequestContext()));
    runWithEventContext({ id: `bad id ${SECRET}` }, () => seen.push(getRequestContext()));
    runWithEventContext(undefined, () => seen.push(getRequestContext()));
    expect(seen).toEqual([
      { requestId: 'event:00000000-0000-4000-8000-000000000001', correlationId: 'corr-12345678' },
      { requestId: 'event:00000000-0000-4000-8000-000000000002', correlationId: 'event:00000000-0000-4000-8000-000000000002' },
      { requestId: 'event:unknown', correlationId: 'event:unknown' },
      { requestId: 'event:unknown', correlationId: 'event:unknown' },
    ]);
    expect(JSON.stringify(seen)).not.toContain(SECRET);
  });
});

describe('V2 A12.4.3: Nest Logger forwarding', () => {
  it('a Nest Logger call (msg, fields, contextName) keeps both the fields and the context', () => {
    const c = capture();
    c.logger.warn('evt', { eventId: 'e-12345678', outcome: 'rejected' }, 'EventIntake');
    c.logger.log('evt2', 'EventIntake');
    c.logger.error('evt3', { eventId: 'e-12345678' }, 'EventIntake');
    expect(c.lines()[0]).toMatchObject({ level: 'warn', msg: 'evt', context: 'EventIntake', eventId: 'e-12345678', outcome: 'rejected' });
    expect(c.lines()[1]).toMatchObject({ level: 'info', msg: 'evt2', context: 'EventIntake' });
    expect(c.lines()[2]).toMatchObject({ level: 'error', msg: 'evt3', context: 'EventIntake', eventId: 'e-12345678' });
    expect(c.lines()[2].stack).toBeUndefined();
  });
});
