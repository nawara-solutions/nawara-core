// @nawara/service-kit: technical foundations shared by Nawara Core services. NO business logic lives here.
export { ConfigError, EnvReader, type FileReader } from './config/config.js';
// V2 A2.1: shared configuration primitives (adopted by the services in A2.2 and A2.3).
export { assertDistinctKeys, decodeKey, readKey, readKeyRing, readOptionalKey, readOptionalKeyEntries, type KeyRules } from './config/key-material.js';
export { isPublishedDevelopmentSecret } from './config/development-keys.js';
export { assertRuntimeDatabaseRole } from './config/db-role.js';
export { readDocsCredentials, type DocsCredentials } from './config/docs-credentials.js';
export { loadBaseConfig, loadDbRuntimeConfig, loadTrustProxyHops, parseCorsOrigins, NODE_ENVS, LOG_LEVELS, DB_QUERY_TIMEOUT_MARGIN_MS, DB_QUERY_TIMEOUT_BOUNDS, TRUST_PROXY_HOPS_BOUNDS, type BaseConfig, type DbRuntimeConfig, type NodeEnv, type LogLevel } from './config/base-config.js';
export { clientAddress, rateLimitClientAddress, normalizeAddress, rateLimitIdentity } from './context/client-address.js';

export { requestContextMiddleware, getRequestContext, runWithRequestContext, runWithEventContext, correlationHeaders, SAFE_ID, REQUEST_ID_HEADER, CORRELATION_ID_HEADER, type RequestContext } from './context/request-context.js';

export { JsonLogger, LOG_ENVELOPE_FIELDS, MAX_RECORD_LENGTH, type LogSink } from './logging/json-logger.js';
export { INVALID_TOKEN, safeSerialize, safeToken, scrubText, isSensitiveKey } from './logging/safe-serialize.js';
export { redact, redactString } from './logging/redact.js';
export { describeFailure, failureFacts, type FailureFacts, type FailureKind } from './logging/failure.js';
export { describeCliFailure } from './logging/cli-failure.js';

export { KitExceptionFilter, type ErrorBody, type KitExceptionFilterOptions } from './errors/exception.filter.js';
export { httpError, attachLocalizedMessage, attachLocalizedMessageList, type LocalizedListItem } from './errors/http-error.js';
export { LocalizedValidationPipe, VALIDATION_ERROR_CODE } from './errors/validation.pipe.js';
export { resolveLocale, SUPPORTED_LOCALES, DEFAULT_LOCALE, MAX_ACCEPT_LANGUAGE_LENGTH, MAX_LANGUAGE_RANGES, type Locale } from './i18n/locale.js';
export { defineMessages, renderMessage, catalogProblems, type MessageTexts, type MessageParams, type LocalizedMessage } from './i18n/catalog.js';

export { HealthModule } from './health/health.module.js';
export { HealthController } from './health/health.controller.js';
export { DEFAULT_HTTP_DRAIN_TIMEOUT_MS, HTTP_DRAIN_TIMEOUT_BOUNDS, HttpDrain, ShutdownState, shutdownAdmission } from './health/http-drain.js';
export { ReadinessRegistry, ReadinessCheckTimeout, type ReadinessCheck, type ReadinessResult, type ReadinessLog, type ReadinessObservation, type ReadinessObserver } from './health/readiness.registry.js';

export { assertNoPublishedServiceTokens, hashServiceToken, generateServiceToken, parseServiceTokens, MAX_TOKENS_PER_CALLER, type ServiceTokenEntry } from './service-auth/service-token.js';
export { ServiceTokenGuard, CallerService, SERVICE_TOKENS, type ServiceRequest } from './service-auth/service-token.guard.js';
export { ServiceAuthModule } from './service-auth/service-auth.module.js';
export { HttpAuthClient, type AuthClient, type AuthIdentity, type AuthMembership, type HttpAuthClientOptions } from './service-auth/auth-client.js';
export { ServiceOrUserGuard, RequestCaller, AUTH_CLIENT, type Caller, type CallerRequest } from './service-auth/service-or-user.guard.js';
export {
  parseCallerPolicy, parseJsonStrict, policyList, policyChoice, registeredCallers, operationsPolicy, operationNotPermitted,
  CallerPolicyMap, ServiceOperationGuard, RequireServiceOperation, RefuseServiceCallers, SERVICE_OPERATION_POLICY, NO_SERVICE_OPERATION,
  type CallerPolicySpec, type PolicyListOptions, type ServiceOperationPolicy,
} from './service-auth/caller-policy.js';
export {
  HttpOrganizationReferenceClient, MemoizedOrganizationReference, FixtureOrganizationReference, HierarchyUnavailableError,
  parseOrganizationReferenceFixture, loadOrganizationReferenceConfig, buildOrganizationReference, unavailableOrganizationReference,
  ORGANIZATION_REFERENCE, MAX_REFERENCE_RESPONSE_BYTES, type OrganizationReferenceConfig, type OrganizationReference, type OrganizationReferenceResolver, type HttpOrganizationReferenceOptions,
} from './service-auth/organization-reference.js';

