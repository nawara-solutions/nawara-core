import { describe, expect, it } from 'vitest';
import type { PaymentConfig } from '../config/payment-config.js';
import {
  REFUND_CAPABILITY_CERTIFICATES, REFUND_CAPABILITY_NAMES, SIMULATION_REFUND_CONTRACT_CERTIFICATE, SIMULATION_REFUND_FAILURE_FINALITY_CERTIFICATE,
  certificateFingerprint, certificateWellFormed, evaluateRefundCapability, failureFinalityOf, registryProblems, sameKeyResendAllowed,
  type RefundCapabilityCertificate, type RefundCapabilityContext, type RefundCapabilitySubject, type RefundFailureFinalityRecord,
} from './refund-capabilities.js';
import { SimulationPaymentProvider } from './simulation-provider.js';
import { TestPaymentProvider } from './test-provider.js';

/**
 * Core V2 D-R1A (the Owner's D-R1 direction, Q1, Q3, Q5, Q6): the capability registry and its one evaluation. Every certificate below that is not
 * a registry constant is a SYNTHETIC TEST FIXTURE passed through the evaluation's test override; none is a provider guarantee, and the registry
 * itself certifies no real provider.
 */
const NOW = new Date('2027-01-15T12:00:00.000Z');
const SIM_ENV: RefundCapabilityContext = { now: NOW, simulationEnvironment: true };
const sim = (refs = [SIMULATION_REFUND_CONTRACT_CERTIFICATE, SIMULATION_REFUND_FAILURE_FINALITY_CERTIFICATE]): RefundCapabilitySubject =>
  ({ id: 'simulation', capabilities: { refundCapabilityCertificates: refs.map((c) => ({ id: c.id, version: c.version })) } });
const SYNTHETIC: RefundCapabilityCertificate = {
  id: 'synthetic-test-provider-refunds', version: 3, providerId: 'synthetic', scope: 'provider',
  issuedAt: '2027-01-01T00:00:00.000Z', expiresAt: '2027-06-01T00:00:00.000Z',
  authorization: 'SYNTHETIC TEST FIXTURE, not an Owner authorization', documentaryBasis: 'SYNTHETIC TEST FIXTURE, no provider document',
  adapterMapping: 'SYNTHETIC TEST FIXTURE, no adapter',
  grants: { terminalFailureFinality: { observations: ['dispatch_rejected'] }, idempotencyKeyRetention: { lifetimeMs: 86_400_000 } },
};
const synthetic = (c: RefundCapabilityCertificate = SYNTHETIC): RefundCapabilitySubject => ({ id: c.providerId, capabilities: { refundCapabilityCertificates: [{ id: c.id, version: c.version }] } });
const withRegistry = (registry: unknown[], extra: Partial<RefundCapabilityContext> = {}): RefundCapabilityContext =>
  ({ now: NOW, simulationEnvironment: false, registry: registry as RefundCapabilityCertificate[], ...extra });

describe('the registry (the one authoritative source)', () => {
  it('is sound, holds only simulation-scope certificates for the simulation provider, and certifies no real provider (Q3)', () => {
    expect(registryProblems()).toEqual([]);
    expect(REFUND_CAPABILITY_CERTIFICATES.length).toBeGreaterThan(0);
    for (const c of REFUND_CAPABILITY_CERTIFICATES) {
      expect(c.scope).toBe('simulation');
      expect(c.providerId).toBe('simulation');
    }
    expect(Object.isFrozen(REFUND_CAPABILITY_CERTIFICATES)).toBe(true);
    expect(Object.isFrozen(SIMULATION_REFUND_CONTRACT_CERTIFICATE.grants)).toBe(true);
  });

  it('reports duplicates, malformed entries and revocations of unregistered certificates', () => {
    expect(registryProblems([SYNTHETIC, SYNTHETIC], [])).toEqual(['duplicate certificate synthetic-test-provider-refunds@3']);
    expect(registryProblems([{ ...SYNTHETIC, expiresAt: null }], [])).toEqual(['entry 0 is malformed']);
    expect(registryProblems([SYNTHETIC], [{ id: 'nope', version: 1, revokedAt: '2027-01-01T00:00:00.000Z', reason: 'x' }])).toEqual(['revocation of unregistered certificate nope@1']);
  });

  it('the fingerprint changes with any content change', () => {
    expect(certificateFingerprint(SYNTHETIC)).toMatch(/^[0-9a-f]{64}$/);
    expect(certificateFingerprint({ ...SYNTHETIC, grants: { ...SYNTHETIC.grants, idempotencyKeyRetention: { lifetimeMs: 86_400_001 } } })).not.toBe(certificateFingerprint(SYNTHETIC));
    expect(certificateFingerprint({ ...SYNTHETIC })).toBe(certificateFingerprint(SYNTHETIC)); // key order is irrelevant
  });
});

