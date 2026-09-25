import { createHash } from 'node:crypto';
import { Global, Inject, Injectable, Logger, Module, type DynamicModule } from '@nestjs/common';
import { AuditEventWriter } from '@nawara/audit-contract';
import { ConfigError, DbService, EventsModule, InMemoryEventBus, OutboxService, RabbitMqEventBus, type EventBus, type Queryable } from '@nawara/service-kit';
import { SERVICE_NAME, type FileConfig } from '../config/file-config.js';

/** The integrity faults the catalog names (`file.integrity_incident` reason). */
export type IntegrityReason = 'digest_mismatch' | 'size_mismatch' | 'object_missing';
/** Who detected it: a download verifying the bytes it serves, or the operator reconciliation tool (A9 system actors). */
export type IntegrityDetector = 'file_download_integrity_check' | 'file_reconciliation';

/** The persisted facts an audit event is built from: the file row itself, never a request value. */
export interface AuditedFile {
  id: string;
  organizationId: string | null;
}

// Arbitrary, fixed namespace for File's deterministically derived audit event ids (RFC 4122 §4.3).
const NAMESPACE = Buffer.from('6d1f0c9a2b3e4f5a8b7c6d5e4f3a2b1c', 'hex');

/** A version-5 UUID of the parts: the same incident always has the same event id. */
export function deterministicEventId(...parts: string[]): string {
  const hash = createHash('sha1').update(Buffer.concat([NAMESPACE, Buffer.from(parts.join(':'), 'utf8')])).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Central audit intent of File's two catalog actions (Stage 18.7.4), through `AuditEventWriter` into the kit outbox:
 * - `file.deleted`: ON THE DELETION REQUEST'S TRANSACTION (the `AVAILABLE` → `DELETING` transition that makes the loss irreversible:
 *   tickets revoked, access gone at commit). Written only on that transition: a repeated request (already DELETING / DELETED) writes
 *   nothing. The actor is the authenticated owner service; the organization is the file row's.
 * - `file.integrity_incident`: a detection changes no row, so its evidence is the only thing written, in its own short transaction.
 *   The event id derives from (file, reason): the same fault seen by a thousand downloads and every reconciliation run is ONE record
 *   (the outbox keeps its rows, so the id stays taken).
 */
@Injectable()
export class FileAudit {
  private readonly writer: AuditEventWriter<Queryable>;

  constructor(@Inject(OutboxService) outbox: OutboxService) {
    this.writer = new AuditEventWriter({ sourceService: SERVICE_NAME, outbox });
  }

  async deleted(q: Queryable, file: AuditedFile, ownerService: string): Promise<void> {
    await this.writer.write(q, {
      action: 'file.deleted', actor: { type: 'service', id: ownerService }, organizationId: file.organizationId, resource: { type: 'file', id: file.id }, outcome: 'succeeded',
    }, { eventId: deterministicEventId(file.id, 'audit.file.deleted') });
  }

  async integrityIncident(q: Queryable, file: AuditedFile, detector: IntegrityDetector, reason: IntegrityReason): Promise<void> {
    await this.writer.write(q, {
      action: 'file.integrity_incident', actor: { type: 'system', id: detector }, organizationId: file.organizationId, resource: { type: 'file', id: file.id },
      outcome: 'succeeded', changes: { reason },
    }, { eventId: deterministicEventId(file.id, 'audit.file.integrity_incident', reason) });
  }
}

/**
 * The download path's recorder: the response is already a failure (or already destroyed) when an incident is found, so recording it
 * must not change what the client sees. A write that fails is logged by id and reason (the counter and the warning line of Stage 17.9
 * still record the fault); the next detection of the same fault writes it (same event id).
 */
@Injectable()
export class IntegrityIncidents {
  private readonly logger = new Logger('FileAudit');

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(FileAudit) private readonly audit: FileAudit,
  ) {}

  async detected(file: AuditedFile, reason: IntegrityReason): Promise<void> {
    try {
      await this.db.tx((q) => this.audit.integrityIncident(q, file, 'file_download_integrity_check', reason));
    } catch (e) {
      this.logger.warn(`file_audit_intent_failed file=${file.id} action=file.integrity_incident reason=${reason} error=${e instanceof Error ? e.name : 'error'}`);
    }
  }
}

export function eventBus(config: Pick<FileConfig, 'rabbitmqUrl' | 'rabbitmqConfirmTimeoutMs' | 'rabbitmqHeartbeatS' | 'isProduction'>): EventBus {
  if (config.rabbitmqUrl) {
    return new RabbitMqEventBus({
      url: config.rabbitmqUrl,
      confirmTimeoutMs: config.rabbitmqConfirmTimeoutMs,
      heartbeatS: config.rabbitmqHeartbeatS,
      onNotice: (message, level) => new Logger('RabbitMqEventBus')[level === 'info' ? 'log' : level](message),
    });
  }
  if (config.isProduction) throw new ConfigError('RABBITMQ_URL is required in production (the in-memory event bus is for development and tests only)');
  return new InMemoryEventBus();
}

/**
 * Stage 18.7.4: the ONE place file-service touches events. The kit `EventsModule` (outbox service + relay: started on bootstrap,
 * drained at shutdown start, the bus closed after, the pool last) publishes the audit outbox rows, including the ones the reconcile CLI
 * writes. There are no File domain events and nothing is consumed.
 */
@Global()
@Module({})
export class FileAuditModule {
  static forRoot(config: FileConfig, bus?: EventBus): DynamicModule {
    return {
      module: FileAuditModule,
      imports: [
        EventsModule.forRoot({
          source: SERVICE_NAME,
          bus: bus ?? eventBus(config),
          onError: (message) => new Logger('OutboxRelay').warn(message),
        }),
      ],
      providers: [FileAudit, IntegrityIncidents],
      exports: [FileAudit, IntegrityIncidents],
    };
  }
}
