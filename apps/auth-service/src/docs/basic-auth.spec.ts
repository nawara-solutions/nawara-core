import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { basicAuth } from './basic-auth.js';

const run = (authorization?: string) => {
  const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), send: vi.fn() };
  const next = vi.fn();
  basicAuth('docs', 'correct-horse-battery')(
    { headers: { authorization } } as unknown as Request,
    res as unknown as Response,
    next as NextFunction,
  );
  return { res, next };
};
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

describe('basicAuth', () => {
  it('lets the right credentials through', () => {
    expect(run(basic('docs', 'correct-horse-battery')).next).toHaveBeenCalled();
  });

  it('accepts a password containing a colon', () => {
    const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), send: vi.fn() };
    const next = vi.fn();
    basicAuth('docs', 'pass:with:colons-123')(
      { headers: { authorization: basic('docs', 'pass:with:colons-123') } } as unknown as Request,
      res as unknown as Response,
      next as NextFunction,
    );
    expect(next).toHaveBeenCalled();
  });

  it.each([
    ['no header', undefined],
    ['wrong password', basic('docs', 'nope')],
    ['wrong user', basic('admin', 'correct-horse-battery')],
    ['not basic', 'Bearer abc'],
    ['no colon', `Basic ${Buffer.from('docs').toString('base64')}`],
  ])('rejects %s with 401 and a challenge', (_n, header) => {
    const { res, next } = run(header);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.setHeader).toHaveBeenCalledWith('WWW-Authenticate', expect.stringContaining('Basic'));
  });
});
