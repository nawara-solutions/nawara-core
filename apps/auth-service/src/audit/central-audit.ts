import { Global, Inject, Injectable, Logger, Module, type DynamicModule } from '@nestjs/common';
import { AuditEventWriter, type AuditAction, type AuditEventInput, type AuditWriteOptions } from '@nawara/audit-contract';
import {
  DbService as KitDbService, EventsModule as KitEventsModule, InMemoryEventBus, OutboxService, RabbitMqEventBus, type EventBus,
} from '@nawara/service-kit';
import { APP_CONFIG, ConfigError, type AppConfig } from '../config/app-config.js';
import { DbService, type Queryable } from '../db/db.service.js';

/** The ONE identity of Auth as a producer: the relay stamps it as `source`, the audit writer is bound to it (ADR-0049 A20). */
export const AUTH_SERVICE_NAME = 'auth-service';

/**
 * Auth's central audit intent (Stage 18.7.5 foundation; the catalog actions are wired in 18.7.6): `AuditEventWriter` into Auth's own
 * transactional outbox (migration 0010), ON THE CALLER'S TRANSACTION `q` — the Auth change, its local `auth_audit_event` row and this
 * evidence copy commit or roll back together. The writer refuses anything the contract refuses (and outside a transaction), so a
 * contract violation rolls the change back: evidence is never guessed and never silently skipped.
 */
@Injectable()
export class CentralAudit {
  private readonly writer: AuditEventWriter<Queryable>;

  constructor(@Inject(OutboxService) outbox: OutboxService) {
    this.writer = new AuditEventWriter({ sourceService: AUTH_SERVICE_NAME, outbox });
  }

  async write<A extends AuditAction>(q: Queryable, input: AuditEventInput<A>, options: AuditWriteOptions = {}): Promise<void> {
    await this.writer.write(q, input, options);
  }
}

/** The catalog actor of an authenticated Auth user: its id and the kind the DATABASE holds (the guard loads it; never a token claim). */
export const userActor = (a: { userId: string; kind: 'member' | 'owner' | 'operator' }): { type: 'user'; id: string; userKind: 'member' | 'owner' | 'operator' } =>
  ({ type: 'user', id: a.userId, userKind: a.kind });

/**
 * The actor of an owner-only operation, for services that receive the owner as `{ userId, sid }`: they prove the owner FIRST from the
 * persisted `owner` row (an active owner of a company), so its kind is a database fact, never a request value.
 */
export const ownerActor = (owner: { userId: string }) => userActor({ userId: owner.userId, kind: 'owner' });

export function auditEventBus(cfg: Pick<AppConfig, 'audit' | 'env'>): EventBus {
  if (cfg.audit.rabbitmqUrl) {
    return new RabbitMqEventBus({
      url: cfg.audit.rabbitmqUrl,
      confirmTimeoutMs: cfg.audit.confirmTimeoutMs,
      heartbeatS: cfg.audit.heartbeatS,
      onNotice: (message, level) => new Logger('AuditRabbitMqEventBus')[level === 'info' ? 'log' : level](message),
    });
  }
  if (cfg.env === 'production') throw new ConfigError('RABBITMQ_URL is required in production (the in-memory event bus is for development and tests only)');
  return new InMemoryEventBus();
}

/**
 * Stage 18.7.5: the durable audit path of Auth, entirely the service-kit's (no second outbox architecture): the kit `EventsModule`
 * provides `OutboxService` and the relay (started on bootstrap, retry with backoff, publisher confirms, drained in
 * `beforeApplicationShutdown` while the pool and the broker are still open, the bus closed after; Auth's pool closes last).
 *
 * The relay reads the outbox through the kit `DbService` token; here that token IS Auth's own `DbService` (one pool, one set of
 * bounds, one readiness check), which is why Auth's pool is provided by this global module. The broker is the kit default exchange
 * (the one audit-service binds), NOT the legacy `AUTH_EVENTS` exchange, and never depends on `AUTH_EVENTS`.
 */
@Global()
@Module({})
export class AuditRelayModule {
  /** `relay: false` (the CLI): the outbox writer without a relay; the running service's relay publishes whatever the CLI wrote. */
  static forRoot(cfg: AppConfig, bus?: EventBus, opts: { relay?: boolean } = {}): DynamicModule {
    return {
      module: AuditRelayModule,
      imports: [
        KitEventsModule.forRoot({
          source: AUTH_SERVICE_NAME,
          relay: { enabled: opts.relay ?? true },
          bus: bus ?? (opts.relay === false ? new InMemoryEventBus() : auditEventBus(cfg)),
          onError: (message) => new Logger('OutboxRelay').warn(message),
        }),
      ],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        DbService,
        { provide: KitDbService, useExisting: DbService },
        CentralAudit,
      ],
      exports: [DbService, KitDbService, CentralAudit],
    };
  }
}
