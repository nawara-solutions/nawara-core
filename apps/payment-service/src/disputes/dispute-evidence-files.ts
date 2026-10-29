import { correlationHeaders } from '@nawara/service-kit';

/** DI token of File's evidence-grant boundary for dispute evidence (Core V2 S6e-D, PAY-10). */
export const DISPUTE_EVIDENCE_FILES = Symbol('PAYMENT_DISPUTE_EVIDENCE_FILES');

/** What File says, live, about a grant to Payment: the file it names and the grant's purpose and case. */
export interface GrantedEvidence {
  grantId: string;
  fileId: string;
  purpose: string;
  caseRef: string;
}

/**
 * Core V2 S6e-D (PAY-10, FIL-02; the Owner's R6E-3): File's granted metadata read (`GET /file/evidence-grants/:grantId/files/:fileId`) with
 * Payment's OWN service token (`read_granted`, purpose `dispute_evidence`). File answers only when the grant names Payment as grantee and
 * this file, is neither revoked nor expired, and the file is available; anything else is its one `404` (`null` here). An unanswerable File
 * THROWS: no evidence is ever recorded without File's answer.
 */
export interface DisputeEvidenceFiles {
  granted(grantId: string, fileId: string, deadline: AbortSignal): Promise<GrantedEvidence | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HttpDisputeEvidenceFiles implements DisputeEvidenceFiles {
  constructor(private readonly opts: { baseUrl: string; serviceToken: string }) {}

  async granted(grantId: string, fileId: string, deadline: AbortSignal): Promise<GrantedEvidence | null> {
    const res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}/file/evidence-grants/${encodeURIComponent(grantId)}/files/${encodeURIComponent(fileId)}`, {
      headers: { authorization: `Bearer ${this.opts.serviceToken}`, accept: 'application/json', ...correlationHeaders() }, redirect: 'manual', signal: deadline,
    });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`file-service granted read failed (status ${res.status})`);
    const body = (await res.json()) as { id?: unknown; grant?: { id?: unknown; purpose?: unknown; caseRef?: unknown } };
    const g = body.grant;
    if (typeof body.id !== 'string' || !g || typeof g.id !== 'string' || typeof g.purpose !== 'string' || typeof g.caseRef !== 'string'
      || !UUID.test(body.id) || !UUID.test(g.id) || !UUID.test(g.caseRef)) throw new Error('file-service granted read: malformed answer');
    return { grantId: g.id.toLowerCase(), fileId: body.id.toLowerCase(), purpose: g.purpose, caseRef: g.caseRef.toLowerCase() };
  }
}

/** Where File is not configured (the default outside simulation environments): evidence cannot be verified, so none is recorded. */
export class NoEvidenceFiles implements DisputeEvidenceFiles {
  async granted(): Promise<GrantedEvidence | null> {
    throw new Error('file-service is not configured for dispute evidence');
  }
}