describe('certificate validation (fail closed)', () => {
  const bad: [string, Partial<RefundCapabilityCertificate> | Record<string, unknown>][] = [
    ['a real provider without an expiry', { expiresAt: null }],
    ['an expiry not after its issue', { expiresAt: SYNTHETIC.issuedAt }],
    ['a non-ISO instant', { issuedAt: '2027-01-01' }],
    ['an empty authorization', { authorization: ' ' }],
    ['no documentary basis', { documentaryBasis: '' }],
    ['no adapter mapping', { adapterMapping: '' }],
    ['no grant', { grants: {} }],
    ['an unknown grant', { grants: { refundsAlwaysSucceed: { granted: true } } }],
    ['an unknown member of a grant', { grants: { idempotencyKeyRetention: { lifetimeMs: 1, extra: 1 } } }],
    ['unbounded retention for a real provider', { grants: { idempotencyKeyRetention: { unbounded: true } } }],
    ['a zero lifetime', { grants: { idempotencyKeyRetention: { lifetimeMs: 0 } } }],
    ['an empty observation list', { grants: { terminalFailureFinality: { observations: [] } } }],
    ['an unknown observation', { grants: { terminalFailureFinality: { observations: ['status_read_says_failed'] } } }],
    ['a provider-scope certificate naming the simulation provider', { providerId: 'simulation' }],
    ['a simulation-scope certificate naming another provider', { scope: 'simulation', expiresAt: null }],
    ['an unknown top-level member', { selfCertified: true }],
    ['a version of zero', { version: 0 }],
  ];
  it.each(bad)('refuses %s', (_label, patch) => {
    const c = { ...SYNTHETIC, ...patch };
    expect(certificateWellFormed(c)).toBe(false);
    expect(evaluateRefundCapability(synthetic(c as RefundCapabilityCertificate), 'idempotencyKeyRetention', withRegistry([c]))).toMatchObject({ certified: false });
  });

  it('accepts the well-formed synthetic fixture through the test override only', () => {
    expect(certificateWellFormed(SYNTHETIC)).toBe(true);
    expect(evaluateRefundCapability(synthetic(), 'idempotencyKeyRetention', withRegistry([SYNTHETIC]))).toMatchObject({ certified: true, grant: { lifetimeMs: 86_400_000 } });
    // the real registry knows nothing of it: an adapter's own reference never certifies itself
    expect(evaluateRefundCapability(synthetic(), 'idempotencyKeyRetention', { now: NOW, simulationEnvironment: false })).toMatchObject({ certified: false, reason: 'unknown_certificate' });
  });
});

