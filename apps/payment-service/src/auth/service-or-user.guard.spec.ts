import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { hashServiceToken, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { describe, expect, it, vi } from 'vitest';
import { ServiceOrUserGuard, type CallerRequest } from './service-or-user.guard.js';

const ctxFor = (req: Partial<CallerRequest>): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;

const identity = (over: Partial<AuthIdentity> = {}): AuthIdentity => ({ id: 'u1', adminTier: null, isActive: true, memberships: [], ...over });

/** Builds an AuthClient double whose `getIdentity` mock is returned separately, so assertions never reference it as an unbound method. */
const authClientWith = (getIdentity = vi.fn()): { authClient: AuthClient; getIdentity: typeof getIdentity } => ({
  authClient: { getIdentity, hasPlatformAccess: vi.fn() },
  getIdentity,
});

describe('ServiceOrUserGuard', () => {
  const serviceToken = 'a-service-token';
  const tokens = [{ caller: 'billing-service', digest: hashServiceToken(serviceToken) }];

  it('authenticates as a SERVICE when the bearer matches a configured service token, and never asks Auth', async () => {
    const { authClient, getIdentity } = authClientWith();
    const guard = new ServiceOrUserGuard(tokens, authClient);
    const req: Partial<CallerRequest> = { headers: { authorization: `Bearer ${serviceToken}` } };
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(req.caller).toEqual({ kind: 'service', service: 'billing-service' });
    expect(getIdentity).not.toHaveBeenCalled();
  });

  it('falls back to asking Auth when the bearer matches no service token, and authenticates as a USER', async () => {
    const id = identity();
    const { authClient, getIdentity } = authClientWith(vi.fn().mockResolvedValue(id));
    const guard = new ServiceOrUserGuard(tokens, authClient);
    const req: Partial<CallerRequest> = { headers: { authorization: 'Bearer some-user-jwt' } };
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(req.caller).toEqual({ kind: 'user', identity: id });
    expect(getIdentity).toHaveBeenCalledWith('some-user-jwt');
  });

  it('rejects when Auth says the token is not a valid identity', async () => {
    const { authClient } = authClientWith(vi.fn().mockResolvedValue(null));
    const guard = new ServiceOrUserGuard(tokens, authClient);
    const req: Partial<CallerRequest> = { headers: { authorization: 'Bearer nope' } };
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an inactive identity', async () => {
    const { authClient } = authClientWith(vi.fn().mockResolvedValue(identity({ isActive: false })));
    const guard = new ServiceOrUserGuard(tokens, authClient);
    const req: Partial<CallerRequest> = { headers: { authorization: 'Bearer inactive-user' } };
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a missing or malformed authorization header without ever calling Auth', async () => {
    const { authClient, getIdentity } = authClientWith();
    const guard = new ServiceOrUserGuard(tokens, authClient);
    for (const headers of [{}, { authorization: 'Bearer' }, { authorization: 'Basic abc' }]) {
      await expect(guard.canActivate(ctxFor({ headers }))).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(getIdentity).not.toHaveBeenCalled();
  });

  it('propagates a fail-closed error from Auth (service unavailable) rather than swallowing it', async () => {
    const boom = new Error('auth unreachable');
    const { authClient } = authClientWith(vi.fn().mockRejectedValue(boom));
    const guard = new ServiceOrUserGuard(tokens, authClient);
    const req: Partial<CallerRequest> = { headers: { authorization: 'Bearer some-user-jwt' } };
    await expect(guard.canActivate(ctxFor(req))).rejects.toBe(boom);
  });
});
