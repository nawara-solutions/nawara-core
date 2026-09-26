import { createHash, createHmac } from 'node:crypto';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { RateLimitService } from '@nawara/service-kit';
import type { ReleaseConfig } from '../config/release-config.js';
import { RELEASE_CONFIG } from '../config/release-config.token.js';
import { REGISTRY_KEY } from '../domain/model.js';
import { isCanonicalVersion } from '../domain/version.js';
import { ReleaseStore } from '../persistence/release-store.js';
import { CompatibilityCounters, type CompatibilityOutcome } from './compatibility-counters.js';
import { COMPATIBILITY_BUCKET, COMPATIBILITY_WINDOW_S } from './compatibility-ops.js';
import { decide, type CompatibilityState, type Decision } from './decision.js';

const inputError = (status: number, code: string, message: string) => new HttpException({ message, code }, status);

export type CompatibilityAnswer = { kind: 'decision'; decision: Decision; etag: string } | { kind: 'not_modified'; etag: string };

/**
 * A strong validator over exactly the state the answer depends on: the component, the client's release and its status (withdrawal), the
 * current policy version (the minimum), the latest release (a new publication or a withdrawal of the latest). The same state gives the same
 * ETag on every instance; nothing else changes it (no identity, time, request or process value). The path (and so the version) is part of
 * the cache key already, and the release id binds the tag to it too.
 */
export function compatibilityEtag(s: CompatibilityState): string {
  const basis = ['rc1', s.component?.id, s.release?.id, s.release?.status, s.policy?.policyVersion ?? 0, s.latest?.id ?? '-'].join('|');
  return `"${createHash('sha256').update(basis).digest('base64url').slice(0, 27)}"`;
}

/** RFC 9110 If-None-Match: a list of entity tags or `*`; weak comparison (a `W/` prefix is ignored). */
export function matchesIfNoneMatch(header: string | string[] | undefined, etag: string): boolean {
  if (typeof header !== 'string' || header.length > 1024) return false;
  return header.split(',').map((t) => t.trim().replace(/^W\//, '')).some((t) => t === '*' || t === etag);
}

/**
 * Stage 20.5 (ADR-0051 decisions 7, 10): the public compatibility read. Read-only, unauthenticated (clients may be pre-login), no user,
 * device or organization input, and no call to any other service. In order:
 * 1. the public rate limit, BEFORE any validation (malformed requests are counted too), keyed by the client address HMAC-keyed with
 *    `RELEASE_RATE_LIMIT_KEY` (the address honours TRUST_PROXY only; no request header chooses the key);
 * 2. input: only the `version` query parameter; a malformed or non-canonical version is `invalid_version` (400); a malformed key cannot name a
 *    component, so it is `unknown_component` (404) without a query;
 * 3. ONE statement reads the committed state (one snapshot), then `decide` (pure, deterministic).
 * Nothing is written except the limiter counter; no audit event (a read is not an administrative mutation).
 */
@Injectable()
export class CompatibilityService {
  constructor(
    @Inject(RELEASE_CONFIG) private readonly config: ReleaseConfig,
    @Inject(ReleaseStore) private readonly store: ReleaseStore,
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
    @Inject(CompatibilityCounters) private readonly counters: CompatibilityCounters,
  ) {}

  async answer(req: Request, product: string, component: string): Promise<CompatibilityAnswer> {
    const t0 = performance.now();
    const done = (outcome: CompatibilityOutcome) => this.counters.count(outcome, performance.now() - t0);
    try {
      const client = createHmac('sha256', this.config.compatibility.rateLimitKey).update(req.ip ?? req.socket.remoteAddress ?? 'unknown').digest('hex');
      const rule = { limit: this.config.compatibility.ratePerClient, windowSec: COMPATIBILITY_WINDOW_S };
      if (!(await this.limiter.hit(COMPATIBILITY_BUCKET, client, rule)).allowed) {
        done('rate_limited');
        throw inputError(429, 'rate_limited', 'Too many requests.');
      }
      const keys = Object.keys(req.query);
      if (keys.some((k) => k !== 'version')) {
        done('invalid_request');
        throw inputError(400, 'validation_error', 'Only the version query parameter is accepted.');
      }
      const version = req.query.version;
      if (typeof version !== 'string' || !isCanonicalVersion(version)) {
        done('invalid_version');
        throw inputError(400, 'invalid_version', 'The version is not a canonical release version.');
      }
      if (!REGISTRY_KEY.test(product) || !REGISTRY_KEY.test(component)) {
        done('unknown_component');
        throw inputError(404, 'unknown_component', 'No such client component.');
      }
      const state = await this.store.compatibilityState(product, component, version);
      const decision = decide(version, state);
      if (decision === 'unknown_component') {
        done('unknown_component');
        throw inputError(404, 'unknown_component', 'No such client component.');
      }
      if (decision === 'unknown_release' || decision === 'invalid_version') {
        done('unknown_release');
        throw inputError(404, 'unknown_release', 'This version is not a registered release of the component.');
      }
      const etag = compatibilityEtag(state);
      if (matchesIfNoneMatch(req.headers['if-none-match'], etag)) {
        done('not_modified');
        return { kind: 'not_modified', etag };
      }
      done(decision.update === 'required' ? (decision.reason === 'withdrawn' ? 'required_withdrawn' : 'required_below_minimum') : decision.update);
      return { kind: 'decision', decision, etag };
    } catch (e) {
      if (!(e instanceof HttpException)) done('failed');
      throw e;
    }
  }
}