describe('evaluateRefundCapability', () => {
  it('certifies the simulation contract only for the simulation provider in a simulation environment (Q6 isolation)', () => {
    expect(evaluateRefundCapability(sim(), 'idempotencyKeyRetention', SIM_ENV)).toMatchObject({ certified: true, grant: { unbounded: true } });
    expect(evaluateRefundCapability(sim(), 'idempotencyKeyRetention', { ...SIM_ENV, simulationEnvironment: false }))
      .toMatchObject({ certified: false, reason: 'simulation_scope_outside_simulation' });
    // never promoted: another provider referencing a simulation certificate
    const borrowed = { id: 'flouci', capabilities: sim().capabilities };
    expect(evaluateRefundCapability(borrowed, 'idempotencyKeyRetention', SIM_ENV)).toMatchObject({ certified: false, reason: 'provider_mismatch' });
    expect(evaluateRefundCapability(borrowed, 'terminalFailureFinality', SIM_ENV)).toMatchObject({ certified: false });
  });

  it('refuses every unknown, absent or unverifiable state', () => {
    expect(evaluateRefundCapability(undefined, 'terminalFailureFinality', SIM_ENV)).toMatchObject({ certified: false, reason: 'not_declared' });
    expect(evaluateRefundCapability({ id: 'simulation', capabilities: {} }, 'terminalFailureFinality', SIM_ENV)).toMatchObject({ certified: false, reason: 'not_declared' });
    expect(evaluateRefundCapability({ id: 'simulation', capabilities: { refundCapabilityCertificates: [{ id: 'simulation-refund-contract', version: 2 }] } }, 'idempotencyKeyRetention', SIM_ENV))
      .toMatchObject({ certified: false, reason: 'version_mismatch' });
    expect(evaluateRefundCapability({ id: 'simulation', capabilities: { refundCapabilityCertificates: [{ id: 'never-registered', version: 1 }] } }, 'idempotencyKeyRetention', SIM_ENV))
      .toMatchObject({ certified: false, reason: 'unknown_certificate' });
    expect(evaluateRefundCapability(sim([SIMULATION_REFUND_CONTRACT_CERTIFICATE]), 'terminalFailureFinality', SIM_ENV)).toMatchObject({ certified: false, reason: 'not_granted' });
    expect(evaluateRefundCapability(sim(), 'cancellation', SIM_ENV)).toMatchObject({ certified: false, reason: 'not_granted' });
    expect(evaluateRefundCapability(sim(), 'authoritativeNotFound', SIM_ENV)).toMatchObject({ certified: false, reason: 'not_granted' });
    expect(evaluateRefundCapability(synthetic(), 'idempotencyKeyRetention', withRegistry([SYNTHETIC, SYNTHETIC]))).toMatchObject({ certified: false, reason: 'duplicate_certificate' });
    expect(evaluateRefundCapability(synthetic(), 'idempotencyKeyRetention', withRegistry([SYNTHETIC], { now: new Date(Number.NaN) }))).toMatchObject({ certified: false });
  });

  it('honours validity windows, revocation and ambiguity', () => {
    const at = (iso: string) => withRegistry([SYNTHETIC], { now: new Date(iso) });
    expect(evaluateRefundCapability(synthetic(), 'idempotencyKeyRetention', at('2026-12-31T23:59:59.999Z'))).toMatchObject({ certified: false, reason: 'not_yet_valid' });
    expect(evaluateRefundCapability(synthetic(), 'idempotencyKeyRetention', at('2027-06-01T00:00:00.000Z'))).toMatchObject({ certified: false, reason: 'expired' });
    const revoked = withRegistry([SYNTHETIC], { revocations: [{ id: SYNTHETIC.id, version: 3, revokedAt: '2027-01-10T00:00:00.000Z', reason: 'SYNTHETIC' }] });
    expect(evaluateRefundCapability(synthetic(), 'idempotencyKeyRetention', revoked)).toMatchObject({ certified: false, reason: 'revoked' });
    const malformedRevocation = withRegistry([SYNTHETIC], { revocations: [{ id: SYNTHETIC.id, version: 3, revokedAt: 'soon', reason: '' }] });
    expect(evaluateRefundCapability(synthetic(), 'idempotencyKeyRetention', malformedRevocation)).toMatchObject({ certified: false, reason: 'revoked' });
    const second = { ...SYNTHETIC, id: 'synthetic-second' };
    const both: RefundCapabilitySubject = { id: 'synthetic', capabilities: { refundCapabilityCertificates: [{ id: SYNTHETIC.id, version: 3 }, { id: second.id, version: 3 }] } };
    expect(evaluateRefundCapability(both, 'idempotencyKeyRetention', withRegistry([SYNTHETIC, second]))).toMatchObject({ certified: false, reason: 'ambiguous' });
  });

  it('knows every capability name of the Q1 model', () => {
    expect([...REFUND_CAPABILITY_NAMES].sort()).toEqual(['authoritativeNotFound', 'cancellation', 'idempotencyKeyRetention', 'statusAuthority', 'terminalFailureFinality']);
  });
});

