import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { AuditConfig } from '../config/audit-config.js';
import { basicAuth } from './basic-auth.js';

/**
 * OpenAPI under the routed /audit prefix and ONLY behind basic auth: with no SWAGGER_PASSWORD the documentation is not mounted at all
 * (the File / Billing / Organization / Notification pattern). Returns whether it was mounted.
 */
export function mountDocs(app: NestExpressApplication, config: AuditConfig): boolean {
  if (!config.docs.password) return false;
  const document = new DocumentBuilder()
    .setTitle('audit-service API')
    .setDescription(
      'Security and business audit trail (ADR-0049). Reads for trusted internal services only: a service token and the caller policy ' +
        '(read_organization: one organization; read_platform: platform scope, every read recorded). Evidence arrives only over the bus.',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  app.use(['/audit/docs', '/audit/docs-json'], basicAuth(config.docs.username, config.docs.password));
  SwaggerModule.setup('audit/docs', app, SwaggerModule.createDocument(app, document));
  return true;
}
