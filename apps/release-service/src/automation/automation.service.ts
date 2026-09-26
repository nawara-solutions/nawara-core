import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { ReleaseAudit } from '../audit/release-audit.js';
import type { ReleaseConfig } from '../config/release-config.js';
import { RELEASE_CONFIG } from '../config/release-config.token.js';
import { REGISTRY_KEY, type Component, type ComponentKind, type Release } from '../domain/model.js';
import { isCanonicalVersion } from '../domain/version.js';
import { ReleaseStoreError } from '../persistence/persistence-error.js';
import { ReleaseStore } from '../persistence/release-store.js';
import type { ReleaseCapability } from '../policy/caller-policy.js';
import { authorizationDenial, denialError } from '../policy/release-policy.guard.js';

export const releaseError = (status: number, code: string, message: string) => new HttpException({ message, code }, status);
const RELEASE_NOT_FOUND = () => releaseError(404, 'release_not_found', 'No such release.');
const INVALID = (what: string) => releaseError(400, 'validation_error', `${what} is invalid.`);

/** What CI declares when it registers a build. Exactly the Stage 20.2 release identity plus the component's kind; nothing else. */
export interface RegisterReleaseInput {
  kind: ComponentKind;
  version: string;
  buildId?: string | null;
  sourceRevision?: string | null;
  notesRef?: string | null;
}

/** The representation returned to the (authorized) caller: its own product's release. */
export interface ReleaseView {
  id: string;
  product: string;
  component: string;
  kind: ComponentKind;
  version: string;
  buildId: string | null;
  sourceRevision: string | null;
  notesRef: string | null;
  status: Release['status'];
  registeredAt: string;
  publishedAt: string | null;
  withdrawnAt: string | null;
}

/** `changed: false` = the request was an idempotent retry: nothing was written, no audit intent was recorded. */
export interface AutomationResult {
  release: ReleaseView;
  changed: boolean;
}

type Operation = 'register' | 'publish';
/** Bounded outcome classes for the one operational line per decided request (no version, build id, product key or correlation id). */
type Outcome = 'created' | 'published' | 'unchanged' | 'invalid' | 'not_found' | 'conflict';

const view = (product: string, component: Component, r: Release): ReleaseView => ({
  id: r.id, product, component: component.key, kind: component.kind, version: r.version, buildId: r.buildId, sourceRevision: r.sourceRevision,
  notesRef: r.notesRef, status: r.status, registeredAt: r.registeredAt.toISOString(), publishedAt: r.publishedAt?.toISOString() ?? null,
  withdrawnAt: r.withdrawnAt?.toISOString() ?? null,
});

/**
 * Stage 20.3 (ADR-0051 §8, §9, §11): release registration and publication by CI automation, a SERVICE identity with a narrow per-product
 * policy. Never a human, never an owner or operator: a user bearer is not a service token and never reaches this code.
 *
 * Each operation, in order:
 * 1. authorization from the authenticated caller name only (`ReleasePolicyGuard`, after the token guard; re-asserted here): the capability
 *    (`operation_not_allowed`), then the product (`product_not_allowed`). Both are 403 and are decided from configuration alone, BEFORE
 *    any lookup, so an unauthorized caller learns nothing about which products, components or releases exist (an unknown product and a
 *    forbidden one are the same answer);
 * 2. input validation (`validation_error`);
 * 3. ONE transaction: the domain change and, only if a row actually changed, its audit intent (the outbox). Either both commit or neither.
 *
 * Idempotency is the natural identity (ADR-0051 §11: "CI retries, idempotent on (component, version)"): the same registration again, or
 * a publication of an already-published release, changes nothing, writes no evidence and answers the current state. A registration
 * that reuses a version with a different identity is a conflict and never overwrites; a publication of a withdrawn release is refused.
 */
@Injectable()
export class AutomationService {
  private readonly log = new Logger('ReleaseAutomation');

  constructor(
    @Inject(RELEASE_CONFIG) private readonly config: ReleaseConfig,
    @Inject(ReleaseStore) private readonly store: ReleaseStore,
    @Inject(ReleaseAudit) private readonly audit: ReleaseAudit,
  ) {}