export { DbModule } from './db/db.module.js';
export { DbService, DB_OPTIONS, pgCode, pgConstraint, isUniqueViolation, isQueryTimeout, notifyPoolError, type DbOptions, type Queryable, type IsolationLevel, type PoolErrorObserver } from './db/db.service.js';
export { runMigrations, pendingMigrations, pendingOf, listMigrationFiles, MigrationError, MIGRATIONS_TABLE, type MigrationOptions, type MigrationFile, type MigrationResult } from './db/migrations.js';
export { kitMigrationsDir } from './db/paths.js';

export { EventsModule, OutboxRelayService, EVENTS_OPTIONS, type EventsModuleOptions } from './events/events.module.js';
export { OutboxService, type NewEvent } from './events/outbox.service.js';
export { OutboxRelay, type RelayOptions, type RelayObservation, type RelayObserver } from './events/outbox-relay.js';
export { InboxService, type InboxOutcome } from './events/inbox.service.js';
export { EVENT_BUS, EVENT_NAME, PermanentEventFailure, type EventBus, type EventEnvelope, type EventHeaders, type EventSubscription, type DeadLetterInput, type DeadLetterDecision } from './events/types.js';
export { InMemoryEventBus, topicMatches, type MemoryBusOptions } from './events/memory-event-bus.js';
export { RabbitMqEventBus, PublisherConfirmTimeoutError, DEFAULT_RABBITMQ_HEARTBEAT_S, RABBITMQ_HEARTBEAT_BOUNDS, DEFAULT_PREFETCH, type RabbitMqOptions, type NoticeLevel, type ConsumerState, type ConsumerStatus, type ConsumeOutcome, type EventBusObservation, type EventBusObserver } from './events/rabbitmq-event-bus.js';

export { RateLimitModule } from './rate-limit/rate-limit.module.js';
export { RateLimitService, type RateLimitRule, type RateLimitResult } from './rate-limit/rate-limit.service.js';

export { configureApp, type ConfigureAppOptions } from './bootstrap.js';
// V2 A12.2: the metrics foundation (bounded registry, closed labels, separate listener). Off unless METRICS_ENABLED=true.
export { installMetrics, type MetricsInstallConfig } from './metrics/install.js';
export { loadMetricsConfig, DEFAULT_METRICS_HOST, DEFAULT_METRICS_PORT, type MetricsConfig } from './metrics/metrics-config.js';
export { MetricsHost } from './metrics/metrics-host.js';
export type { PoolSource } from './metrics/pool-metrics.js';
export type { BoundedMetrics, CounterHandle, GaugeHandle, HistogramHandle, HistogramDefinition, Labels, MetricDefinition } from './metrics/metrics.js';
// V2 A12.2a: closedSet is the only public label factory; growingSet and lazyClosedSet stay internal to the metrics module.
export { LABEL_NAMES, OTHER, UNMATCHED, closedSet, isForbiddenLabelName, type LabelName, type LabelSet } from './metrics/label-policy.js';

export { canonicalJson, sha256Hex, digestRows, sealSnapshot, serializeSnapshot, verifySnapshot, SnapshotError, type SealedSnapshot, type SealInput, type SnapshotRow, type VerifyResult } from './snapshot/snapshot.js';
export { inspectDeadLetters, replayDeadLetter, type DeadLetterInfo, type Inspection, type ReplayOutcome, type ReplayResult } from './events/dlq-tools.js';
export { HEADER as DEAD_LETTER_HEADER, deadQueueName, retryQueueName } from './events/dead-letter.js';
export { PollLoop, DEFAULT_DRAIN_TIMEOUT_MS, type DrainOutcome } from './workers/poll-loop.js';
