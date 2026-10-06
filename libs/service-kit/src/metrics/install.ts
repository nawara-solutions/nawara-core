import type { INestApplication } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DbService } from '../db/db.service.js';
import { OutboxRelayService } from '../events/events.module.js';
import { EVENT_BUS } from '../events/types.js';
import { ReadinessRegistry, type ReadinessObservation } from '../health/readiness.registry.js';
import type { JsonLogger } from '../logging/json-logger.js';
import { expressRouteTemplates, httpMetricsMiddleware } from './http-metrics.js';
import { closedSet, growingSet } from './label-policy.js';
import { BoundedMetrics } from './metrics.js';
import type { MetricsConfig } from './metrics-config.js';
import { MetricsHost } from './metrics-host.js';
import { MetricsServer } from './metrics-server.js';

export interface MetricsInstallConfig {
  serviceName: string;
  metrics: MetricsConfig;
}

/** A readiness check name, as code registers it (`database`, `migrations`, `rabbitmq-consumer`, ...); at most 32 of them. */
const CHECK_NAME = /^[a-z][a-z0-9_-]{0,40}$/;
const MAX_CHECKS = 32;

/**
 * V2 A12.2: installs the metrics foundation on a Nest application, or does nothing at all when `METRICS_ENABLED` is off (the
 * default). It must run right after the request-context middleware (`configureApp` does; auth-service calls it explicitly at the
 * same point) and before `listen`, and needs the kit's `HealthModule` (which provides `MetricsHost` and `ReadinessRegistry`).
 *
 * Installs: `nawara_service_info`, the runtime metrics, the HTTP middleware, the readiness observer (metrics are SET by what `/ready`
 * runs and never run a check), and the separate metrics listener, which `MetricsHost` closes at shutdown. A second call throws.
 */
export function installMetrics(app: INestApplication, config: MetricsInstallConfig, logger: JsonLogger): void {
  if (!config.metrics.enabled) return;
  const host = app.get(MetricsHost);
  if (host.metrics) throw new Error('metrics are already installed for this application');

  const metrics = new BoundedMetrics({ runtime: true });
  metrics
    .gauge({ name: 'nawara_service_info', help: 'Always 1; identifies the service exposing these metrics.', labels: [closedSet('service', [config.serviceName])] })
    .set({ service: config.serviceName }, 1);

  const express = app.getHttpAdapter().getInstance();
  app.use(httpMetricsMiddleware(metrics, () => expressRouteTemplates(express)));

  app.get(ReadinessRegistry).setObserver(readinessObserver(metrics));

  const server = new MetricsServer(metrics, (level, message) => (level === 'error' ? logger.error(message, 'Metrics') : logger.warn(message, 'Metrics')));
  host.attach(metrics, server, server.start(config.metrics.host, config.metrics.port));

  // V2 A12.3: the shared infrastructure the service has, if any: the kit event bus and outbox relay (EventsModule) and the database pool
  // behind the kit DbService token (auth-service provides its own pool there). Each is observed once; anything absent is skipped.
  const refs = app.get(ModuleRef);
  host.observeEventBus(optional(refs, EVENT_BUS));
  host.observeOutboxRelay(optional<OutboxRelayService>(refs, OutboxRelayService)?.relay);
  host.observePool('main', optional(refs, DbService));
}

/**
 * An optional provider, or undefined when the application has none. It is looked up through the root `ModuleRef`, never through `app`:
 * `NestFactory.create` wraps the application in a proxy that, under its default `abortOnError: true` (every service's `main.ts`), runs
 * each method in Nest's exception zone, where a failed lookup is logged and the process exits before a `catch` here could run (the
 * A12.3 defect found by A12.5.1: audit-service and notification-service have no kit `EVENT_BUS` or outbox relay). `ModuleRef.get` is
 * a plain lookup whose `UnknownElementException` this function catches. Required providers above still use `app.get`, so a genuinely
 * missing one fails startup as before.
 */
function optional<T = unknown>(refs: ModuleRef, token: unknown): T | undefined {
  try {
    return refs.get(token as never, { strict: false }) as T;
  } catch {
    return undefined;
  }
}

function readinessObserver(metrics: BoundedMetrics): (o: ReadinessObservation) => void {
  const check = growingSet('check', CHECK_NAME, MAX_CHECKS);
  const ready = metrics.gauge({ name: 'nawara_readiness_ready', help: 'Result of the last readiness run: 1 ready, 0 not ready (including draining).' });
  const up = metrics.gauge({ name: 'nawara_readiness_check_up', help: 'Result of each readiness check in the last run: 1 passed, 0 failed.', labels: [check], maxSeries: MAX_CHECKS + 1 });
  const duration = metrics.gauge({ name: 'nawara_readiness_check_duration_seconds', help: 'Duration of each readiness check in the last run.', labels: [check], maxSeries: MAX_CHECKS + 1 });
  const lastRun = metrics.gauge({ name: 'nawara_readiness_last_run_timestamp_seconds', help: 'When readiness last ran (a /ready probe); metrics never run it.' });
  return (o) => {
    ready.set(undefined, o.ready ? 1 : 0);
    lastRun.set(undefined, Date.now() / 1000);
    for (const c of o.checks) {
      up.set({ check: c.name }, c.ok ? 1 : 0);
      duration.set({ check: c.name }, c.durationMs / 1000);
    }
  };
}
