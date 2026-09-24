import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NotificationConfig } from '../config/notification-config.js';
import { basicAuth } from './basic-auth.js';

/**
 * Serves OpenAPI under the routed /notification prefix and ONLY behind basic auth: with no SWAGGER_PASSWORD configured the documentation
 * is not mounted at all (the Billing / Organization pattern). Returns whether it was mounted.
 */
export function mountDocs(app: NestExpressApplication, config: NotificationConfig): boolean {
  if (!config.docs.password) return false;
  const document = new DocumentBuilder()
    .setTitle('notification-service API')
    .setDescription(
      'Internal, service-to-service: trusted Core services record notification intents by template (ADR-0046). The API accepts durable work ' +
        '(202) and never sends synchronously. Service token required on every route; Idempotency-Key required on POST.',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  app.use(['/notification/docs', '/notification/docs-json'], basicAuth(config.docs.username, config.docs.password));
  SwaggerModule.setup('notification/docs', app, SwaggerModule.createDocument(app, document));
  return true;
}
