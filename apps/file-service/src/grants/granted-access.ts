import type { FileCallerPolicy } from '../policy/caller-policy.js';
import type { EvidencePurpose } from './evidence-purposes.js';

/**
 * Core V2 S2-File.2: the CURRENT policy behind a granted access, re-read at every use (OD-FILE F8: losing a permission stops new access).
 * The grantee needs `read_granted` and the purpose in its `readPurposes`; its organization mode is irrelevant (the organization is the
 * grant's, never the request's).
 */
export function granteeMayRead(policies: FileCallerPolicy, grantee: string, purpose: EvidencePurpose): boolean {
  const p = policies.of(grantee);
  return !!p?.operations.has('read_granted') && !!p.readPurposes?.has(purpose);
}

/** The grantor must still hold `grant` for the purpose, and still act for the grant's organization (if it has one). */
export function grantorStillAllows(policies: FileCallerPolicy, grant: { grantorService: string; purpose: EvidencePurpose; organizationId: string | null }): boolean {
  const p = policies.of(grant.grantorService);
  return !!p?.operations.has('grant') && !!p.grantPurposes?.has(grant.purpose) && !(grant.organizationId !== null && p.organizations === 'none');
}
