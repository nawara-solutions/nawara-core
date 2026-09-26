import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { ReleaseAdminAudit } from '../audit/release-audit.js';
import { REGISTRY_KEY, type Component, type Release } from '../domain/model.js';
import { isCanonicalVersion, isStableVersion } from '../domain/version.js';
import { ReleaseStoreError } from '../persistence/persistence-error.js';
import { ReleaseStore } from '../persistence/release-store.js';
import { ReleaseCounters } from '../ops/release-counters.js';
import { AuthDependencyError, OWNER_AUTHORITY, type OwnerAuthority, type ReleaseStepUpPurpose } from './owner-authority.client.js';
import type { VerifiedOwner } from './owner.guard.js';

export const adminError = (status: number, code: string, message: string) => new HttpException({ message, code }, status);
const INVALID = (what: string) => adminError(400, 'validation_error', `${what} is invalid.`);
const STEP_UP_REQUIRED = () => adminError(403, 'step_up_required', 'A valid factor step-up for this operation is required.');
const STEP_UP_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_POLICY_VERSION = 2_147_483_647;

type Operation = 'withdraw' | 'policy_change';
type Outcome = 'changed' | 'unchanged' | 'step_up_denied' | 'invalid' | 'not_found' | 'conflict' | 'unauthenticated' | 'auth_timeout' | 'auth_unavailable';

export interface WithdrawView {
  id: string;
  product: string;
  component: string;
  kind: Component['kind'];
  version: string;
  status: Release['status'];
  publishedAt: string | null;
  withdrawnAt: string | null;
  /** false: the release was already withdrawn; nothing was written (no evidence). */
  changed: boolean;
}

export interface PolicyView {
  product: string;
  component: string;
  kind: Component['kind'];
  policyVersion: number;
  minimumVersion: string;
  createdAt: string;
  /** false: this minimum was already in effect; no policy version was added (no evidence). */
  changed: boolean;
}

export interface PolicyChangeInput {
  minimumVersion: string;
  /** The policy version the owner last saw (0 when the component has none): optimistic concurrency, no lost update. */
  expectedPolicyVersion: number;
}

/**
 * Stage 20.4 (ADR-0051 decisions 3, 8, 9): the owner's two sensitive operations. The guard has already verified, live through Auth, that the
 * caller is the owner of the configured operating Company. Then, for each operation:
 *
 * 1. validate the input (400) and resolve the target (404), then check EVERY precondition that can be known before the change (lifecycle,
 *    the minimum ≤ latest invariant, the expected policy version) — so a refusal never spends the owner's step-up;
 * 2. verify and consume the factor step-up through Auth (`POST /auth/step-up/verify`: this owner, this session, this purpose, once) —
 *    ADR-0050's "verifies and consumes a step-up through Auth". It is consumed in Auth's database, so it cannot roll back with ours: the
 *    same cross-service semantics organization-service has (a mutation that then fails, rarely and only on a race, needs a new step-up);
 * 3. ONE transaction: the component's advisory lock (the one the policy and withdrawal triggers take), the change re-checked by the
 *    database (the authority for every invariant), and, only when a row changed, its audit intent in the outbox.
 *
 * An idempotent no-op (already withdrawn; the same minimum) still needs, and consumes, a valid step-up — the Stage 19.2 rule for sensitive
 * owner operations — and writes nothing.
 */
@Injectable()
export class AdminService {
  private readonly log = new Logger('ReleaseAdmin');

  constructor(
    @Inject(ReleaseStore) private readonly store: ReleaseStore,
    @Inject(ReleaseAdminAudit) private readonly audit: ReleaseAdminAudit,
    @Inject(OWNER_AUTHORITY) private readonly auth: OwnerAuthority,
    @Inject(ReleaseCounters) private readonly counters: ReleaseCounters,
  ) {}

