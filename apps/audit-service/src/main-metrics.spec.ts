import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { JsonLogger, MetricsHost, configureApp } from '@nawara/service-kit';
import { AppModule } from './app.module.js';
import { loadAuditConfig } from './config/audit-config.js';
import { AUDIT_EVENT_BUS } from './ingestion/audit-consumer.js';

/**
 * V2 A12.3 post-certification correction (found by A12.5.1): audit-service's real module, created exactly as main.ts creates it
 * (`NestFactory.create`, Nest's default `abortOnError: true`), then `configureApp` and main.ts's own metrics line. With metrics on it
 * used to exit: the kit looked up its optional EVENT_BUS / outbox relay through the application proxy. Nothing here connects to a
 * database or broker (`create` runs no lifecycle hook). `process.exit` is recorded, so an exit is an assertion failure.
 */
const env = (metrics: boolean): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test', DATABASE_URL: 'postgres://audit_app:pw-not-real@db:5432/audit', RABBITMQ_URL: 'amqp://audit_consumer:mq-not-real@broker:5672',
  METRICS_ENABLED: String(metrics), METRICS_PORT: '0',
});

describe('audit-service bootstrap with metrics (as main.ts)', () => {
  let exit: MockInstance<typeof process.exit>;
  let app: NestExpressApplication | undefined;
  beforeEach(() => {
    exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${String(code)})`);
    });
  });
  afterEach(async () => {
    exit.mockRestore();
    await app?.close().catch(() => undefined);
    app = undefined;
  });

  for (const metrics of [true, false]) {
    it(`METRICS_ENABLED=${metrics}: boots without exiting; the metrics listener serves only when enabled`, async () => {
      const config = loadAuditConfig(env(metrics));
      app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), { bodyParser: false, logger: false });
      configureApp(app, config, new JsonLogger(config.serviceName, 'error', () => undefined));
      app.get(MetricsHost).observeEventBus(app.get(AUDIT_EVENT_BUS)); // main.ts, verbatim
      expect(exit).not.toHaveBeenCalled();
      const host = app.get(MetricsHost);
      if (!metrics) return expect(host.metrics).toBeUndefined();
      const res = await fetch(`http://127.0.0.1:${(await host.address())!.port}/metrics`);
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(body).toMatch(/^nawara_service_info\{service="audit-service"\} 1$/m);
      expect(body).toContain('# TYPE nawara_events_consumed_total counter'); // the ingestion bus is observed
    });
  }
});
