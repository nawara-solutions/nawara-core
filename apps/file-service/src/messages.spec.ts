import { catalogProblems } from '@nawara/service-kit';
import { describe, expect, it } from 'vitest';
import { FILE_MESSAGES } from './messages.js';

/** ADR-0054 D6 / D13 (Core V1 refactor R6.4): File's catalog is complete in en / fr / ar and its English is the pre-R6.4 text. */
describe('FILE_MESSAGES', () => {
  it('is complete: every message has non-empty en, fr and ar text with identical placeholders', () => {
    expect(catalogProblems(FILE_MESSAGES)).toEqual([]);
  });

  it('keeps every English text exactly as File returned it before R6.4', () => {
    const before: Record<keyof typeof FILE_MESSAGES, string> = {
      contentLengthRequired: 'Content-Length is required.',
      contentLengthInvalid: 'Content-Length is invalid.',
      organizationIdMustBeUuid: 'X-Organization-Id must be a UUID.',
      idempotencyKeyRequired: 'Idempotency-Key is required (1-255 printable characters).',
      contentDigestInvalid: 'Content-Digest is invalid.',
      contentDigestSha256Invalid: 'Content-Digest sha-256 is invalid.',
      attachMustBeBoolean: 'X-Attach must be true or false.',
      fileNameEncoding: 'X-File-Name must be percent-encoded UTF-8.',
      contentTypeInvalid: 'Content-Type is invalid.',
      fileTooLarge: 'The file exceeds the size allowed for this upload.',
      typeNotAccepted: 'The file type is not accepted.',
      typeOrNameMismatch: 'The declared type or file name does not match the content.',
      digestMismatch: 'The content does not match the declared digest.',
      uploadInterrupted: 'The upload was interrupted.',
      uploadStalled: 'The upload stalled.',
      uploadEndedEarly: 'The upload ended before its declared length.',
      storageUnavailable: 'File storage is temporarily unavailable.',
      couldNotStore: 'The file could not be stored.',
      maxBytesExceedsLimit: "maxBytes exceeds this caller's limit.",
      mediaTypeNotAllowed: 'A media type is not allowed for this caller.',
      uploadInProgress: 'This upload is already in progress.',
      uploadBeingRetried: 'This upload is being retried; try again.',
      idempotencyKeyReused: 'This Idempotency-Key was used for a different upload.',
      cannotAttach: 'The file can no longer be attached.',
      uploadNotCompleted: 'The upload could not be completed.',
      tooManyUploads: 'Too many uploads in progress; retry shortly.',
      operationNotAllowed: 'Operation not allowed for this caller.',
      organizationNotAllowed: 'This caller cannot act for an organization.',
      noSuchFile: 'No such file.',
      tooManyDownloads: 'Too many downloads in progress; retry shortly.',
      onlyImagesInline: 'Only images may be served inline.',
      fileNotAvailable: 'The file is not available.',
      noSuchTicket: 'No such ticket.',
      contentNotAvailable: 'The file content is not available.',
      couldNotRead: 'The file could not be read.',
      fileDeleted: 'The file has been deleted.',
      linkNotValid: 'The link is not valid.',
      tooManyRequests: 'Too many requests.',
      uploadStillInProgress: 'The upload is still in progress.',
      noContentToDelete: 'The file has no content to delete.',
    };
    expect(Object.keys(FILE_MESSAGES).sort()).toEqual(Object.keys(before).sort());
    for (const [id, en] of Object.entries(before)) expect(FILE_MESSAGES[id as keyof typeof FILE_MESSAGES].en).toBe(en);
  });

  it('translates every message for real and never leaks a catalog key, placeholder or sentinel', () => {
    for (const [id, texts] of Object.entries(FILE_MESSAGES)) {
      expect(texts.fr, id).not.toBe(texts.en);
      expect(texts.ar, id).toMatch(/[؀-ۿ]/);
      for (const text of [texts.en, texts.fr, texts.ar]) expect(text, id).not.toMatch(/\{|\}|undefined|FILE_MESSAGES|\bfile\.[a-z_]+\b/);
    }
  });
});
