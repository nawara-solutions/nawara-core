import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { BaseConfig } from './config/base-config.js';
import { requestContextMiddleware } from './context/request-context.js';
import { KitExceptionFilter } from './errors/exception.filter.js';
import { LocalizedValidationPipe } from './errors/validation.pipe.js';
import { ShutdownState, shutdownAdmission } from './health/http-drain.js';
import type { JsonLogger } from './logging/json-logger.js';
import { installMetrics } from './metrics/install.js';

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
  /**
   * V2 A4.4: the exception filter to install instead of the default `KitExceptionFilter`: an instance of the kit filter or of a subclass
   * (Auth's `AuthExceptionFilter` adds its documented extra response fields), built by the service with its own logger and localization.
   * `errorLocalizationExcludedPaths` configures the default filter only, so giving both is refused instead of one being ignored.
   */
  exceptionFilter?: KitExceptionFilter;
  /**
   * V2 A4.4: install CORS before the body parser, so a request body refused while it is parsed (malformed 400, oversized 413) still
   * carries the CORS headers of an allowed origin. Default `false`: CORS after the error filter, as before.
   */
  corsBeforeBodyParser?: boolean;
  /**
   * V2 A4.4: also parse `application/x-www-form-urlencoded` bodies (the extended form) under the same `bodyLimitKb`. Default `false`:
   * JSON bodies only.
   */
  urlencodedBodies?: boolean;
}

export function configureApp(app: NestExpressApplication, config: BaseConfig, logger: JsonLogger, options: ConfigureAppOptions = {}): NestExpressApplication {
  if (options.exceptionFilter !== undefined) {
    if (!(options.exceptionFilter instanceof KitExceptionFilter)) throw new TypeError('configureApp: exceptionFilter must be a KitExceptionFilter or a subclass of it');
    if (options.errorLocalizationExcludedPaths !== undefined) {
      throw new TypeError('configureApp: errorLocalizationExcludedPaths configures the default exception filter; it cannot be combined with exceptionFilter');
    }
  }
  const enableCors = () => {
    if (config.corsOrigins.length > 0) app.enableCors({ origin: config.corsOrigins, credentials: false });
  };
  app.useLogger(logger);
  // Stage 22 F3: a bounded hop count, read from the right; never `true` (which trusts every hop, so the client-written leftmost entry).
  if (config.trustProxyHops > 0) app.set('trust proxy', config.trustProxyHops);
  app.use(shutdownAdmission(app.get(ShutdownState)));
  app.use(requestContextMiddleware);
  // V2 A12.2: HTTP metrics and the separate metrics listener; nothing at all while METRICS_ENABLED is off (the default).
  installMetrics(app, config, logger);
  app.use(helmet());
  if (options.corsBeforeBodyParser === true) enableCors();
  app.useBodyParser('json', { limit: `${config.bodyLimitKb}kb` });
  if (options.urlencodedBodies === true) app.useBodyParser('urlencoded', { limit: `${config.bodyLimitKb}kb`, extended: true });
  // Nest's ValidationPipe with the same options; its failures carry `validation_error` and localizable messages (ADR-0054, R4)
  app.useGlobalPipes(new LocalizedValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: false }));
  app.useGlobalFilters(options.exceptionFilter ?? new KitExceptionFilter(logger, { localize: true, excludedPathPrefixes: options.errorLocalizationExcludedPaths ?? [] }));
  if (options.corsBeforeBodyParser !== true) enableCors();
  app.enableShutdownHooks();
  return app;
}
