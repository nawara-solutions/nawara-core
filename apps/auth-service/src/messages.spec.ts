import { catalogProblems } from '@nawara/service-kit';
import { describe, expect, it } from 'vitest';
import { AUTH_MESSAGES } from './messages.js';

/** ADR-0054 D6 / D13 (Core V1 refactor R5): Auth's catalog is complete in en / fr / ar and its English is the pre-R5 text, byte for byte. */
describe('AUTH_MESSAGES', () => {
  it('is complete: every message has non-empty en, fr and ar text with identical placeholders', () => {
    expect(catalogProblems(AUTH_MESSAGES)).toEqual([]);
  });

  it('keeps every English text exactly as Auth returned it before R5 (templates with their {placeholders})', () => {
    // the literal messages of the 68 pre-R5 `authError` sites and the session-ceiling 401 (inventory of R5)
    const before: Record<keyof typeof AUTH_MESSAGES, string> = {
      provideEmailOrPhone: 'Provide an email or a phone number.',
      exactlyOneEmailOrPhone: 'Provide exactly one of email or phone.',
      invalidPhone: 'Invalid phone number.',
      passwordLength: 'Password must be {min}-{max} bytes long.', // was `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_BYTES} bytes long.`
      expiresInMinutesRange: 'expiresInMinutes must be between {min} and {max}.',
      registrationRefused: 'Registration is not available with this code. Please contact your organization.',
      membershipExists: 'You already have a membership in this organization.',
      invalidCredentials: 'Invalid credentials.',
      invalidRefreshToken: 'Invalid refresh token.',
      invalidToken: 'Invalid or expired token.',
      sessionEnded: 'Session has ended.',
      sessionCeiling: 'Your session has ended. Please request a new login code to continue.',
      hierarchyUnavailable: 'The organization hierarchy could not be verified; nothing was changed. Retry later.',
      requestAlreadyDecided: 'This request has already been decided.',
      contactNotVerified: 'The applicant has not verified their contact yet.',
      onlyActiveRevocable: 'Only an active membership can be revoked.',
      invalidOrExpiredCode: 'Invalid or expired code.',
      invalidInvitation: 'Invalid or expired invitation.',
      invitationNotAcceptable: 'This invitation cannot be accepted.',
      tryAgain: 'Please try again.',
      verificationFailed: 'Verification failed.',
      credentialAlreadyRegistered: 'Credential already registered.',
      noPasskey: 'No passkey registered.',
      onlyFactor: 'You cannot remove your only authentication factor.',
      recoveryFailed: 'Recovery failed.',
      recoveryNotAvailableUntil: 'Recovery is not available until {availableAt}.',
      unsupportedStepUp: 'Unsupported step-up.',
      stepUpRequired: 'A valid step-up verification is required for this action.',
      assignmentConflict: 'An active assignment already exists.',
      tooManyAttempts: 'Too many attempts. Please try again later.',
      accountExists: 'An account with these details already exists.',
    };
    expect(Object.keys(AUTH_MESSAGES).sort()).toEqual(Object.keys(before).sort());
    for (const [id, en] of Object.entries(before)) expect(AUTH_MESSAGES[id as keyof typeof AUTH_MESSAGES].en).toBe(en);
  });

  it('holds real French and real UTF-8 Arabic', () => {
    for (const texts of Object.values(AUTH_MESSAGES)) {
      expect(texts.fr).not.toBe(texts.en);
      expect(texts.ar).toMatch(/[؀-ۿ]/);
    }
  });
});
