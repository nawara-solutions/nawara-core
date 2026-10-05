import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { JsonLogger, LocalizedValidationPipe, ShutdownState, installMetrics, requestContextMiddleware, shutdownAdmission } from '@nawara/service-kit';
import { AppModule } from './app.module.js';
import { basicAuth } from './docs/basic-auth.js';
import { loadConfig } from './config/app-config.js';
import { AuthExceptionFilter } from './errors.js';

async function bootstrap() {
  const cfg = loadConfig(); // throws ConfigError (fail closed) if any setting or secret is missing/invalid, before anything starts
  const app = await NestFactory.create(AppModule.register(cfg), { bufferLogs: true });
  const logger = new JsonLogger('auth-service', 'info');

  // Stage 15.5: once shutdown starts, a new request is refused (503, Connection: close) instead of feeding a closing process.
  app.use(shutdownAdmission(app.get(ShutdownState)));
  // Request/correlation id first, so every log line and error response from this point on can carry it.
  app.use(requestContextMiddleware);
  // V2 A12.2: the kit's HTTP metrics and separate metrics listener, at the same point configureApp installs them in the other services
  // (auth-service builds its pipeline itself). Nothing at all while METRICS_ENABLED is off (the default); /auth/health is unchanged.
  installMetrics(app, { serviceName: 'auth-service', metrics: cfg.metrics }, logger);
  app.use(helmet());
  // Unknown or extra properties are REJECTED (400), so a client can never smuggle assignedBy,
  // revokedBy, companyId, platformId, kind, adminTier... into a request body.
  // ADR-0054 D11 (R5): the kit's LocalizedValidationPipe IS Nest's ValidationPipe with these same options; its failures keep their
  // `message: string[]`, gain `validation_error` and are rendered in en / fr / ar by AuthExceptionFilter.
  app.useGlobalPipes(new LocalizedValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: false }));
  // Additive only: preserves Nest's existing {statusCode, message, error} body, adds an optional `code`
  // (Stage 13.2) and `requestId`, and (the one narrow case that needs it) passes through any extra field
  // already on the exception's own response object. Never changes status or route behavior; `message` is rendered
  // in en / fr / ar from Accept-Language (ADR-0054, R5), English by default.
  app.useGlobalFilters(new AuthExceptionFilter(logger));
  app.useLogger(logger);
  // CORS is off unless origins are explicitly allow-listed. Never a wildcard with credentials.
  app.enableCors(cfg.corsOrigins.length ? { origin: cfg.corsOrigins, credentials: false } : false);
  // Stage 22 F3: a bounded hop count read from the right (never `true`, which trusts every hop and so the client-written leftmost entry).
  if (cfg.trustProxyHops > 0) app.getHttpAdapter().getInstance().set('trust proxy', cfg.trustProxyHops);
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('auth-service API')
    .setDescription('Identity, authentication, sessions and tenant/platform access scope for Nawara Solutions apps. Billing-derived entitlement and Subscription state live in billing-service (ADR-0044); business permissions in platform services.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  // Served under the routed /auth prefix (the gateway forwards only /auth/*) and only behind basic
  // auth: with no SWAGGER_PASSWORD configured the docs are not mounted at all.
  if (cfg.docs.password) {
    const guard = basicAuth(cfg.docs.username, cfg.docs.password);
    app.use(['/auth/docs', '/auth/docs-json'], guard);
    SwaggerModule.setup('auth/docs', app, SwaggerModule.createDocument(app, config));
  }

  await app.listen(cfg.port);
  // Stage 14.7: one line that identifies this instance (no URL, credential or config dump). Liveness is /health, readiness /ready.
  logger.info('service_started', { port: cfg.port, environment: cfg.env, domainEvents: cfg.events.enabled ? 'outbox' : 'off' });
}
await bootstrap();
