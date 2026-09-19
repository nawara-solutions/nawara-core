import { describe, expect, it } from 'vitest';
import { JsonLogger, redact, redactString, runWithRequestContext } from '../src/index.js';

const capture = (level: 'debug' | 'info' | 'warn' | 'error' = 'info') => {
  const lines: Record<string, any>[] = [];
  return { lines, logger: new JsonLogger('payment-service', level, (l) => lines.push(JSON.parse(l))) };
};

describe('redaction', () => {
  it('removes credential-shaped keys at any depth and never throws on cycles or huge input', () => {
    const cyc: any = { a: 1 };
    cyc.self = cyc;
    const out = redact({ user: 'u', password: 'p', nested: { apiKey: 'k', Authorization: 'Bearer abc.def', list: [{ token: 't', ok: 1 }] }, cyc }) as any;
    expect(out.user).toBe('u');
    expect(out.password).toBe('[redacted]');
    expect(out.nested.apiKey).toBe('[redacted]');
    expect(out.nested.Authorization).toBe('[redacted]');
    expect(out.nested.list[0]).toEqual({ token: '[redacted]', ok: 1 });
    expect(JSON.stringify(out)).not.toContain('abc.def');
  });

  it('scrubs bearer tokens and connection-string passwords from free text', () => {
    expect(redactString('call failed with Bearer eyJhbGciOi.payload.sig')).toBe('call failed with Bearer [redacted]');
    expect(redactString('connect postgres://svc:hunter2@db:5432/x failed')).not.toContain('hunter2');
    expect(redactString('x'.repeat(5000)).length).toBeLessThanOrEqual(2000);
  });
});

describe('JsonLogger', () => {
  it('writes one JSON line with service, level and message', () => {
    const { lines, logger } = capture();
    logger.info('started', { port: 3000 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', service: 'payment-service', msg: 'started', port: 3000 });
    expect(typeof lines[0].ts).toBe('string');
  });

  it('adds requestId and correlationId inside a request context, and omits them outside', () => {
    const { lines, logger } = capture();
    logger.info('outside');
    runWithRequestContext({ requestId: 'req-12345678', correlationId: 'corr-12345678' }, () => logger.info('inside'));
    expect(lines[0].requestId).toBeUndefined();
    expect(lines[1]).toMatchObject({ requestId: 'req-12345678', correlationId: 'corr-12345678' });
  });

  it('filters by level', () => {
    const { lines, logger } = capture('warn');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('never writes secrets, from fields or from messages', () => {
    const { lines, logger } = capture();
    logger.info('login with Bearer abc123token', { password: 'hunter2', headers: { authorization: 'Bearer zzz' } });
    const text = JSON.stringify(lines);
    for (const s of ['abc123token', 'hunter2', 'zzz']) expect(text).not.toContain(s);
  });

  it("maps Nest's error(message, stack, context) to a structured line", () => {
    const { lines, logger } = capture();
    logger.error('boom', 'Error: boom\n at x', 'AppService');
    expect(lines[0]).toMatchObject({ level: 'error', msg: 'boom', context: 'AppService' });
    expect(lines[0].stack).toContain('Error: boom');
  });
});
