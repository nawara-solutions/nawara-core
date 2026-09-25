import type { AuditCategory, AuditOutcome } from '@nawara/audit-contract';

/**
 * The typed query model of Stage 18.6. An `AuthorizedAuditQuery` is the ONLY input the repository accepts: its scope and its policy bounds
 * are built from the authenticated caller and its `AUDIT_SERVICE_POLICY` entry (never from request values); the request contributes only
 * narrowing filters, the time window, the page size and the cursor position — each validated against a closed grammar first.
 */

/** Where the records may come from. Built by the server from the route and the caller's capability, never from a query parameter. */
export type QueryScope =
  /** `read_organization`: exactly the organization in the path; platform-level (null) records never. */
  | { kind: 'organization'; organizationId: string }
  /** `read_platform`: every organization and platform-level records, optionally narrowed to one organization or to platform-level only. */
  | { kind: 'platform'; target: 'all' }
  | { kind: 'platform'; target: 'organization'; organizationId: string }
  | { kind: 'platform'; target: 'platform' };

/** Request filters: every one narrows (AND). All optional. */
export interface QueryFilters {
  action?: string;
  category?: AuditCategory;
  actor?: { type: string; id: string };
  resource?: { type: string; id: string };
  subject?: { type: string; id: string };
  sourceService?: string;
  outcome?: AuditOutcome;
  correlationId?: string;
}

/** A keyset position: `occurredAt` in epoch MICROseconds (the column's precision) and the internal row id (never exposed as identity). */
export interface CursorPosition {
  occurredAtUs: string;
  id: string;
}

export interface AuthorizedAuditQuery {
  scope: QueryScope;
  /** From the caller policy, injected into the SQL whatever the request says: the categories and, when set, the source services. */
  policy: { categories: readonly AuditCategory[]; sourceServices?: readonly string[] };
  filters: QueryFilters;
  /** Half-open on `occurredAt`: `from <= occurredAt < to`. */
  window: { from: Date; to: Date };
  limit: number;
  after?: CursorPosition;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
/** A66: an organization-scope window is at most 92 days, a platform-scope window at most 31. */
export const MAX_WINDOW_MS = { organization: 92 * 86_400_000, platform: 31 * 86_400_000 } as const;
