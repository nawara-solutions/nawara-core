import { HttpException, Logger } from '@nestjs/common';
import { ConfigError, type EnvReader } from '../config/config.js';
import { correlationHeaders } from '../context/request-context.js';

/**
 * Stage 21.C.2 (ADR-0052 decision 3, ADR-0042 decision 5, A.3, A.5 and Amendment 2): the client side of Organization Service's reference
 * read, `GET /organization/reference/organizations/:id`, which answers `{ organizationId, platformId, companyId }` (ids only) for an
 * Organization inside the CALLING service's Platform scope, a collapsed 404 otherwise, and 409 `not_authoritative` until Organization
 * Service is authoritative.
 *
 * TRANSPORT ONLY. It answers "which Platform and Company does this Organization belong to?" from the one hierarchy authority. Whether the
 * resolved Platform is inside a caller's scope is the consuming service's decision, never this module's. There is no other source: no
 * Auth fallback, no local copy, no switch that disables the lookup (AD-5). Anything the authority cannot answer is a 503: the caller fails
 * closed and writes nothing.
 */
export interface OrganizationReference {
  organizationId: string;
  platformId: string;
  companyId: string;
}

export interface OrganizationReferenceResolver {
  /**
   * The Organization's anchors, or null when Organization Service says it does not exist or is outside this service's own credential scope
   * (one collapsed answer). Throws `HierarchyUnavailableError` whenever the authority cannot answer.
   */
  resolve(organizationId: string): Promise<OrganizationReference | null>;
}

export const ORGANIZATION_REFERENCE = Symbol('ORGANIZATION_REFERENCE');

/** The hierarchy authority could not answer (not yet authoritative, down, slow, or an answer that is not its answer). Nothing was changed. */
export class HierarchyUnavailableError extends HttpException {
  constructor() {
    super({ message: 'The organization hierarchy could not be verified; nothing was changed. Retry later.', code: 'hierarchy_unavailable' }, 503);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The answer is three uuids; anything larger is not Organization Service's answer and is never buffered whole. */
export const MAX_REFERENCE_RESPONSE_BYTES = 4 * 1024;

export interface HttpOrganizationReferenceOptions {
  baseUrl: string;
  /** This service's OWN credential at Organization Service (never a caller's credential, never a user bearer). */
  serviceToken: string;
  timeoutMs?: number;
  /** Operational notices; each a complete `event key=value` line with no token, URL or body. */
  onNotice?: (message: string) => void;
}

/**
 * The hardened HTTP resolver: a bounded deadline, redirects never followed (the credential goes to the configured authority only), a
 * capped body read under the deadline, unread bodies released, and a strict shape check. Every failure is the same 503 to the caller; the
 * reason class is logged, never the token, the URL or Organization Service's body.
 */
export class HttpOrganizationReferenceClient implements OrganizationReferenceResolver {
  private readonly timeoutMs: number;
  private readonly notice: (message: string) => void;

  constructor(private readonly opts: HttpOrganizationReferenceOptions) {
    this.timeoutMs = opts.timeoutMs ?? 2000;
    const log = new Logger('OrganizationReference');
    this.notice = opts.onNotice ?? ((m) => log.warn(m));
  }

  private unavailable(reason: string): HierarchyUnavailableError {
    this.notice(`hierarchy_reference_unavailable reason=${reason}`);
    return new HierarchyUnavailableError();
  }

  async resolve(organizationId: string): Promise<OrganizationReference | null> {
    const id = organizationId.toLowerCase();
    if (!UUID.test(id)) return null; // not an organization id at all: nothing to ask
    const deadline = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}/organization/reference/organizations/${id}`, {
        headers: { authorization: `Bearer ${this.opts.serviceToken}`, accept: 'application/json', ...correlationHeaders() },
        redirect: 'manual',
        signal: deadline,
      });
    } catch {
      throw this.unavailable(deadline.aborted ? 'timeout' : 'network');
    }
    if (res.status === 404) {
      await release(res);
      return null;
    }
    if (res.status !== 200) {
      await release(res);
      if (res.status === 401 || res.status === 403) {
        this.notice(`hierarchy_reference_denied status=${res.status} — this service's reference credential or capability is not configured at Organization Service`);
        throw new HierarchyUnavailableError();
      }
      throw this.unavailable(res.status === 409 ? 'not_authoritative' : res.status >= 300 && res.status < 400 ? 'redirect_refused' : `status_${res.status}`);
    }
    let body: unknown;
    try {
      body = await readCapped(res, MAX_REFERENCE_RESPONSE_BYTES);
    } catch (e) {
      await release(res);
      throw this.unavailable(deadline.aborted ? 'timeout' : e instanceof Error && e.message === 'oversized' ? 'oversized' : 'malformed');
    }
    const b = body as Partial<OrganizationReference> | null;
    if (
      typeof b !== 'object' || b === null || typeof b.organizationId !== 'string' || typeof b.platformId !== 'string' || typeof b.companyId !== 'string'
      || !UUID.test(b.organizationId) || !UUID.test(b.platformId) || !UUID.test(b.companyId) || b.organizationId !== id
    ) {
      throw this.unavailable('malformed');
    }
    return { organizationId: b.organizationId, platformId: b.platformId, companyId: b.companyId };
  }
}

