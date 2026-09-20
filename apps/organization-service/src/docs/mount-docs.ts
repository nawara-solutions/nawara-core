import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OrganizationConfig } from '../config/organization-config.js';
import { basicAuth } from './basic-auth.js';

/**
 * Serves OpenAPI under the routed /organization prefix (the gateway forwards only /organization/*, ADR-0034) and ONLY behind
 * basic auth: with no SWAGGER_PASSWORD configured the documentation is not mounted at all. Returns whether it was mounted.
 */
export function mountDocs(app: NestExpressApplication, config: OrganizationConfig): boolean {
  if (!config.docs.password) return false;
  const document = new DocumentBuilder()
    .setTitle('organization-service API')
    .setDescription(
      'Company, Platform and Organization and the relationships between them (ADR-0031). IMPLEMENTED, BUT NOT YET AUTHORITATIVE: ' +
        'auth-service still owns these entities until the ownership migration of ADR-0039 is performed. Users, credentials, sessions ' +
        'and organization membership are never owned here.',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  app.use(['/organization/docs', '/organization/docs-json'], basicAuth(config.docs.username, config.docs.password));
  SwaggerModule.setup('organization/docs', app, SwaggerModule.createDocument(app, document));
  return true;
}
