import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { BaseConfig } from './config/base-config.js';
import { requestContextMiddleware } from './context/request-context.js';
import { KitExceptionFilter } from './errors/exception.filter.js';
import { ShutdownState, shutdownAdmission } from './health/http-drain.js';
import type { JsonLogger } from './logging/json-logger.js';

/**
 * Applies the shared HTTP baseline to a Nest Express application, which must be created with `{ bodyParser: false }`
 * (the kit installs the body parser so it can enforce a size limit):
 *   shutdown admission (Stage 15.5: 503 + `Connection: close` once draining) -> request/correlation ids -> secure headers
 *   -> bounded JSON body -> DTO whitelist (unknown fields are rejected) -> uniform error filter -> structured logger
 *   -> graceful shutdown hooks. CORS stays off unless exact origins are listed. Needs the kit's `HealthModule`.
 */
export function configureApp(app: NestExpressApplication, config: BaseConfig, logger: JsonLogger): NestExpressApplication {
  app.useLogger(logger);
  if (config.trustProxy) app.set('trust proxy', true);
  app.use(shutdownAdmission(app.get(ShutdownState)));
  app.use(requestContextMiddleware);
  app.use(helmet());
  app.useBodyParser('json', { limit: `${config.bodyLimitKb}kb` });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: false }));
  app.useGlobalFilters(new KitExceptionFilter(logger));
  if (config.corsOrigins.length > 0) app.enableCors({ origin: config.corsOrigins, credentials: false });
  app.enableShutdownHooks();
  return app;
}