async function release(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

async function readCapped(res: Response, max: number): Promise<unknown> {
  if (Number(res.headers.get('content-length') ?? 0) > max) throw new Error('oversized');
  if (!res.body) throw new Error('malformed');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > max) throw new Error('oversized');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/**
 * The decision-5 memo (ADR-0042 Amendment 2): a POSITIVE answer may be reused while ids are never reused (I1) and anchors never change.
 * Process-local, bounded (least recently used is evicted), empty after a restart, never a negative answer, never a failure. It proves
 * identity and anchors only, not that an Organization is active. It is filled only from the authority's own positive answers, which exist
 * only once the authority is active, so it can never carry a pre-cutover or client-supplied hierarchy.
 */
export class MemoizedOrganizationReference implements OrganizationReferenceResolver {
  private readonly memo = new Map<string, OrganizationReference>();

  constructor(private readonly inner: OrganizationReferenceResolver, private readonly maxEntries = 10_000) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new ConfigError('the organization reference memo needs a positive bound');
  }

  async resolve(organizationId: string): Promise<OrganizationReference | null> {
    const id = organizationId.toLowerCase();
    const hit = this.memo.get(id);
    if (hit) {
      this.memo.delete(id); // refresh its recency
      this.memo.set(id, hit);
      return hit;
    }
    const r = await this.inner.resolve(id);
    if (r) {
      this.memo.set(id, r);
      if (this.memo.size > this.maxEntries) this.memo.delete(this.memo.keys().next().value as string);
    }
    return r;
  }

  get size(): number {
    return this.memo.size;
  }
}

/**
 * NON-PRODUCTION ONLY: a static map, for local runs and tests with no active Organization Service. Refused when the service runs in
 * production, so it can never stand in for the authority there. An id absent from the map is "unknown" (null), exactly like a 404.
 */
export class FixtureOrganizationReference implements OrganizationReferenceResolver {
  private readonly map: ReadonlyMap<string, OrganizationReference>;

  constructor(entries: readonly OrganizationReference[], isProduction: boolean) {
    if (isProduction) throw new ConfigError('the organization reference fixture is refused in production');
    for (const e of entries) {
      if (![e.organizationId, e.platformId, e.companyId].every((v) => typeof v === 'string' && UUID.test(v))) {
        throw new ConfigError('the organization reference fixture must list canonical lowercase uuids');
      }
    }
    this.map = new Map(entries.map((e) => [e.organizationId, { ...e }]));
  }

  async resolve(organizationId: string): Promise<OrganizationReference | null> {
    return this.map.get(organizationId.toLowerCase()) ?? null;
  }
}

/**
 * Parses `ORGANIZATION_REFERENCE_FIXTURE` (non-production only): `[{"organizationId":…,"platformId":…,"companyId":…}, …]`. Errors never echo
 * the value.
 */