describe('sameKeyResendAllowed (Q5)', () => {
  const certified = evaluateRefundCapability(synthetic(), 'idempotencyKeyRetention', withRegistry([SYNTHETIC]));
  it('allows a resend strictly within a certified finite lifetime, measured from the authorization', () => {
    expect(sameKeyResendAllowed(certified, 0)).toEqual({ allowed: true });
    expect(sameKeyResendAllowed(certified, 86_399_999)).toEqual({ allowed: true });
    expect(sameKeyResendAllowed(certified, 86_400_000)).toEqual({ allowed: false, reason: 'retention_elapsed' });
    expect(sameKeyResendAllowed(certified, null)).toEqual({ allowed: false, reason: 'elapsed_unknown' });
    expect(sameKeyResendAllowed(certified, -1)).toEqual({ allowed: false, reason: 'elapsed_unknown' });
    expect(sameKeyResendAllowed(certified, Number.NaN)).toEqual({ allowed: false, reason: 'elapsed_unknown' });
  });
  it('refuses when the guarantee is absent, uncertified or expired; the simulation contract is unbounded', () => {
    expect(sameKeyResendAllowed(evaluateRefundCapability(undefined, 'idempotencyKeyRetention', SIM_ENV), 1)).toEqual({ allowed: false, reason: 'not_declared' });
    expect(sameKeyResendAllowed(evaluateRefundCapability(synthetic(), 'idempotencyKeyRetention', withRegistry([SYNTHETIC], { now: new Date('2027-07-01T00:00:00.000Z') })), 1))
      .toEqual({ allowed: false, reason: 'expired' });
    expect(sameKeyResendAllowed(evaluateRefundCapability(sim(), 'idempotencyKeyRetention', SIM_ENV), null)).toEqual({ allowed: true });
  });
});

