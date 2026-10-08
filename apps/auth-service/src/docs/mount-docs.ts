import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { AppConfig } from '../config/app-config.js';
import { basicAuth } from './basic-auth.js';

/**
 * Serves OpenAPI under the routed /auth prefix (the gateway forwards only /auth/*) and ONLY behind basic auth: with no
 * SWAGGER_PASSWORD configured the documentation is not mounted at all. Returns whether it was mounted. (V2 A4.4: moved unchanged from
 * main.ts, the same shape as the other services' docs/mount-docs.ts.)
 */
export function mountDocs(app: NestExpressApplication, cfg: AppConfig): boolean {
  if (!cfg.docs.password) return false;
  const document = new DocumentBuilder()
    .setTitle('auth-service API')
    .setDescription('Identity, authentication, sessions and tenant/platform access scope for Nawara Solutions apps. Billing-derived entitlement and Subscription state live in billing-service (ADR-0044); business permissions in platform services.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  app.use(['/auth/docs', '/auth/docs-json'], basicAuth(cfg.docs.username, cfg.docs.password));
  SwaggerModule.setup('auth/docs', app, SwaggerModule.createDocument(app, document));
  return true;
}
