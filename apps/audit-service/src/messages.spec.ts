import { catalogProblems } from '@nawara/service-kit';
import { describe, expect, it } from 'vitest';
import { AUDIT_MESSAGES } from './messages.js';

/** ADR-0054 D6 / D13 (Core V1 refactor R6.1): Audit's catalog is complete in en / fr / ar and its English is the pre-R6.1 text. */
describe('AUDIT_MESSAGES', () => {
  it('is complete: every message has non-empty en, fr and ar text with identical placeholders', () => {
    expect(catalogProblems(AUDIT_MESSAGES)).toEqual([]);
  });

  it('keeps every English text exactly as Audit returned it before R6.1 (templates with their {placeholders})', () => {
    const before: Record<keyof typeof AUDIT_MESSAGES, string> = {
      accountabilityUnavailable: 'The query could not be recorded; no evidence is returned.',
      authorizationUnverified: 'Authorization could not be verified; no evidence is returned.',
      tooManyRequests: 'Too many requests.',
      operationNotAllowed: 'Operation not allowed for this caller.',
      ownerOnly: 'Only a Company owner may read audit evidence here.',
      categoryNotAllowed: 'This caller may not read that category.',
      sourceNotAllowed: 'This caller may not read that source service.',
      unexpectedBody: 'A read takes no request body.',
      invalidInstant: '{name} must be a UTC instant like 2026-01-31T00:00:00Z',
      notRealInstant: '{name} is not a real instant',
      pairTogether: '{typeKey} and {idKey} go together',
      pairInvalid: '{typeKey} / {idKey} is not valid',
      invalidQueryString: 'invalid query string',
      unknownParameter: 'unknown query parameter',
      givenOnce: '{name} must be given once',
      emptyOrTooLong: '{name} is empty or too long',
      fromToRequired: 'from and to are required',
      toAfterFrom: 'to must be after from',
      windowTooLarge: 'the time window may not exceed {days} days',
      limitRange: 'limit must be an integer from 1 to {max}',
      actionNotCataloged: 'action is not a cataloged action',
      categoryInvalid: 'category is not valid',
      outcomeInvalid: 'outcome is not valid',
      sourceNotCataloged: 'sourceService is not a cataloged producer',
      correlationInvalid: 'correlationId is not valid',
      organizationPlatformExclusive: 'organizationId and platform are exclusive',
      platformMustBeTrue: 'platform must be true when present',
      organizationIdInvalid: 'organizationId is not valid',
      cursorInvalid: 'cursor is not valid for this query',
    };
    expect(Object.keys(AUDIT_MESSAGES).sort()).toEqual(Object.keys(before).sort());
    for (const [id, en] of Object.entries(before)) expect(AUDIT_MESSAGES[id as keyof typeof AUDIT_MESSAGES].en).toBe(en);
  });

  it('holds real French and real UTF-8 Arabic', () => {
    for (const texts of Object.values(AUDIT_MESSAGES)) {
      expect(texts.fr).not.toBe(texts.en);
      expect(texts.ar).toMatch(/[؀-ۿ]/);
    }
  });
});
