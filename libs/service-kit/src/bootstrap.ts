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
 *   -> bounded JSON body -> DTO whitelist (unknown fields are rejected) -> uniform error filter (localized, ADR-0054) -> structured logger
 *   -> graceful shutdown hooks. CORS stays off unless exact origins are listed. Needs the kit's `HealthModule`.
 */
export interface ConfigureAppOptions {
  /**
   * ADR-0054 D12: path prefixes whose error responses keep exactly the pre-localization rendering (no new code, no localized message,
   * no `Content-Language` / `Vary`), for example a payment provider's webhook route. Everything else gets the ADR-0054 error behaviour.
   */
  errorLocalizationExcludedPaths?: readonly string[];
}

export function configureApp(app: NestExpressApplication, config: BaseConfig, logger: JsonLogger, options: ConfigureAppOptions = {}): NestExpressApplication {
  app.useLogger(logger);
  // Stage 22 F3: a bounded hop count, read from the right; never `true` (which trusts every hop, so the client-written leftmost entry).
  if (config.trustProxyHops > 0) app.set('trust proxy', config.trustProxyHops);
  app.use(shutdownAdmission(app.get(ShutdownState)));
  app.use(requestContextMiddleware);
  app.use(helmet());
  app.useBodyParser('json', { limit: `${config.bodyLimitKb}kb` });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: false }));
  app.useGlobalFilters(new KitExceptionFilter(logger, { localize: true, excludedPathPrefixes: options.errorLocalizationExcludedPaths ?? [] }));
  if (config.corsOrigins.length > 0) app.enableCors({ origin: config.corsOrigins, credentials: false });
  app.enableShutdownHooks();
  return app;
}
