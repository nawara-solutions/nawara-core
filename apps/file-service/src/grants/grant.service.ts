import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { canonicalJson } from '@nawara/service-kit';
import { FileAudit } from '../audit/file-audit.js';
import type { FileConfig } from '../config/file-config.js';
import { FILE_CONFIG } from '../config/file-config.token.js';
import { FILE_MESSAGES } from '../messages.js';
import { GRANT_LIFETIME_DEFAULT_SECONDS, GrantRepository, type GrantRow } from '../persistence/grant.repository.js';
import type { CallerPolicy } from '../policy/caller-policy.js';
import { FILE_NOT_FOUND, fileError, idempotencyKey, organizationHeader } from '../upload/upload-http.js';
import { EVIDENCE_GRANTEES, SUBJECT_BOUND_PURPOSES, type EvidencePurpose } from './evidence-purposes.js';

/** What the grantor sees of a grant. Never its idempotency key or request hash. */
export interface GrantView {
  grantId: string;
  fileId: string;
  purpose: EvidencePurpose;
  grantee: string;
  caseRef: string;
  organizationId: string | null;
  status: 'active' | 'expired' | 'revoked';
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  /** Core V2 S6e-H: a `fraud_evidence` grant only. */
  companyId?: string;
  subjectUserId?: string;
}

/** Core V2 S6e-H: the Company and subject a subject-bound grant names (absent for every other purpose, whose shape is unchanged). */
export const subjectOf = (g: GrantRow) => (g.companyId && g.subjectUserId ? { companyId: g.companyId, subjectUserId: g.subjectUserId } : {});

export function grantView(g: GrantRow): GrantView {
  return {
    grantId: g.id, fileId: g.fileId, purpose: g.purpose, grantee: g.granteeService, caseRef: g.caseRef, organizationId: g.organizationId,
    status: g.revokedAt ? 'revoked' : g.active ? 'active' : 'expired',
    expiresAt: g.expiresAt.toISOString(), revokedAt: g.revokedAt?.toISOString() ?? null, createdAt: g.createdAt.toISOString(), ...subjectOf(g),
  };
}

/** The keyed hash of what an issuance asks for (the upload's `nawara.file.upload.v1` pattern, its own domain). */
export function grantRequestHash(key: Buffer, request: { fileId: string; organizationId: string | null; purpose: string; caseRef: string; lifetimeSeconds: number; companyId?: string; subjectUserId?: string }): string {
  return createHmac('sha256', key).update(`nawara.file.evidence_grant.v1|${canonicalJson(request)}`, 'utf8').digest('hex');
}

