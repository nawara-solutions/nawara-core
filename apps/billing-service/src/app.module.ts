import { BILLING_SERVICE_NAME, BillingAuditModule } from './audit/billing-audit.js';
import { fileURLToPath } from 'node:url';
import { Logger, Module, type DynamicModule } from '@nestjs/common';
import {
  DbModule, EventsModule, HealthModule, InMemoryEventBus, RabbitMqEventBus, RateLimitModule, ServiceAuthModule, kitMigrationsDir,
  type AuthClient, type EventBus, type OrganizationReferenceResolver,
} from '@nawara/service-kit';
import { CallerAdmissionModule } from './admission/caller-admission.module.js';
import { AuthClientModule } from './auth/auth-client.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { AssistanceModule } from './assistance/assistance.module.js';
import { CheckoutModule } from './checkout/checkout.module.js';
import type { BillingConfig } from './config/billing-config.js';
import { BillingConfigModule } from './config/billing-config.module.js';
import { CurrenciesModule } from './currencies/currencies.module.js';
import { InvoicesModule } from './invoices/invoices.module.js';
import { PaymentIntegrationModule } from './payment-integration/payment-integration.module.js';
import { PlatformsModule } from './platforms/platforms.module.js';
import type { OwnerAuthority } from './platforms/owner-authority.client.js';
import type { DisputeExposure } from './refunds/dispute-exposure.js';
import { RefundModule } from './refunds/refund.module.js';
import { RecoveryModule } from './recovery/recovery.module.js';
import { ReconciliationModule } from './reconciliation/reconciliation.module.js';
import type { PaymentReconciliationClient } from './reconciliation/payment-reconciliation-client.js';
import { LateSettlementModule } from './late-settlements/late-settlement.module.js';
import type { PaymentRefundClient } from './refunds/payment-refund-client.js';
import { SubscriptionsModule } from './subscriptions/subscriptions.module.js';
import type { PaymentDisputeClient } from './refunds/payment-dispute-client.js';
import type { FraudEvidenceFiles, FraudHoldReceipts } from './fraud-holds/fraud-hold-clients.js';

/** The service's own migrations, applied by the explicit `npm run migrate` step and never at startup. */
export const billingMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

/**
 * Stage 15.8: every Payment event Billing consumes holds one database client while it is applied, so the consumer may take at most half
 * of the pool (5 with the default `DB_POOL_MAX` 10, at most 10): the other half stays for HTTP requests and the workers. Measured: with
 * prefetch 10 on a pool of 10, a 300-event backlog took all 10 clients and a Billing read went from p50 5.9 ms to 37.6 ms, for no faster drain.
 */
export const consumerPrefetch = (poolMax: number): number => Math.min(10, Math.max(1, Math.floor(poolMax / 2)));

export interface AppModuleOverrides {
  /** Tests inject a stub; production uses the kit's `HttpAuthClient` against `AUTH_SERVICE_URL`. */
  authClient?: AuthClient;
  /** Tests inject the in-memory bus; production uses RabbitMQ when `RABBITMQ_URL` is set. */
  bus?: EventBus;
  /** Tests point readiness at the migrations they applied. */
  migrationsDirs?: string[];
  /** Tests replace the Organization reference source (production: `buildOrganizationReference` from the configuration). */
  organizationReference?: OrganizationReferenceResolver;
  /** Core V2 S3d: tests replace the Owner check of the Platform configuration (production: `HttpOwnerAuthority` against `AUTH_SERVICE_URL`). */
  ownerAuthority?: OwnerAuthority;
  /** Core V2 S6a: tests replace the dispute-exposure boundary of refund cases (default: no dispute source exists before S6e). */
  disputeExposure?: DisputeExposure;
  /** Core V2 S6b: the refund port to Payment (tests only) and whether the relay reconciler runs its passes (default true). */
  paymentRefundClient?: PaymentRefundClient;
  /** Core V2 S6e-D: Payment's dispute reads (tests only; default: the HTTP client). */
  paymentDisputeClient?: PaymentDisputeClient;
  /** Core V2 S6e-H: fraud holds' Auth receipt and File evidence boundaries (tests only). */
  fraudHoldReceipts?: FraudHoldReceipts;
  fraudEvidenceFiles?: FraudEvidenceFiles;
  refundRelayReconciler?: boolean;
  /** Core V2 S6h-B: Payment's reconciliation read (default: the HTTP client on the configured URL). */
  paymentReconciliationClient?: PaymentReconciliationClient;
}