  async withdraw(owner: VerifiedOwner, product: string, componentKey: string, version: string, stepUpToken: string | undefined): Promise<WithdrawView> {
    return this.run('withdraw', owner, async () => {
      if (!REGISTRY_KEY.test(product) || !REGISTRY_KEY.test(componentKey)) throw INVALID('The product or component key');
      if (!isCanonicalVersion(version)) throw INVALID('The version');
      const component = await this.store.findComponent(product, componentKey);
      const release = component ? await this.store.findRelease(component.id, version) : null;
      if (!component || !release) throw adminError(404, 'release_not_found', 'No such release.');
      if (release.status === 'registered') {
        // ADR-0051: registered → published → withdrawn. A release never offered to clients is not withdrawn; it stays inert (never latest).
        throw adminError(409, 'invalid_transition', 'A registered release that was never published cannot be withdrawn.');
      }
      if (release.status === 'published' && (await this.store.withdrawalBreaksMinimum(component.id, release.id))) throw WOULD_BREAK_MINIMUM();
      await this.stepUp(owner, 'release.withdraw', stepUpToken);
      const result = await this.store.tx(async (q) => {
        await this.store.lockComponent(component.id, q);
        const { release: after, changed } = await this.store.withdrawRelease(release.id, q).catch((e: unknown) => {
          if (e instanceof ReleaseStoreError && e.code === 'invariant_violation') throw WOULD_BREAK_MINIMUM();
          if (e instanceof ReleaseStoreError && e.code === 'invalid_transition') throw adminError(409, 'invalid_transition', 'This release cannot be withdrawn.');
          throw e;
        });
        if (changed) await this.audit.withdrawn(q, after, component, owner.userId);
        return { after, changed };
      });
      this.outcome('withdraw', owner, result.changed ? 'changed' : 'unchanged', `release=${release.id}`);
      const r = result.after;
      return {
        id: r.id, product, component: component.key, kind: component.kind, version: r.version, status: r.status, publishedAt: r.publishedAt?.toISOString() ?? null,
        withdrawnAt: r.withdrawnAt?.toISOString() ?? null, changed: result.changed,
      };
    });
  }

  async changePolicy(owner: VerifiedOwner, product: string, componentKey: string, input: PolicyChangeInput, stepUpToken: string | undefined): Promise<PolicyView> {
    return this.run('policy_change', owner, async () => {
      if (!REGISTRY_KEY.test(product) || !REGISTRY_KEY.test(componentKey)) throw INVALID('The product or component key');
      if (!isCanonicalVersion(input.minimumVersion)) throw INVALID('The minimum version');
      if (!isStableVersion(input.minimumVersion)) throw adminError(400, 'validation_error', 'A minimum version has no pre-release tag.');
      if (!Number.isSafeInteger(input.expectedPolicyVersion) || input.expectedPolicyVersion < 0 || input.expectedPolicyVersion >= MAX_POLICY_VERSION) {
        throw INVALID('The expected policy version');
      }
      const component = await this.store.findComponent(product, componentKey);
      if (!component) throw adminError(404, 'component_not_found', 'No such component.');
      if (component.kind === 'backend') throw adminError(409, 'policy_not_applicable', 'A backend component has no compatibility policy.');
      const current = await this.store.currentPolicy(component.id);
      const noop = current?.minimumVersion === input.minimumVersion;
      if (!noop) {
        if ((current?.policyVersion ?? 0) !== input.expectedPolicyVersion) throw POLICY_CONFLICT();
        await this.minimumRelease(component.id, input.minimumVersion); // 409 unless a published, not-withdrawn release of THIS component
      }
      await this.stepUp(owner, 'compatibility_policy.change', stepUpToken);
      if (noop) {
        this.outcome('policy_change', owner, 'unchanged', `component=${component.id}`);
        return this.policyView(product, component, current!, false);
      }
      const committed = await this.store.tx(async (q) => {
        await this.store.lockComponent(component.id, q);
        // Re-read under the lock: a withdrawal of the designated release, or another change, may have committed meanwhile.
        const now = await this.store.currentPolicy(component.id, q);
        if (now?.minimumVersion === input.minimumVersion) return { policy: now, changed: false };
        const target = await this.minimumRelease(component.id, input.minimumVersion, q);
        const previous = now ? await this.store.findRelease(component.id, now.minimumVersion, q) : null;
        const policy = await this.store.appendPolicy(component.id, input.expectedPolicyVersion, input.minimumVersion, q).catch((e: unknown) => {
          if (e instanceof ReleaseStoreError && e.code === 'policy_conflict') throw POLICY_CONFLICT();
          if (e instanceof ReleaseStoreError && e.code === 'invariant_violation') throw adminError(409, 'minimum_above_latest', 'The minimum would exceed the latest published release.');
          throw e;
        });
        await this.audit.policyChanged(q, {
          component, policy, previousPolicyVersion: input.expectedPolicyVersion, minimumReleaseId: target.id, previousMinimumReleaseId: previous?.id ?? null,
        }, owner.userId);
        return { policy, changed: true };
      });
      this.outcome('policy_change', owner, committed.changed ? 'changed' : 'unchanged', `component=${component.id} policyVersion=${committed.policy.policyVersion}`);
      return this.policyView(product, component, committed.policy, committed.changed);
    });
  }

