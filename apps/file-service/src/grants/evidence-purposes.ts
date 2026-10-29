/**
 * Core V2 S2-File.1 (OD-FILE F2): the CLOSED evidence-purpose vocabulary, each purpose with its one grantee service (register PAY-10
 * dispute evidence; BIL-30 recovery-surplus and BIL-32 late-settlement evidence; S6e-H BIL-27 fraud-hold evidence). The schema's `file_evidence_grant_purpose_grantee`
 * CHECK is the same table: a change is a migration AND this file.
 */
export const EVIDENCE_GRANTEES = {
  dispute_evidence: 'payment-service',
  surplus_evidence: 'billing-service',
  settlement_evidence: 'billing-service',
  fraud_evidence: 'billing-service', // Core V2 S6e-H (H-3): a fraud hold's evidence, bound to its Company and subject (migration 0008)
} as const;

export type EvidencePurpose = keyof typeof EVIDENCE_GRANTEES;
export type EvidenceGrantee = (typeof EVIDENCE_GRANTEES)[EvidencePurpose];
export const EVIDENCE_PURPOSES = Object.keys(EVIDENCE_GRANTEES) as EvidencePurpose[];

export function isEvidencePurpose(v: unknown): v is EvidencePurpose {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(EVIDENCE_GRANTEES, v);
}

/** Core V2 S6e-H (H-3): the purposes whose grant must also name the Company and the subject (the beneficiary) the evidence is about. */
export const SUBJECT_BOUND_PURPOSES: ReadonlySet<EvidencePurpose> = new Set(['fraud_evidence']);
