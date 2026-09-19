import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { BillingConfig } from '../config/billing-config.js';
import { basicAuth } from './basic-auth.js';

/**
 * Serves OpenAPI under the routed /billing prefix (the gateway forwards only /billing/*) and ONLY behind basic auth: with no
 * SWAGGER_PASSWORD configured the documentation is not mounted at all, so an unconfigured deployment exposes nothing.
 * Returns whether it was mounted.
 */
export function mountDocs(app: NestExpressApplication, config: BillingConfig): boolean {
  if (!config.docs.password) return false;
  const document = new DocumentBuilder()
    .setTitle('billing-service API')
    .setDescription('What is owed, why, how much, by whom, to whom and when (ADR-0035). Not the payment or accounting system.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  app.use(['/billing/docs', '/billing/docs-json'], basicAuth(config.docs.username, config.docs.password));
  SwaggerModule.setup('billing/docs', app, SwaggerModule.createDocument(app, document));
  return true;
}
