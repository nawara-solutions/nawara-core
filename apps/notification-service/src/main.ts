import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JsonLogger, MetricsHost, configureApp } from '@nawara/service-kit';
import { AppModule } from './app.module.js';
import { loadNotificationConfig } from './config/notification-config.js';
import { mountDocs } from './docs/mount-docs.js';
import { INTAKE_EVENT_BUS } from './intake/event-consumer.js';

async function bootstrap() {
  const config = loadNotificationConfig(); // throws ConfigError (fail closed), never echoing a value
  const logger = new JsonLogger(config.serviceName, config.logLevel);

  // bodyParser: false lets the kit install its own bounded JSON parser (size limit) inside configureApp.
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), { bodyParser: false, bufferLogs: true });
  configureApp(app, config, logger); // includes enableShutdownHooks(): SIGTERM stops admission, drains HTTP (bounded), then exits
  // V2 A12.3: the intake bus has its own token, so its messaging metrics are wired here (a no-op while METRICS_ENABLED is off).
  app.get(MetricsHost).observeEventBus(app.get(INTAKE_EVENT_BUS));

  mountDocs(app, config);

  await app.listen(config.port);
  // Stage 14.7: one line that identifies this instance (no URL, credential or config dump). Liveness is /health, readiness /ready.
  logger.info('service_started', { port: config.port, environment: config.nodeEnv, logLevel: config.logLevel });
}
await bootstrap();
