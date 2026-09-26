import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JsonLogger, configureApp } from '@nawara/service-kit';
import { AppModule } from './app.module.js';
import { loadReleaseConfig } from './config/release-config.js';
import { mountDocs } from './docs/mount-docs.js';
import { configureHttpServer } from './http/http-server.js';

async function bootstrap() {
  const config = loadReleaseConfig(); // throws ConfigError (fail closed), never echoing a value
  const logger = new JsonLogger(config.serviceName, config.logLevel);

  // bodyParser: false lets the kit install its own bounded JSON parser (BODY_LIMIT_KB) inside configureApp: the only body parser.
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), { bodyParser: false, bufferLogs: true });
  configureApp(app, config, logger); // includes enableShutdownHooks(): SIGTERM stops admission, drains HTTP (bounded), then exits
  // Stage 20.5: no automatic Express ETag (a weak hash of any body, errors included, with Express's own 304s): the only validator is the
  // compatibility decision's deterministic ETag, computed from Release Management state.
  app.set('etag', false);
  mountDocs(app, config); // OpenAPI at /release/docs, behind basic auth, only when SWAGGER_PASSWORD is set
  configureHttpServer(app.getHttpServer(), config);

  await app.listen(config.port);
  // One line that identifies this instance (no URL, credential or config dump). Liveness is /health, readiness /ready.
  logger.info('service_started', { port: config.port, environment: config.nodeEnv, logLevel: config.logLevel });
}
await bootstrap();
