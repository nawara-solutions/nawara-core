import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { JsonLogger, requestContextMiddleware } from '@nawara/service-kit';
import { AppModule } from './app.module.js';
import { basicAuth } from './docs/basic-auth.js';
import { APP_CONFIG, type AppConfig } from './config/app-config.js';
import { AuthExceptionFilter } from './errors.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const cfg = app.get<AppConfig>(APP_CONFIG); // throws (fail closed) if any secret is missing/weak
  const logger = new JsonLogger('auth-service', 'info');

  // Request/correlation id first, so every log line and error response from this point on can carry it.
  app.use(requestContextMiddleware);
  app.use(helmet());
  // Unknown or extra properties are REJECTED (400), so a client can never smuggle assignedBy,
  // revokedBy, companyId, platformId, kind, adminTier... into a request body.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: false }));
  // Additive only: preserves Nest's existing {statusCode, message, error} body, adds an optional `code`
  // (Stage 13.2) and `requestId`, and (the one narrow case that needs it) passes through any extra field
  // already on the exception's own response object. Never changes status, message or route behavior.
  app.useGlobalFilters(new AuthExceptionFilter(logger));
  app.useLogger(logger);
  // CORS is off unless origins are explicitly allow-listed. Never a wildcard with credentials.
  app.enableCors(cfg.corsOrigins.length ? { origin: cfg.corsOrigins, credentials: false } : false);
  if (cfg.trustProxy) app.getHttpAdapter().getInstance().set('trust proxy', true);
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

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