export function parseOrganizationReferenceFixture(raw: string, isProduction: boolean): FixtureOrganizationReference {
  if (isProduction) throw new ConfigError('ORGANIZATION_REFERENCE_FIXTURE is refused in production');
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new ConfigError('ORGANIZATION_REFERENCE_FIXTURE must be valid JSON');
  }
  if (!Array.isArray(doc)) throw new ConfigError('ORGANIZATION_REFERENCE_FIXTURE must be a list of {organizationId, platformId, companyId}');
  const entries = doc.map((e: unknown) => {
    const o = e as Record<string, unknown> | null;
    if (typeof o !== 'object' || o === null || Object.keys(o).sort().join(',') !== 'companyId,organizationId,platformId') {
      throw new ConfigError('ORGANIZATION_REFERENCE_FIXTURE entries must be exactly {organizationId, platformId, companyId}');
    }
    return o as unknown as OrganizationReference;
  });
  return new FixtureOrganizationReference(entries, isProduction);
}

/**
 * Where a service resolves an asserted Organization. `http`: Organization Service's reference read with the service's OWN credential
 * (required in production). `fixture`: a static map, non-production only. `none` (non-production only): nothing can answer, so every
 * Organization-bearing operation fails closed (503 hierarchy_unavailable).
 */
export type OrganizationReferenceConfig =
  | { kind: 'http'; baseUrl: string; token: string; timeoutMs: number }
  | { kind: 'fixture'; fixture: string }
  | { kind: 'none' };

/**
 * Reads `ORGANIZATION_SERVICE_URL`, `ORGANIZATION_REFERENCE_TOKEN`, `ORGANIZATION_REFERENCE_TIMEOUT_MS` and (non-production only)
 * `ORGANIZATION_REFERENCE_FIXTURE`. Production requires the first two and refuses the fixture: Organization verification has no bypass
 * (ADR-0042 AD-5). Errors never echo a value.
 */
export function loadOrganizationReferenceConfig(
  reader: EnvReader,
  isProduction: boolean,
  /** false only for a service whose policy admits no caller that could name an Organization (nothing could ever be verified). */
  requiredInProduction = true,
): OrganizationReferenceConfig {
  const url = reader.optional('ORGANIZATION_SERVICE_URL');
  const hasToken = reader.get('ORGANIZATION_REFERENCE_TOKEN') !== undefined;
  const fixture = reader.optional('ORGANIZATION_REFERENCE_FIXTURE');
  if (fixture !== undefined) {
    if (isProduction) throw new ConfigError('ORGANIZATION_REFERENCE_FIXTURE is refused in production (Organization verification has no bypass)');
    if (url !== undefined || hasToken) throw new ConfigError('ORGANIZATION_REFERENCE_FIXTURE cannot be combined with ORGANIZATION_SERVICE_URL / ORGANIZATION_REFERENCE_TOKEN');
    parseOrganizationReferenceFixture(fixture, isProduction); // validated at startup, not at the first request
    return { kind: 'fixture', fixture };
  }
  if (url === undefined && !hasToken) {
    if (isProduction && requiredInProduction) throw new ConfigError('ORGANIZATION_SERVICE_URL and ORGANIZATION_REFERENCE_TOKEN are required in production (Organization verification)');
    return { kind: 'none' };
  }
  if (url === undefined || !hasToken) throw new ConfigError('ORGANIZATION_SERVICE_URL and ORGANIZATION_REFERENCE_TOKEN must be set together');
  return {
    kind: 'http',
    baseUrl: reader.url('ORGANIZATION_SERVICE_URL', ['http:', 'https:']),
    token: reader.secret('ORGANIZATION_REFERENCE_TOKEN', 32),
    timeoutMs: reader.int('ORGANIZATION_REFERENCE_TIMEOUT_MS', { default: 2000, min: 100, max: 10_000 }),
  };
}

/** Nothing can answer (non-production with no reference configured): every lookup fails closed. */
export const unavailableOrganizationReference: OrganizationReferenceResolver = {
  resolve: async () => {
    throw new HierarchyUnavailableError();
  },
};

/** The resolver a service runs with: the configured source behind the positive memo. */
export function buildOrganizationReference(config: OrganizationReferenceConfig, isProduction: boolean, memoEntries = 10_000): OrganizationReferenceResolver {
  const inner = config.kind === 'http'
    ? new HttpOrganizationReferenceClient({ baseUrl: config.baseUrl, serviceToken: config.token, timeoutMs: config.timeoutMs })
    : config.kind === 'fixture'
      ? parseOrganizationReferenceFixture(config.fixture, isProduction)
      : unavailableOrganizationReference; // fails closed on every lookup (in production only reachable when no caller could look anything up)
  return new MemoizedOrganizationReference(inner, memoEntries);
}
