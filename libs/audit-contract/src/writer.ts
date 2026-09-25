import { actionsOwnedBy, type AuditAction, type AuditChangesOf, type AuditOutcomeOf, type AuditResourceTypeOf, type AuditSubjectOf } from './catalog.js';
import { AUDIT_CONTRACT_VERSION, type AuditActor } from './contract.js';
import { AuditContractError, refuse } from './errors.js';
import { CORRELATION_ID, EVENT_TYPE_PREFIX, SERVICE_NAME, UUID } from './grammar.js';
import { validateAuditPayload } from './validate.js';

/** The one call a producer's business transaction must support (the kit `Queryable` satisfies it). */
export interface AuditQueryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** The kit `NewEvent` shape (`libs/service-kit/src/events/outbox.service.ts`). */
export interface AuditOutboxEvent {
  name: string;
  payload: Record<string, unknown>;
  id?: string;
  version?: number;
  correlationId?: string;
}

/** The kit `OutboxService` (a structural port: this package has no runtime dependency on the kit). */
export interface AuditOutbox<Q> {
  enqueue(q: Q, event: AuditOutboxEvent): Promise<string>;
}

/** What a producer supplies for one action, typed from the catalog. No source, category, event type, version or time: those are derived. */
export type AuditEventInput<A extends AuditAction = AuditAction> = A extends AuditAction
  ? {
      action: A;
      actor: AuditActor;
      organizationId: string | null;
      resource: { type: AuditResourceTypeOf<A>; id: string };
      subject?: AuditSubjectOf<A>;
      outcome: AuditOutcomeOf<A>;
      changes?: AuditChangesOf<A>;
      causationId?: string;
    }
  : never;

export interface AuditWriteOptions {
  /**
   * A UUID the producer chose for this event, to make a RETRIED business operation write the same event once (the kit outbox ignores
   * a second row with the same id). Omitted = a new UUID from the outbox. Never a correlation id, never derived from a timestamp.
   */
  eventId?: string;
  /** Overrides the ambient request correlation id (the kit default). Navigation only, never evidence. */
  correlationId?: string;
}

export interface AuditWriteResult {
  eventId: string;
  eventType: string;
}

const SAVEPOINT = 'nawara_audit_intent';

function sqlState(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : undefined;
}

/**
 * The producer helper: the ONLY way a Core service should create audit intent. It records one catalog-valid audit event in the kit
 * outbox ON THE CALLER'S TRANSACTION, so the business change and its audit intent commit or roll back together (ADR-0049 A17, A18).
 *
 * - The source service is fixed at construction from the service's own configuration (the same name its outbox relay stamps as the
 *   envelope `source`); an event cannot name another source.
 * - The category, event type (`audit.<action>`) and version come from the catalog and this package, never from the caller.
 * - `occurredAt` is the outbox row's `now()`: the business transaction's database time.
 * - It never opens a transaction, never commits, never publishes: the relay publishes after COMMIT. A client that is not inside an open
 *   transaction block (a pool, an autocommit connection) is refused with `transaction_required` before anything is written.
 *
 * It validates structure, ownership and metadata policy. It cannot prove the business truth of the event (that the actor was
 * authorized, that the organization is the resource's): that is the producing service's duty.
 */
export class AuditEventWriter<Q extends AuditQueryable> {
  readonly sourceService: string;
  private readonly outbox: AuditOutbox<Q>;

  constructor(options: { sourceService: string; outbox: AuditOutbox<Q> }) {
    if (typeof options.sourceService !== 'string' || !SERVICE_NAME.test(options.sourceService) || actionsOwnedBy(options.sourceService).length === 0) {
      throw new AuditContractError('producer_not_admitted');
    }
    this.sourceService = options.sourceService;
    this.outbox = options.outbox;
    Object.freeze(this);
  }

  async write<A extends AuditAction>(tx: Q, event: AuditEventInput<A>, options: AuditWriteOptions = {}): Promise<AuditWriteResult> {
    const payload = validateAuditPayload(event, this.sourceService);
    const { eventId, correlationId } = options;
    if (eventId !== undefined && (typeof eventId !== 'string' || !UUID.test(eventId))) refuse('invalid_envelope');
    if (eventId !== undefined && payload.causationId === eventId) refuse('invalid_causation');
    if (correlationId !== undefined && (typeof correlationId !== 'string' || !CORRELATION_ID.test(correlationId))) refuse('invalid_correlation');

    await requireTransaction(tx);
    const eventType = `${EVENT_TYPE_PREFIX}${payload.action}`;
    const id = await this.outbox.enqueue(tx, {
      name: eventType,
      payload: { ...payload },
      version: AUDIT_CONTRACT_VERSION,
      ...(eventId !== undefined ? { id: eventId } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
    });
    return { eventId: id, eventType };
  }
}

/** A SAVEPOINT is refused (SQLSTATE 25P01) outside a transaction block: the reliable test that `tx` is the caller's open transaction. */
async function requireTransaction(tx: AuditQueryable): Promise<void> {
  try {
    await tx.query(`SAVEPOINT ${SAVEPOINT}`);
  } catch (e) {
    if (sqlState(e) === '25P01') refuse('transaction_required');
    throw e;
  }
  await tx.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
}
