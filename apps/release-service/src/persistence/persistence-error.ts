/**
 * A refused Release Management write, as a bounded code (the database's detail never leaves this layer):
 *   invalid              the input breaks a shape rule (key, kind, version, build identity) or the schema refused it
 *   conflict             the natural key exists with a DIFFERENT identity (a component with another kind, a release with another build)
 *   invalid_transition   the lifecycle does not allow this move (only registered → published → withdrawn)
 *   invariant_violation  the minimum version would exceed the latest release (a policy change, or a withdrawal)
 *   policy_conflict      the expected policy version is stale (another change came first): the optimistic-concurrency refusal
 *   not_found            no such product, component or release
 */
export type ReleaseStoreCode = 'invalid' | 'conflict' | 'invalid_transition' | 'invariant_violation' | 'policy_conflict' | 'not_found';

export class ReleaseStoreError extends Error {
  constructor(readonly code: ReleaseStoreCode) {
    super(code);
    this.name = 'ReleaseStoreError';
  }
}
