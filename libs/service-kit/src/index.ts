// @nawara/service-kit: technical foundations shared by Nawara Core services. NO business logic lives here.
export { ConfigError, EnvReader, type FileReader } from './config/config.js';
export { loadBaseConfig, loadDbRuntimeConfig, parseCorsOrigins, NODE_ENVS, LOG_LEVELS, type BaseConfig, type DbRuntimeConfig, type NodeEnv, type LogLevel } from './config/base-config.js';

export { requestContextMiddleware, getRequestContext, runWithRequestContext, correlationHeaders, REQUEST_ID_HEADER, CORRELATION_ID_HEADER, type RequestContext } from './context/request-context.js';

export { JsonLogger, type LogSink } from './logging/json-logger.js';
export { redact, redactString } from './logging/redact.js';
export { describeFailure, failureFacts, type FailureFacts, type FailureKind } from './logging/failure.js';

export { KitExceptionFilter, type ErrorBody } from './errors/exception.filter.js';

export { HealthModule } from './health/health.module.js';
export { HealthController } from './health/health.controller.js';
export { ReadinessRegistry, ReadinessCheckTimeout, type ReadinessCheck, type ReadinessResult, type ReadinessLog } from './health/readiness.registry.js';

export { hashServiceToken, generateServiceToken, parseServiceTokens, MAX_TOKENS_PER_CALLER, type ServiceTokenEntry } from './service-auth/service-token.js';
export { ServiceTokenGuard, CallerService, SERVICE_TOKENS, type ServiceRequest } from './service-auth/service-token.guard.js';
export { ServiceAuthModule } from './service-auth/service-auth.module.js';
export { HttpAuthClient, type AuthClient, type AuthIdentity, type AuthMembership, type HttpAuthClientOptions } from './service-auth/auth-client.js';
export { ServiceOrUserGuard, RequestCaller, AUTH_CLIENT, type Caller, type CallerRequest } from './service-auth/service-or-user.guard.js';

export { DbModule } from './db/db.module.js';
export { DbService, DB_OPTIONS, pgCode, pgConstraint, isUniqueViolation, type DbOptions, type Queryable, type IsolationLevel } from './db/db.service.js';
export { runMigrations, pendingMigrations, pendingOf, listMigrationFiles, MigrationError, MIGRATIONS_TABLE, type MigrationOptions, type MigrationFile, type MigrationResult } from './db/migrations.js';
export { kitMigrationsDir } from './db/paths.js';

export { EventsModule, OutboxRelayService, EVENTS_OPTIONS, type EventsModuleOptions } from './events/events.module.js';
export { OutboxService, type NewEvent } from './events/outbox.service.js';
export { OutboxRelay, type RelayOptions } from './events/outbox-relay.js';
export { InboxService, type InboxOutcome } from './events/inbox.service.js';
export { EVENT_BUS, EVENT_NAME, PermanentEventFailure, type EventBus, type EventEnvelope, type EventHeaders, type EventSubscription } from './events/types.js';
export { InMemoryEventBus, topicMatches, type MemoryBusOptions } from './events/memory-event-bus.js';
export { RabbitMqEventBus, PublisherConfirmTimeoutError, type RabbitMqOptions, type NoticeLevel, type ConsumerState, type ConsumerStatus } from './events/rabbitmq-event-bus.js';

export { RateLimitModule } from './rate-limit/rate-limit.module.js';
export { RateLimitService, type RateLimitRule, type RateLimitResult } from './rate-limit/rate-limit.service.js';

export { configureApp } from './bootstrap.js';

export { canonicalJson, sha256Hex, digestRows, sealSnapshot, serializeSnapshot, verifySnapshot, SnapshotError, type SealedSnapshot, type SealInput, type SnapshotRow, type VerifyResult } from './snapshot/snapshot.js';
export { inspectDeadLetters, replayDeadLetter, type DeadLetterInfo, type Inspection, type ReplayOutcome, type ReplayResult } from './events/dlq-tools.js';
export { HEADER as DEAD_LETTER_HEADER, deadQueueName, retryQueueName } from './events/dead-letter.js';
export { PollLoop, DEFAULT_DRAIN_TIMEOUT_MS, type DrainOutcome } from './workers/poll-loop.js';
