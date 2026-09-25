import { Global, Inject, Injectable, Logger, Module, type DynamicModule } from '@nestjs/common';
import { AuditEventWriter, type AuditActor } from '@nawara/audit-contract';
import { ConfigError, EventsModule, InMemoryEventBus, OutboxService, RabbitMqEventBus, getRequestContext, type EventBus, type Queryable } from '@nawara/service-kit';
import type { OrganizationConfig } from '../config/organization-config.js';

/** The ONE identity of this service as a producer: the relay stamps it as `source`, the audit writer is bound to it (ADR-0049 A20). */
export const ORGANIZATION_SERVICE_NAME = 'organization-service';

/** The kit correlation grammar. A correlation id is navigation only (A33): one outside it is dropped, never a reason to fail a change. */
const CORRELATION = /^[A-Za-z0-9._:-]{8,128}$/;
const correlation = (): { correlationId?: string } => {
  const id = getRequestContext()?.correlationId;
  return id && CORRELATION.test(id) ? { correlationId: id } : {};
};

type Target = { type: 'company' | 'platform' | 'organization'; id: string };
export type HierarchyAction = 'company.created' | 'company.updated' | 'platform.created' | 'platform.updated' | 'organization.created' | 'organization.updated';
export type DeniedOperation = 'platform.create' | 'platform.update' | 'organization.create' | 'organization.update';
export type DeniedReason = 'no_authority' | 'step_up_required';

/** The audit actor of a service-token caller (companies / platforms / organizations routes): the authenticated caller, never a request value. */
export const serviceActor = (caller: string): AuditActor => ({ type: 'service', id: caller });
/** The audit actor of an admin route: the human Auth verified for this request (its grants), with its kind. */
export const humanActor = (facts: { userId: string; kind: 'member' | 'owner' | 'operator' }): AuditActor => ({ type: 'user', id: facts.userId, userKind: facts.kind });

/**
 * Central audit intent of Organization's catalog actions (Stage 18.7.3), written through `AuditEventWriter` into the kit outbox ON THE
 * HIERARCHY WRITE'S TRANSACTION (`q`), next to the local `admin_actor_event` where there is one: the write, its local record and this
 * evidence copy commit or roll back together. The organization is the resource itself for an organization (`self`), none for a company
 * or platform; a denial records the organization only when its target is one (`resource` rule). The local records keep their purpose.
 */
@Injectable()
export class OrganizationAudit {
  private readonly writer: AuditEventWriter<Queryable>;

  constructor(@Inject(OutboxService) outbox: OutboxService) {
    this.writer = new AuditEventWriter({ sourceService: ORGANIZATION_SERVICE_NAME, outbox });
  }

  async hierarchy(q: Queryable, action: HierarchyAction, resource: Target, actor: AuditActor): Promise<void> {
    await this.writer.write(q, {
      action, actor, organizationId: resource.type === 'organization' ? resource.id : null, resource, outcome: 'succeeded',
    } as never, correlation());
  }

  async denied(q: Queryable, actor: AuditActor, operation: DeniedOperation, target: Target, reason: DeniedReason): Promise<void> {
    await this.writer.write(q, {
      action: 'hierarchy.admin_operation_denied', actor, organizationId: target.type === 'organization' ? target.id : null, resource: target,
      outcome: 'denied', changes: { operation, reason },
    }, correlation());
  }
}

function eventBus(config: OrganizationConfig): EventBus {
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
 * Stage 18.7.3: the ONE place organization-service touches events. The kit `EventsModule` (outbox service + relay: started on bootstrap,
 * drained at shutdown start, the bus closed after, the pool last) publishes the audit outbox rows; there are no organization domain events.
 * `boundary.spec.ts` confines the broker, the outbox and the relay to this directory.
 */
@Global()
@Module({})
export class OrganizationAuditModule {
  static forRoot(config: OrganizationConfig, bus?: EventBus): DynamicModule {
    return {
      module: OrganizationAuditModule,
      imports: [
        EventsModule.forRoot({
          source: ORGANIZATION_SERVICE_NAME,
          bus: bus ?? eventBus(config),
          onError: (message) => new Logger('OutboxRelay').warn(message),
        }),
      ],
      providers: [OrganizationAudit],
      exports: [OrganizationAudit],
    };
  }
}
