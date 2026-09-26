import { createHash } from 'node:crypto';
import { Global, Inject, Injectable, Logger, Module, type DynamicModule } from '@nestjs/common';
import { AuditEventWriter } from '@nawara/audit-contract';
import { ConfigError, EventsModule, InMemoryEventBus, OutboxService, RabbitMqEventBus, type EventBus, type Queryable } from '@nawara/service-kit';
import { SERVICE_NAME, type ReleaseConfig } from '../config/release-config.js';
import type { CompatibilityPolicy, Component, Release } from '../domain/model.js';

// Arbitrary, fixed namespace for release-service's deterministically derived audit event ids (RFC 4122 §4.3).
const NAMESPACE = Buffer.from('4b0c7e2a91d34f6e8a5b3c2d1e0f9a8b', 'hex');

/** A version-5 UUID of the parts: the same business fact always has the same event id. */
export function deterministicEventId(...parts: string[]): string {
  const hash = createHash('sha1').update(Buffer.concat([NAMESPACE, Buffer.from(parts.join(':'), 'utf8')])).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Central audit intent of Release Management's automation actions (Stage 20.3, ADR-0051 §9), through `AuditEventWriter` into the kit
 * outbox ON THE MUTATION'S TRANSACTION: the release row and its evidence commit or roll back together, and no audit-service call is ever
 * made on the request path (the relay publishes after COMMIT; a broker outage leaves a durable backlog).
 *
 * - Written ONLY when the row actually changed (a new release; `registered → published`). An idempotent retry changes nothing and
 *   writes nothing, so the trail never claims a release was registered or published twice.
 * - The event id derives from (release, action): even a caller that bypassed that rule could not record the same fact twice (the outbox
 *   ignores a second row with the same id).
 * - The actor is the authenticated CI service (its caller name from its token), never a human; the record is platform-level
 *   (organization `null`); the changes are identifiers and the closed component kind: no version text, build id, source revision, notes
 *   reference, token, header or request body.
 */
@Injectable()
export class ReleaseAudit {
  private readonly writer: AuditEventWriter<Queryable>;

  constructor(@Inject(OutboxService) outbox: OutboxService) {
    this.writer = new AuditEventWriter({ sourceService: SERVICE_NAME, outbox });
  }

  async registered(q: Queryable, release: Release, component: Component, caller: string): Promise<void> {
    await this.writer.write(q, {
      action: 'release.registered', actor: { type: 'service', id: caller }, organizationId: null, resource: { type: 'release', id: release.id }, outcome: 'succeeded',
      changes: { product_id: component.productId, component_id: component.id, kind: component.kind },
    }, { eventId: deterministicEventId(release.id, 'audit.release.registered') });
  }

  async published(q: Queryable, release: Release, component: Component, caller: string): Promise<void> {
    await this.writer.write(q, {
      action: 'release.published', actor: { type: 'service', id: caller }, organizationId: null, resource: { type: 'release', id: release.id }, outcome: 'succeeded',
      changes: { product_id: component.productId, component_id: component.id, kind: component.kind },
    }, { eventId: deterministicEventId(release.id, 'audit.release.published') });
  }
}

/** The facts of one committed policy change (Stage 20.4): the policy it created and the releases its old and new minimums designate. */
export interface PolicyChange {
  component: Component;
  policy: CompatibilityPolicy;
  previousPolicyVersion: number;
  minimumReleaseId: string;
  previousMinimumReleaseId: string | null;
}

/**
 * Stage 20.4: the HUMAN administration actions. The actor is the owner Auth verified for this request (never a service, never a value the
 * request supplied), recorded as the user kind it had when acting. Platform-level (organization `null`). Written only when the row changed,
 * in the mutation's transaction; event ids derive from what changed (the release; the component and its new policy version).
 */
@Injectable()
export class ReleaseAdminAudit {
  private readonly writer: AuditEventWriter<Queryable>;

  constructor(@Inject(OutboxService) outbox: OutboxService) {
    this.writer = new AuditEventWriter({ sourceService: SERVICE_NAME, outbox });
  }

  async withdrawn(q: Queryable, release: Release, component: Component, ownerId: string): Promise<void> {
    await this.writer.write(q, {
      action: 'release.withdrawn', actor: { type: 'user', id: ownerId, userKind: 'owner' }, organizationId: null, resource: { type: 'release', id: release.id },
      outcome: 'succeeded', changes: { product_id: component.productId, component_id: component.id, kind: component.kind },
    }, { eventId: deterministicEventId(release.id, 'audit.release.withdrawn') });
  }

  async policyChanged(q: Queryable, c: PolicyChange, ownerId: string): Promise<void> {
    if (c.component.kind === 'backend') throw new Error('a backend component has no compatibility policy');
    await this.writer.write(q, {
      action: 'compatibility_policy.changed', actor: { type: 'user', id: ownerId, userKind: 'owner' }, organizationId: null,
      resource: { type: 'component', id: c.component.id }, outcome: 'succeeded',
      changes: {
        product_id: c.component.productId, kind: c.component.kind, policy_version: { from: c.previousPolicyVersion, to: c.policy.policyVersion },
        minimum_release_id: c.minimumReleaseId, ...(c.previousMinimumReleaseId ? { previous_minimum_release_id: c.previousMinimumReleaseId } : {}),
      },
    }, { eventId: deterministicEventId(c.component.id, String(c.policy.policyVersion), 'audit.compatibility_policy.changed') });
  }
}

export function eventBus(config: Pick<ReleaseConfig, 'rabbitmqUrl' | 'rabbitmqConfirmTimeoutMs' | 'rabbitmqHeartbeatS' | 'isProduction'>): EventBus {
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
 * Stage 20.3: the ONE place release-service touches events. The kit `EventsModule` (outbox service + relay: started on bootstrap, drained
 * at shutdown start, the bus closed after, the pool last) publishes the audit outbox rows. There are no Release domain events and
 * nothing is consumed (no notification, no billing, no deployment is triggered by a release).
 */
@Global()
@Module({})
export class ReleaseAuditModule {
  static forRoot(config: ReleaseConfig, bus?: EventBus): DynamicModule {
    return {
      module: ReleaseAuditModule,
      imports: [
        EventsModule.forRoot({
          source: SERVICE_NAME,
          bus: bus ?? eventBus(config),
          onError: (message) => new Logger('OutboxRelay').warn(message),
        }),
      ],
      providers: [ReleaseAudit, ReleaseAdminAudit],
      exports: [ReleaseAudit, ReleaseAdminAudit],
    };
  }
}