  /** The release a minimum designates: it must exist in THIS component, be published and not withdrawn (a stable version, checked before). */
  private async minimumRelease(componentId: string, version: string, q?: Parameters<ReleaseStore['findRelease']>[2]): Promise<Release> {
    const r = await this.store.findRelease(componentId, version, q);
    if (!r || r.status !== 'published') {
      throw adminError(409, 'invalid_minimum', 'The minimum must be a published, not withdrawn, release of this component.');
    }
    return r;
  }

  /** Verifies and consumes the owner's step-up through Auth, under the request's Auth budget. A malformed proof never reaches Auth. */
  private async stepUp(owner: VerifiedOwner, purpose: ReleaseStepUpPurpose, token: string | undefined): Promise<void> {
    if (typeof token !== 'string' || !STEP_UP_TOKEN.test(token)) throw STEP_UP_REQUIRED();
    if (!(await this.auth.consumeStepUp(owner.bearer, purpose, token, owner.deadline))) throw STEP_UP_REQUIRED();
  }

  private policyView(product: string, component: Component, p: { policyVersion: number; minimumVersion: string; createdAt: Date }, changed: boolean): PolicyView {
    return { product, component: component.key, kind: component.kind, policyVersion: p.policyVersion, minimumVersion: p.minimumVersion, createdAt: p.createdAt.toISOString(), changed };
  }

  /** Classifies every refusal into ONE bounded outcome line; a database or outbox failure stays an opaque 500 (the kit filter). */
  private async run<T>(operation: Operation, owner: VerifiedOwner, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AuthDependencyError) this.outcome(operation, owner, e.failure);
      else if (e instanceof HttpException) {
        const status = e.getStatus();
        const code = (e.getResponse() as { code?: string }).code;
        this.outcome(operation, owner, code === 'step_up_required' ? 'step_up_denied' : status === 401 ? 'unauthenticated' : status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'invalid',
          code ? `code=${code}` : undefined);
      } else {
        this.counters.admin.count(operation, 'failed');
        this.log.error(`release_admin_failed operation=${operation} actor=${owner.userId} error=${e instanceof ReleaseStoreError ? e.code : e instanceof Error ? e.name : 'error'}`);
      }
      throw e;
    }
  }

  /** One line per decided request. Bounded fields only: the operation, the outcome class, the verified owner's id, a UUID / small integer. */
  private outcome(operation: Operation, owner: VerifiedOwner, outcome: Outcome, detail?: string): void {
    this.counters.admin.count(operation, outcome);
    this.log.log(`release_admin operation=${operation} outcome=${outcome} actor=${owner.userId}${detail ? ` ${detail}` : ''}`);
  }
}

const WOULD_BREAK_MINIMUM = () =>
  adminError(409, 'would_break_minimum', 'Withdrawing this release would leave the minimum version above the latest release; lower the minimum first.');
const POLICY_CONFLICT = () => adminError(409, 'policy_conflict', 'The policy changed since you read it; read it again.');
