import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JsonLogger, configureApp } from '@nawara/service-kit';
import { AppModule } from './app.module.js';
import { loadAuditConfig } from './config/audit-config.js';
import { configureHttpServer } from './http/http-server.js';

async function bootstrap() {
  const config = loadAuditConfig(); // throws ConfigError (fail closed), never echoing a value
  const logger = new JsonLogger(config.serviceName, config.logLevel);

  // bodyParser: false lets the kit install its own bounded JSON parser (BODY_LIMIT_KB) inside configureApp: the only body parser.
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), { bodyParser: false, bufferLogs: true });
  configureApp(app, config, logger); // includes enableShutdownHooks(): SIGTERM stops admission, drains HTTP (bounded), then exits
  configureHttpServer(app.getHttpServer(), config); // the silent-socket bound

  await app.listen(config.port);
  // Stage 14.7: one line that identifies this instance (no URL, credential or config dump). Liveness is /health, readiness /ready.
  logger.info('service_started', { port: config.port, environment: config.nodeEnv, logLevel: config.logLevel });
}
await bootstrap();
