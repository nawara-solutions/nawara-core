import { describe, expect, it } from 'vitest';
import { sanitizeMetadata } from './audit.service.js';

describe('audit metadata sanitising', () => {
  it('drops anything that looks like a credential, whatever the value', () => {
    const out = sanitizeMetadata({
      password: 'x', newPassword: 'x', secretKey: 'x', totpCode: '1', code: '1', refreshToken: 't', accessToken: 't', challengeToken: 'c',
      assertion: 'a', credentialId: 'c', codeHash: 'h', authorization: 'Bearer x', otp: '1', proof: 'p', apiKey: 'k',
      purpose: 'platform_assignment.grant', method: 'totp', attempts: 3, first: true,
    });
    expect(out).toEqual({ purpose: 'platform_assignment.grant', method: 'totp', attempts: 3, first: true });
  });
  it('drops non-primitive and oversized values (no payload dumps)', () => {
    expect(sanitizeMetadata({ blob: { a: 1 }, big: 'x'.repeat(500), list: [1] as unknown as string, ok: 'yes' })).toEqual({ ok: 'yes' });
  });
});
