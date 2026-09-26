import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { OutboxService } from '@nawara/service-kit';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import type { Queryable } from '../db/db.service.js';
import type { DomainEvents } from '../common/ports.js';

/** Canonical envelope identity of every Auth event (Stage 16.2, ADR-0046 rule 17): the existing payloads are version 1. */
export const AUTH_EVENT_VERSION = 1;

/**
 * The three events that carry a one-time code for delivery (Stage 21.C.2, ADR-0052 decision 5, Q3). Their outbox rows are sensitive,
 * short-lived data: deleted once published or once the code has expired (`CodeEventPurge`), never logged, never copied into Audit.
 */
export const CODE_BEARING_EVENTS = ['member.contact_verification_requested', 'admin.operator_code_issued', 'admin.operator_confirmation_code_issued'] as const;

/**
 * Stage 21.C.2 (ADR-0052 decision 4, C3): Auth's domain events through Auth's EXISTING transactional outbox (migration 0010, the kit table),
 * on the caller's transaction, published by the one kit relay Auth already runs for its audit evidence (same exchange `nawara.events`, the
 * event name as the routing key, `source: auth-service`, version 1, the outbox row id as `eventId` / `messageId`). This replaces the
 * fire-and-forget publisher (F14, ADR-0046 D19): there is no other path to the broker, so an event is never emitted twice by two paths.
 *
 * `AUTH_EVENTS` (Q4) decides only whether rows are WRITTEN: off writes nothing (so nothing can wait unrelayed); rows already committed are
 * always relayed; toggling never duplicates or replays anything (identity is the row, created once).
 */
@Injectable()
export class OutboxDomainEvents implements DomainEvents, OnApplicationBootstrap {
  private readonly enabled: boolean;

  constructor(
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(APP_CONFIG) cfg: AppConfig,
  ) {
    this.enabled = cfg.events.enabled;
  }

  onApplicationBootstrap(): void {
    new Logger('AuthDomainEvents').log(`auth_domain_events enabled=${this.enabled}`);
  }

  async emit(q: Queryable, name: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return;
    await this.outbox.enqueue(q, { name, payload, version: AUTH_EVENT_VERSION });
  }
}
