import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JsonLogger, configureApp } from '@nawara/service-kit';
import { AppModule } from './app.module.js';
import { loadFileConfig } from './config/file-config.js';
import { mountDocs } from './docs/mount-docs.js';
import { configureHttpServer } from './upload/http-server.js';

async function bootstrap() {
  const config = loadFileConfig(); // throws ConfigError (fail closed), never echoing a value
  const logger = new JsonLogger(config.serviceName, config.logLevel);

  // bodyParser: false lets the kit install its own bounded JSON parser (size limit) inside configureApp. It parses only
  // `application/json`, so raw upload bodies (Stage 17.5) stay untouched streams, never buffered by a body parser.
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), { bodyParser: false, bufferLogs: true });
  configureApp(app, config, logger); // includes enableShutdownHooks(): SIGTERM stops admission, drains HTTP (bounded), then exits
  mountDocs(app, config); // OpenAPI at /file/docs, behind basic auth, only when SWAGGER_PASSWORD is set
  configureHttpServer(app.getHttpServer(), config); // uploads: a request bound sized for FILE_MAX_BYTES (Stage 17.5)

  await app.listen(config.port);
  // Stage 14.7: one line that identifies this instance (no URL, credential or config dump). Liveness is /health, readiness /ready.
  logger.info('service_started', { port: config.port, environment: config.nodeEnv, logLevel: config.logLevel });
}
await bootstrap();