function sameHash(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Core V2 S2-File.1 (register FIL-01; OD-FILE F1 to F3, F6, F8): evidence grants, issued and revoked by the file's owner service only.
 *
 * - Authority: the caller is its authenticated service token, never a request value; it needs `grant` and the purpose in its own
 *   `grantPurposes` (deny by default). The grantee is FIXED by the purpose (F2), never chosen by the request; a service never grants to
 *   itself. The file is looked up as the caller's own file in the presented organization, so a foreign, missing or malformed file id is
 *   one `404 file_not_found`, and the grant's organization is the file's (a grant never widens organization scope).
 * - Lifetime: 24 hours by default, at most 7 days (F3), computed on the database clock; never extended.
 * - Idempotency: one grant per (grantor, Idempotency-Key). The same key and request answers the recorded grant (`200`, even after its
 *   file was deleted or the grant revoked: a lost response is recovered, never re-issued); a different request is `422`.
 * - Revocation: by the grantor, idempotent; an already revoked grant answers its first revocation.
 * - Audit (F6): `file.grant_issued` / `file.grant_revoked`, in the same transaction, only on the transition.
 * Nothing here reads a file for the grantee: granted reads are S2-File.2, and the owner-only routes are unchanged.
 */
@Injectable()
export class GrantService {
  private readonly logger = new Logger('FileGrants');

  constructor(
    @Inject(FILE_CONFIG) private readonly config: FileConfig,
    private readonly grants: GrantRepository,
    @Inject(FileAudit) private readonly audit: FileAudit,
  ) {}

  async issue(caller: string, req: Request, fileId: string, input: { purpose: EvidencePurpose; caseRef: string; expiresInSeconds?: number; companyId?: string; subjectUserId?: string }): Promise<{ created: boolean; grant: GrantView }> {
    const policy = this.policy(caller);
    const organizationId = this.organization(policy, organizationHeader(req));
    const key = idempotencyKey(req);
    const grantee = EVIDENCE_GRANTEES[input.purpose];
    if (!policy.grantPurposes?.has(input.purpose) || grantee === caller) throw fileError(403, 'purpose_not_allowed', FILE_MESSAGES.purposeNotAllowed);
    // Core V2 S6e-H (H-3): a subject-bound purpose names its Company and subject; no other purpose may carry them
    const bound = SUBJECT_BOUND_PURPOSES.has(input.purpose);
    if (bound !== (input.companyId !== undefined) || bound !== (input.subjectUserId !== undefined)) throw fileError(400, 'validation_error', FILE_MESSAGES.grantSubjectInvalid);
    const subject = bound ? { companyId: input.companyId!.toLowerCase(), subjectUserId: input.subjectUserId!.toLowerCase() } : {};
    const lifetimeSeconds = input.expiresInSeconds ?? GRANT_LIFETIME_DEFAULT_SECONDS;
    // the subject joins the hashed request only when present: every existing grant's request hash is unchanged
    const request = { fileId, organizationId, purpose: input.purpose, caseRef: input.caseRef, lifetimeSeconds, ...subject };
    const requestHash = grantRequestHash(this.config.upload.requestHashKey, request);

    const outcome = await this.grants.issue(
      { scope: { ownerService: caller, organizationId }, fileId, purpose: input.purpose, granteeService: grantee, caseRef: input.caseRef, lifetimeSeconds, idempotencyKey: key, requestHash, ...subject },
      (q, grant) => this.audit.grantIssued(q, grant),
    );
    switch (outcome.kind) {
      case 'not_found':
        throw FILE_NOT_FOUND();
      case 'not_grantable':
        if (outcome.file.status === 'DELETING' || outcome.file.status === 'DELETED') throw fileError(410, 'file_deleted', FILE_MESSAGES.fileDeleted);
        throw fileError(409, 'file_not_grantable', FILE_MESSAGES.fileNotGrantable);
      case 'existing': {
        // A replay is recognized under the current request-hash key or a retiring one (the upload's rotation window).
        const candidates = [requestHash, ...this.config.upload.requestHashPreviousKeys.map((k) => grantRequestHash(k, request))];
        if (!candidates.some((h) => sameHash(outcome.requestHash, h))) throw fileError(422, 'idempotency_key_reused', FILE_MESSAGES.grantIdempotencyKeyReused);
        return { created: false, grant: grantView(outcome.grant) };
      }
      case 'created':
        this.logger.log(`file_grant_issued owner=${caller} grant=${outcome.grant.id} file=${outcome.grant.fileId} purpose=${outcome.grant.purpose} grantee=${grantee}`);
        return { created: true, grant: grantView(outcome.grant) };
    }
  }

  async revoke(caller: string, req: Request, grantId: string): Promise<GrantView> {
    const policy = this.policy(caller);
    const organizationId = this.organization(policy, organizationHeader(req));
    const result = await this.grants.revoke({ ownerService: caller, organizationId }, grantId, (q, grant) => this.audit.grantRevoked(q, grant));
    if (!result) throw fileError(404, 'grant_not_found', FILE_MESSAGES.noSuchGrant); // another service's or organization's grant: the same
    if (result.revoked) this.logger.log(`file_grant_revoked owner=${caller} grant=${result.grant.id}`);
    return grantView(result.grant);
  }

  /** Deny by default; a caller that lost `grant` can neither issue nor revoke (and, in S2-File.2, its grants stop being usable). */
  private policy(caller: string): CallerPolicy {
    const policy = this.config.callerPolicy.of(caller);
    if (!policy?.operations.has('grant')) throw fileError(403, 'operation_not_allowed', FILE_MESSAGES.operationNotAllowed);
    return policy;
  }

  private organization(policy: CallerPolicy, organizationId: string | null): string | null {
    if (organizationId !== null && policy.organizations === 'none') throw fileError(403, 'organization_not_allowed', FILE_MESSAGES.organizationNotAllowed);
    return organizationId;
  }
}