/**
 * The whole module graph. `main.ts` and the test suites build it through the SAME function, so a test can never
 * pass against a differently wired application than the one that ships. Stage 3 added the HTTP API (`CatalogModule`,
 * `InvoicesModule`'s controllers). Stage 4 adds `PaymentIntegrationModule`: the dispatcher, the Payment client port,
 * the event consumer and the reconciler — the actual cross-service loop to payment-service.
 */
@Module({})
export class AppModule {
  static register(config: BillingConfig, overrides: AppModuleOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        HealthModule.forRoot({ httpDrainTimeoutMs: config.httpDrainTimeoutMs }), // Stage 15.5: bounded HTTP drain
        DbModule.forRoot({
          url: config.databaseUrl,
          applicationName: config.serviceName,
          // Stage 14.4: bounded pool wait/connect, statement and idle-in-transaction limits (validated in the kit's base config).
          max: config.db.poolMax,
          connectionTimeoutMs: config.db.connectionTimeoutMs,
          statementTimeoutMs: config.db.statementTimeoutMs,
          idleInTransactionTimeoutMs: config.db.idleInTransactionTimeoutMs,
          queryTimeoutMs: config.db.queryTimeoutMs, // Stage 15.2 (I9): client-side deadline for a silent server
          migrations: { dirs: overrides.migrationsDirs ?? [kitMigrationsDir, billingMigrationsDir] },
        }),
        ServiceAuthModule.forRoot(config.serviceTokens),
        AuthClientModule.forRoot(overrides.authClient ?? { baseUrl: config.authServiceUrl, timeoutMs: config.authTimeoutMs }),
        BillingConfigModule.forRoot(config),
        CallerAdmissionModule.forRoot(config, overrides.organizationReference), // Stage 21.C.2: operation policy + Organization reference (ADR-0052)
        BillingAuditModule, // Stage 18.7: central audit intent (global; needs the kit OutboxService below)
        EventsModule.forRoot({
          source: BILLING_SERVICE_NAME, // the same identity the audit writer is bound to (Stage 18.7)
          bus: overrides.bus ?? (config.rabbitmqUrl
            ? new RabbitMqEventBus({ url: config.rabbitmqUrl, retry: config.paymentEventRetry, prefetch: consumerPrefetch(config.db.poolMax), confirmTimeoutMs: config.rabbitmqConfirmTimeoutMs, heartbeatS: config.rabbitmqHeartbeatS, onNotice: (message, level) => new Logger('RabbitMqEventBus')[level === 'info' ? 'log' : level](message) })
            : new InMemoryEventBus()),
          // Stage 5 hardening: an unpublished outbox row previously failed silently (the kit's default onError is a no-op).
          // Stage 14.7: each relay message carries its own event name (`outbox_publish_failure eventId=...`, `outbox_relay_pass_failure`, ...).
          onError: (message) => new Logger('OutboxRelay').warn(message),
        }),
        RateLimitModule,
        AuthModule,
        InvoicesModule,
        CatalogModule,
        CurrenciesModule,
        PaymentIntegrationModule,
        SubscriptionsModule,
        PlatformsModule.register(config, overrides.ownerAuthority), // Core V2 S3d (register BIL-01)
        CheckoutModule.register(config), // Core V2 S3f (BIL-10): development and simulation only; never mounted in production
        AssistanceModule.register(config, overrides.ownerAuthority), // Core V2 S5a (BIL-13 to BIL-15): development and simulation only; never mounted in production
        // Core V2 S6a (BIL-23, BIL-25) and S6b (BIL-24): development and simulation only
        RefundModule.register(config, overrides.ownerAuthority, overrides.disputeExposure, { paymentRefundClient: overrides.paymentRefundClient, reconciler: overrides.refundRelayReconciler, paymentDisputeClient: overrides.paymentDisputeClient, fraudHoldReceipts: overrides.fraudHoldReceipts, fraudEvidenceFiles: overrides.fraudEvidenceFiles }),
        // Core V2 S6f (BIL-26 T3, BIL-28 to BIL-31): recovery of verified assisted losses; development and simulation only
        RecoveryModule.register(config, overrides.ownerAuthority, { worker: overrides.refundRelayReconciler }),
        // Core V2 S6g (BIL-32): the L-4 application of verified late assisted settlements; development and simulation only
        LateSettlementModule.register(config, overrides.ownerAuthority),
        // Core V2 S6h-B (BIL-33, BIL-34, EVT-10): reconciliation cases, late successes, FinancialLoss; development and simulation only
        ReconciliationModule.register(config, overrides.ownerAuthority, { worker: overrides.refundRelayReconciler, paymentReconciliationClient: overrides.paymentReconciliationClient }),
      ],
    };
  }
}
