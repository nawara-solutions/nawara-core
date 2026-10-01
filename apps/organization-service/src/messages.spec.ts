import { catalogProblems } from '@nawara/service-kit';
import { describe, expect, it } from 'vitest';
import { ORGANIZATION_MESSAGES } from './messages.js';

/** ADR-0054 D6 / D13 (Core V1 refactor R6.2): Organization's catalog is complete in en / fr / ar and its English is the pre-R6.2 text. */
describe('ORGANIZATION_MESSAGES', () => {
  it('is complete: every message has non-empty en, fr and ar text with identical placeholders', () => {
    expect(catalogProblems(ORGANIZATION_MESSAGES)).toEqual([]);
  });

  it('keeps every English text exactly as Organization returned it before R6.2 (templates with their {placeholders})', () => {
    const before: Record<keyof typeof ORGANIZATION_MESSAGES, string> = {
      notFound: 'Not found.',
      forbidden: 'Forbidden.',
      stepUpRequired: 'A fresh step-up is required for this operation.',
      notAuthorizedCreatePlatform: 'Not authorized to create a platform for this company.',
      notAuthorizedUpdatePlatform: 'Not authorized to update this platform.',
      notAuthorizedCreateOrganization: 'Not authorized to create an organization on this platform.',
      notAuthorizedUpdateOrganization: 'Not authorized to update this organization.',
      ownershipNotInitialised: 'The ownership state is not initialised.',
      notAuthoritativeReads: 'organization-service is not authoritative yet (phase {phase}).',
      notAuthoritativeWrites: 'organization-service is not authoritative yet (phase {phase}): hierarchy writes are refused.',
      idempotencyKeyRequired: 'A valid Idempotency-Key header (8 to 128 characters of A-Z a-z 0-9 . _ : -) is required.',
      idempotencyKeyReused: 'This Idempotency-Key was already used with a different request.',
      noSuchPlatform: 'No such platform.',
      noSuchCompany: 'No such company.',
      cursorInvalid: 'cursor is not valid',
      limitRange: 'limit must be an integer from 1 to {max}',
      givenOnce: '{name} must be given once',
      mustBeUuid: '{name} must be a uuid',
      bodyMustBeObject: 'the request body must be a JSON object',
      cannotBeChanged: '{name} cannot be changed',
      unknownField: 'unknown field: {name}',
      textLength: '{name} must be 1 to {max} characters',
      atLeastOneField: 'at least one field must be provided',
    };
    expect(Object.keys(ORGANIZATION_MESSAGES).sort()).toEqual(Object.keys(before).sort());
    for (const [id, en] of Object.entries(before)) expect(ORGANIZATION_MESSAGES[id as keyof typeof ORGANIZATION_MESSAGES].en).toBe(en);
  });

  it('holds real French and real UTF-8 Arabic', () => {
    for (const texts of Object.values(ORGANIZATION_MESSAGES)) {
      expect(texts.fr).not.toBe(texts.en);
      expect(texts.ar).toMatch(/[؀-ۿ]/);
    }
  });
});
