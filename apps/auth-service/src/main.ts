import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JsonLogger } from '@nawara/service-kit';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/app-config.js';
import { configureAuthApp } from './http/configure-auth-app.js';

async function bootstrap() {
  const cfg = loadConfig(); // throws ConfigError (fail closed) if any setting or secret is missing/invalid, before anything starts
  // bodyParser: false lets the kit install its own bounded parsers (V2 A4.4: JSON and URL-encoded, BODY_LIMIT_KB) inside configureApp.
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(cfg), { bodyParser: false, bufferLogs: true });
  const logger = new JsonLogger('auth-service', cfg.logLevel); // V2 A12.4.3: the validated LOG_LEVEL, as in every other Core service
  // V2 A4.4: the kit's HTTP baseline with Auth's filter and settings, the same pipeline the e2e tests run (src/http/configure-auth-app.ts).
  configureAuthApp(app, cfg, logger);

  await app.listen(cfg.port);
  // Stage 14.7: one line that identifies this instance (no URL, credential or config dump). Liveness is /health, readiness /ready.
  logger.info('service_started', { port: cfg.port, environment: cfg.env, logLevel: cfg.logLevel, domainEvents: cfg.events.enabled ? 'outbox' : 'off' });
}
await bootstrap();
