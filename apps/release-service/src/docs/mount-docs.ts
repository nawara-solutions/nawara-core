import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { ReleaseConfig } from '../config/release-config.js';
import { basicAuth } from './basic-auth.js';

/**
 * OpenAPI under the routed /release prefix and ONLY behind basic auth: with no SWAGGER_PASSWORD the documentation is not mounted at all
 * (the File / Audit / Billing / Organization / Notification pattern). Returns whether it was mounted. Stage 20.3 documents the only
 * business routes that exist: CI registration and publication.
 */
export function mountDocs(app: NestExpressApplication, config: ReleaseConfig): boolean {
  if (!config.docs.password) return false;
  const document = new DocumentBuilder()
    .setTitle('release-service API')
    .setDescription(
      'Release metadata and client compatibility (ADR-0051), never delivery. CI automation (Stage 20.3) registers and publishes releases ' +
        'with a service token and a per-product policy (release.register / release.publish). The owner of the operating Company (Stage 20.4), ' +
        'with their own Auth bearer and a factor step-up, withdraws releases and changes minimum versions. No operator route exists.',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  app.use(['/release/docs', '/release/docs-json'], basicAuth(config.docs.username, config.docs.password));
  SwaggerModule.setup('release/docs', app, SwaggerModule.createDocument(app, document));
  return true;
}