describe('failureFinalityOf (D-R1 Part A: historical and revoked failures are never final)', () => {
  const ctx = withRegistry([SYNTHETIC]);
  const record = (patch: Partial<RefundFailureFinalityRecord> = {}): RefundFailureFinalityRecord => ({
    certificateId: SYNTHETIC.id, certificateVersion: 3, fingerprint: certificateFingerprint(SYNTHETIC), observation: 'dispatch_rejected', failureCode: 'declined', ...patch,
  });
  it('a historical failed attempt (no record) is never final, even when its provider is certified now', () => {
    expect(evaluateRefundCapability(synthetic(), 'terminalFailureFinality', ctx)).toMatchObject({ certified: true });
    expect(failureFinalityOf(null, synthetic(), ctx)).toEqual({ final: false, reason: 'no_finality_record' });
  });
  it('a record is final only while its exact certificate is certified and covers its observation', () => {
    expect(failureFinalityOf(record(), synthetic(), ctx)).toMatchObject({ final: true });
    expect(failureFinalityOf(record({ observation: 'provider_failed' }), synthetic(), ctx)).toEqual({ final: false, reason: 'observation_not_covered' });
    expect(failureFinalityOf(record({ fingerprint: '0'.repeat(64) }), synthetic(), ctx)).toEqual({ final: false, reason: 'certificate_changed' });
    expect(failureFinalityOf(record({ certificateVersion: 2 }), synthetic(), ctx)).toEqual({ final: false, reason: 'version_mismatch' }); // its own version is not registered
    expect(failureFinalityOf(record({ failureCode: 'Not A Code' }), synthetic(), ctx)).toEqual({ final: false, reason: 'malformed_record' });
  });
  it('supersession is explicit (D-R1B): a newer declared version neither ends, rescues nor widens evidence recorded under an older one', () => {
    const v4: RefundCapabilityCertificate = { ...SYNTHETIC, version: 4, grants: { terminalFailureFinality: { observations: ['dispatch_rejected', 'provider_failed'] } } };
    const both = withRegistry([SYNTHETIC, v4]);
    expect(failureFinalityOf(record(), synthetic(v4), both)).toMatchObject({ final: true, certificate: { version: 3 } }); // judged under its own version
    expect(failureFinalityOf(record({ observation: 'provider_failed' }), synthetic(v4), both)).toEqual({ final: false, reason: 'observation_not_covered' }); // not widened
    expect(failureFinalityOf(record(), synthetic(v4), { ...both, revocations: [{ id: SYNTHETIC.id, version: 3, revokedAt: '2027-01-02T00:00:00.000Z', reason: 'SYNTHETIC' }] }))
      .toEqual({ final: false, reason: 'revoked' }); // ended explicitly; version 4 does not stand in for it
    expect(failureFinalityOf(record(), synthetic(v4), withRegistry([v4]))).toEqual({ final: false, reason: 'version_mismatch' }); // removed from the registry
    expect(failureFinalityOf(record(), synthetic({ ...v4, id: 'synthetic-other-certificate' }), withRegistry([SYNTHETIC, { ...v4, id: 'synthetic-other-certificate' }])))
      .toEqual({ final: false, reason: 'certificate_changed' }); // another certificate id is never the same guarantee
  });
  it('revocation, expiry and provider configuration changes apply to existing records (fail closed)', () => {
    expect(failureFinalityOf(record(), synthetic(), { ...ctx, revocations: [{ id: SYNTHETIC.id, version: 3, revokedAt: '2027-01-02T00:00:00.000Z', reason: 'SYNTHETIC' }] }))
      .toEqual({ final: false, reason: 'revoked' });
    expect(failureFinalityOf(record(), synthetic(), { ...ctx, now: new Date('2027-06-02T00:00:00.000Z') })).toEqual({ final: false, reason: 'expired' });
    expect(failureFinalityOf(record(), { id: 'synthetic', capabilities: {} }, ctx)).toEqual({ final: false, reason: 'not_declared' });
    expect(failureFinalityOf(record(), synthetic(), { now: NOW, simulationEnvironment: false })).toEqual({ final: false, reason: 'unknown_certificate' });
  });
});

describe('adapter declarations', () => {
  const config = (refundFailureFinality: boolean) => ({ simulation: { webhookSecret: 'x'.repeat(32), refundFailureFinality }, isProduction: false }) as unknown as PaymentConfig;
  it('the simulation adapter references its contract always, and modelled failure finality only when the environment opts in (Q6)', () => {
    const off = new SimulationPaymentProvider({} as never, config(false));
    const on = new SimulationPaymentProvider({} as never, config(true));
    expect(off.capabilities.refundCapabilityCertificates).toEqual([{ id: 'simulation-refund-contract', version: 1 }]);
    expect(on.capabilities.refundCapabilityCertificates).toEqual([{ id: 'simulation-refund-contract', version: 1 }, { id: 'simulation-refund-failure-finality', version: 1 }]);
    expect(evaluateRefundCapability(off, 'terminalFailureFinality', SIM_ENV)).toMatchObject({ certified: false, reason: 'not_granted' });
    expect(evaluateRefundCapability(on, 'terminalFailureFinality', SIM_ENV)).toMatchObject({ certified: true, grant: { observations: ['dispatch_rejected', 'provider_failed'] } });
    expect(Object.isFrozen(on.capabilities)).toBe(true);
    // its existing capabilities are unchanged
    expect(on.capabilities).toMatchObject({ refunds: true, partialRefunds: false, notFoundIsAuthoritative: true, refundReferenceScope: 'provider' });
  });
  it('the test provider references nothing: every refund capability is uncertified', () => {
    const p = new TestPaymentProvider();
    for (const name of REFUND_CAPABILITY_NAMES) expect(evaluateRefundCapability(p, name, SIM_ENV)).toMatchObject({ certified: false, reason: 'not_declared' });
  });
});
