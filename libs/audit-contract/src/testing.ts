// @nawara/audit-contract/testing — TEST tooling only (the kit's `./testing` precedent): a valid payload for any cataloged action, derived
// mechanically from its catalog entry, so contract matrices and the audit-service persistence suite cover every action without a
// hand-written fixture per action (a new action is covered the moment it is cataloged).
import { AUDIT_CATALOG, catalogEntry, type AuditAction, type ChangeSpec } from './catalog.js';
import type { AuditActor, AuditPayload, AuditReference, ChangeScalar, ChangeValue } from './contract.js';

export const SAMPLE_IDS = Object.freeze({
  user: '0b7f7a52-6f55-4c1e-9d59-2f0d7c3a1e11',
  organization: '3c1d9b0e-2a4f-4b8e-8f6a-5d7e9c0b1a22',
  resource: '6e2f8a1c-9b3d-4c5e-a7f0-1d2c3b4a5e33',
  subject: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c44',
  uuidA: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c55',
  uuidB: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d66',
  causation: 'c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e77',
});
const T1 = '2026-09-25T10:00:00.000Z';
const T2 = '2026-10-25T10:00:00.000Z';

function scalar(s: ChangeSpec, second: boolean): ChangeScalar {
  switch (s.type) {
    case 'code':
      return s.values[second ? 1 : 0]!;
    case 'uuid':
      return second ? SAMPLE_IDS.uuidB : SAMPLE_IDS.uuidA;
    case 'boolean':
      return second;
    case 'integer':
      return second ? s.max : s.min;
    case 'timestamp':
      return second ? T2 : T1;
  }
}

/** The first allowed actor of an action, in the order user → service → system. */
export function sampleActor(action: AuditAction): AuditActor {
  const e = catalogEntry(action)!;
  if (e.actors.user) return { type: 'user', id: SAMPLE_IDS.user, userKind: e.actors.user[0]! };
  if (e.actors.service) return { type: 'service', id: 'sample-caller' };
  return { type: 'system', id: e.actors.system![0]! };
}

/**
 * A valid payload: `minimal` carries only what the action requires (optional subject, optional changes and causation omitted;
 * an optional organization is null); `complete` carries every optional part too.
 */
export function sampleAuditPayload(action: AuditAction, variant: 'minimal' | 'complete' = 'minimal'): AuditPayload {
  const e = catalogEntry(action)!;
  const resource: AuditReference = { type: e.resource[0]!, id: e.organization === 'self' ? SAMPLE_IDS.organization : SAMPLE_IDS.resource };
  let organizationId: string | null;
  switch (e.organization) {
    case 'required':
    case 'self':
      organizationId = SAMPLE_IDS.organization;
      break;
    case 'optional':
      organizationId = variant === 'complete' ? SAMPLE_IDS.organization : null;
      break;
    case 'none':
      organizationId = null;
      break;
    case 'resource':
      organizationId = resource.type === 'organization' ? resource.id : null;
      break;
  }
  const changes: Record<string, ChangeValue> = {};
  for (const [k, s] of Object.entries(e.changes)) {
    if (!s.required && variant === 'minimal') continue;
    changes[k] = s.shape === 'transition' ? { from: scalar(s, false), to: scalar(s, true) } : scalar(s, false);
  }
  const s = e.subject;
  const subject = s.rule === 'required' || (s.rule === 'optional' && variant === 'complete') ? { type: s.type, id: SAMPLE_IDS.subject } : undefined;
  return {
    action,
    actor: sampleActor(action),
    organizationId,
    resource,
    ...(subject ? { subject } : {}),
    outcome: e.outcomes[0]!,
    ...(Object.keys(changes).length > 0 ? { changes } : {}),
    ...(variant === 'complete' ? { causationId: SAMPLE_IDS.causation } : {}),
  };
}

/** Every cataloged action, for table-driven suites. */
export function sampleActions(): AuditAction[] {
  return [...AUDIT_CATALOG.keys()];
}