  async register(caller: string, product: string, componentKey: string, input: RegisterReleaseInput): Promise<AutomationResult> {
    this.authorize(caller, product, 'release.register');
    if (!REGISTRY_KEY.test(componentKey)) return this.refuse('register', caller, 'invalid', INVALID('The component key'));
    if (!isCanonicalVersion(input.version)) return this.refuse('register', caller, 'invalid', INVALID('The version'));
    try {
      const result = await this.store.tx(async (q) => {
        const p = await this.store.ensureProduct(product, q);
        const component = await this.store.ensureComponent(p.id, componentKey, input.kind, q).catch((e: unknown) => {
          throw e instanceof ReleaseStoreError && e.code === 'conflict' ? releaseError(409, 'component_kind_conflict', 'The component exists with another kind.') : e;
        });
        const identity = { componentId: component.id, version: input.version, buildId: input.buildId ?? null, sourceRevision: input.sourceRevision ?? null, notesRef: input.notesRef ?? null };
        const { release, created } = await this.store.registerRelease(identity, q).catch((e: unknown) => {
          throw e instanceof ReleaseStoreError && e.code === 'conflict' ? releaseError(409, 'release_conflict', 'This version is registered with a different identity.') : e;
        });
        if (created) await this.audit.registered(q, release, component, caller);
        return { release: view(product, component, release), changed: created };
      });
      this.outcome('register', caller, result.changed ? 'created' : 'unchanged', result.release.id);
      return result;
    } catch (e) {
      throw this.failed('register', caller, e);
    }
  }

  async publish(caller: string, product: string, componentKey: string, version: string): Promise<AutomationResult> {
    this.authorize(caller, product, 'release.publish');
    if (!REGISTRY_KEY.test(componentKey)) return this.refuse('publish', caller, 'invalid', INVALID('The component key'));
    if (!isCanonicalVersion(version)) return this.refuse('publish', caller, 'invalid', INVALID('The version'));
    try {
      const result = await this.store.tx(async (q) => {
        const component = await this.store.findComponent(product, componentKey, q);
        const found = component ? await this.store.findRelease(component.id, version, q) : null;
        if (!component || !found) throw RELEASE_NOT_FOUND(); // unknown product, component or version: one answer
        const { release, changed } = await this.store.publishRelease(found.id, q).catch((e: unknown) => {
          throw e instanceof ReleaseStoreError && e.code === 'invalid_transition' ? releaseError(409, 'invalid_transition', `A ${found.status} release cannot be published.`) : e;
        });
        if (changed) await this.audit.published(q, release, component, caller);
        return { release: view(product, component, release), changed };
      });
      this.outcome('publish', caller, result.changed ? 'published' : 'unchanged', result.release.id);
      return result;
    } catch (e) {
      throw this.failed('publish', caller, e);
    }
  }

  /**
   * Defense in depth: the route's `ReleasePolicyGuard` already decided (and logged) this before the body was even validated; the same
   * decision is re-asserted here so the operation can never run for a caller without authority, whatever calls it.
   */
  private authorize(caller: string, product: string, capability: ReleaseCapability): void {
    const reason = authorizationDenial(this.config.callerPolicy, caller, product, capability);
    if (reason !== null) throw denialError(reason);
  }

  private refuse(operation: Operation, caller: string, outcome: Outcome, error: HttpException): never {
    this.outcome(operation, caller, outcome);
    throw error;
  }

  /** Maps a failure to its bounded answer. A database / outbox failure stays an opaque 500 (the kit filter), and is logged by class only. */
  private failed(operation: Operation, caller: string, e: unknown): unknown {
    if (e instanceof HttpException) {
      const status = e.getStatus();
      this.outcome(operation, caller, status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'invalid');
      return e;
    }
    if (e instanceof ReleaseStoreError && e.code === 'invalid') {
      this.outcome(operation, caller, 'invalid');
      return INVALID('The release');
    }
    this.log.error(`release_automation_failed operation=${operation} caller=${caller} error=${e instanceof ReleaseStoreError ? e.code : e instanceof Error ? e.name : 'error'}`);
    return e;
  }

  /**
   * One line per request that passed authorization (a refusal is `release_authorization_denied`, from the guard). Every field is bounded:
   * the operation, the outcome class, the configured caller name, a release UUID. Never a version, build id, product key or header.
   */
  private outcome(operation: Operation, caller: string, outcome: Outcome, releaseId?: string): void {
    this.log.log(`release_automation operation=${operation} outcome=${outcome} caller=${caller}${releaseId ? ` release=${releaseId}` : ''}`);
  }
}
