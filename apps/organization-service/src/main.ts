import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JsonLogger, configureApp } from '@nawara/service-kit';
import { AppModule } from './app.module.js';
import { loadOrganizationConfig } from './config/organization-config.js';
import { mountDocs } from './docs/mount-docs.js';

async function bootstrap() {
  const config = loadOrganizationConfig(); // throws ConfigError (fail closed), never echoing a value
  const logger = new JsonLogger(config.serviceName, config.logLevel);

  // bodyParser: false lets the kit install its own bounded JSON parser (size limit) inside configureApp.
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), { bodyParser: false, bufferLogs: true });
  configureApp(app, config, logger); // includes enableShutdownHooks(): SIGTERM drains requests and closes the database pool

  mountDocs(app, config);

  await app.listen(config.port);
  // Stage 14.7: one line that identifies this instance (no URL, credential or config dump). Liveness is /health, readiness /ready.
  logger.info('service_started', { port: config.port, environment: config.nodeEnv, logLevel: config.logLevel });
}
await bootstrap();
