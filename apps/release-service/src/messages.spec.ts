import { catalogProblems } from '@nawara/service-kit';
import { describe, expect, it } from 'vitest';
import { RELEASE_MESSAGES } from './messages.js';

/** ADR-0054 D6 / D13 (Core V1 refactor R6.3): Release's catalog is complete in en / fr / ar and its English is the pre-R6.3 text. */
describe('RELEASE_MESSAGES', () => {
  it('is complete: every message has non-empty en, fr and ar text with identical placeholders', () => {
    expect(catalogProblems(RELEASE_MESSAGES)).toEqual([]);
  });

  it('keeps every English text exactly as Release returned it before R6.3', () => {
    const before: Record<keyof typeof RELEASE_MESSAGES, string> = {
      // the six `${what} is invalid.` sentences, each spelled out
      invalidProductOrComponentKey: 'The product or component key is invalid.',
      invalidComponentKey: 'The component key is invalid.',
      invalidVersion: 'The version is invalid.',
      invalidMinimumVersion: 'The minimum version is invalid.',
      invalidExpectedPolicyVersion: 'The expected policy version is invalid.',
      invalidRelease: 'The release is invalid.',
      stepUpRequired: 'A valid factor step-up for this operation is required.',
      noSuchRelease: 'No such release.',
      neverPublishedCannotBeWithdrawn: 'A registered release that was never published cannot be withdrawn.',
      cannotBeWithdrawn: 'This release cannot be withdrawn.',
      minimumHasNoPrerelease: 'A minimum version has no pre-release tag.',
      noSuchComponent: 'No such component.',
      backendHasNoPolicy: 'A backend component has no compatibility policy.',
      minimumAboveLatest: 'The minimum would exceed the latest published release.',
      minimumMustBePublished: 'The minimum must be a published, not withdrawn, release of this component.',
      wouldBreakMinimum: 'Withdrawing this release would leave the minimum version above the latest release; lower the minimum first.',
      policyConflict: 'The policy changed since you read it; read it again.',
      authorityUnverified: 'Authority could not be verified; nothing was changed.',
      ownerOnly: 'Only the owner of the operating Company may administer releases.',
      componentKindConflict: 'The component exists with another kind.',
      releaseIdentityConflict: 'This version is registered with a different identity.',
      cannotPublishInStatus: 'A {status} release cannot be published.',
      tooManyRequests: 'Too many requests.',
      onlyVersionParameter: 'Only the version query parameter is accepted.',
      notCanonicalVersion: 'The version is not a canonical release version.',
      noSuchClientComponent: 'No such client component.',
      notRegisteredRelease: 'This version is not a registered release of the component.',
      productNotAllowed: 'This caller has no authority on this product.',
      operationNotAllowed: 'Operation not allowed for this caller.',
    };
    expect(Object.keys(RELEASE_MESSAGES).sort()).toEqual(Object.keys(before).sort());
    for (const [id, en] of Object.entries(before)) expect(RELEASE_MESSAGES[id as keyof typeof RELEASE_MESSAGES].en).toBe(en);
  });

  it('never mixes languages: no French or Arabic text carries an English sentence fragment', () => {
    for (const [id, texts] of Object.entries(RELEASE_MESSAGES)) {
      expect(texts.fr, id).not.toMatch(/\b(is invalid|The |cannot be|release)\b/);
      expect(texts.ar, id).not.toMatch(/\b(is invalid|The |cannot be|release)\b/);
      expect(texts.ar, id).toMatch(/[؀-ۿ]/);
      expect(texts.fr, id).not.toBe(texts.en);
    }
  });
});
