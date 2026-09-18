import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, type Queryable } from '../db/db.service.js';

export interface AuditEvent {
  /** dotted lowercase, e.g. "owner.login" — matches the DB CHECK on auth_audit_event.type */
  type: string;
  outcome: 'success' | 'failure' | 'denied';
  actorId?: string | null;
  targetId?: string | null;
  sessionFamilyId?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

// Any metadata key that even smells like a credential is dropped, whatever its value.
const FORBIDDEN_KEY = /(pass|secret|code|token|key|assert|challenge|credential|otp|proof|cookie|authorization|hash)/i;

export function sanitizeMetadata(meta: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (FORBIDDEN_KEY.test(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= 120) out[k] = v;
  }
  return out;
}

/** Security audit trail (append-only in the DB). Never receives credentials, by construction. */
@Injectable()
export class AuditService {
  private readonly log = new Logger('audit');
  constructor(@Inject(DbService) private readonly db: DbService) {}

  record(e: AuditEvent, q: Queryable = this.db) {
    return q.query(
      `INSERT INTO auth_audit_event(type, outcome, "actorId", "targetId", "sessionFamilyId", ip, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [e.type, e.outcome, e.actorId ?? null, e.targetId ?? null, e.sessionFamilyId ?? null, e.ip ?? null, JSON.stringify(sanitizeMetadata(e.metadata))],
    );
  }

  /** For failure paths: an audit outage must not turn a clean 401 into a 500. Logs type only. */
  async tryRecord(e: AuditEvent, q?: Queryable) {
    try {
      await this.record(e, q);
    } catch {
      this.log.error(`failed to record audit event ${e.type}`);
    }
  }
}
