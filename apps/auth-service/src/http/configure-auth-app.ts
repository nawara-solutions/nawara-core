import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp, type BaseConfig, type JsonLogger } from '@nawara/service-kit';
import type { AppConfig } from '../config/app-config.js';
import { mountDocs } from '../docs/mount-docs.js';
import { AuthExceptionFilter } from '../errors.js';

/** The kit's `BaseConfig` view of Auth's configuration (the fields `configureApp` and the kit's HTTP baseline read). */
export function authBaseConfig(cfg: AppConfig): BaseConfig {
  return {
    serviceName: 'auth-service', nodeEnv: cfg.env, isProduction: cfg.env === 'production', port: cfg.port, logLevel: cfg.logLevel,
    bodyLimitKb: cfg.bodyLimitKb, corsOrigins: cfg.corsOrigins, trustProxyHops: cfg.trustProxyHops, trustProxy: cfg.trustProxyHops > 0,
    db: cfg.db, httpDrainTimeoutMs: cfg.httpDrainTimeoutMs, metrics: cfg.metrics,
  };
}

/**
 * V2 A4.4 (A4 record §8, ADR-0056 §12): Auth's one HTTP pipeline, used by main.ts AND by the e2e test application, so the tests exercise
 * exactly what production runs. It is the kit's `configureApp` (shutdown admission, request and correlation ids, metrics, helmet, bounded
 * body parsing, the localized validation pipe, shutdown hooks, a bounded trust-proxy hop count, CORS only for configured origins and
 * never with credentials), with three Auth settings:
 *  - `AuthExceptionFilter`: the kit filter plus its documented extra response field (`reason: 'session_ceiling_reached'`);
 *  - CORS before the body parser (OD-A4.4-1): a body refused while parsed (400, 413) still carries an allowed origin's CORS headers;
 *  - URL-encoded bodies (OD-A4.4-2), as Auth has always parsed them, under the same `BODY_LIMIT_KB` (OD-A4.4-4).
 * With no configured origin there is no CORS at all (OD-A4.4-3; the former bootstrap answered `Access-Control-Allow-Origin: *`).
 * The API documentation is mounted last, only with `SWAGGER_PASSWORD`.
 */
export function configureAuthApp(app: NestExpressApplication, cfg: AppConfig, logger: JsonLogger): NestExpressApplication {
  configureApp(app, authBaseConfig(cfg), logger, { exceptionFilter: new AuthExceptionFilter(logger), corsBeforeBodyParser: true, urlencodedBodies: true });
  mountDocs(app, cfg);
  return app;
}
