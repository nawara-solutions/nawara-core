import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { FileConfig } from '../config/file-config.js';
import { basicAuth } from './basic-auth.js';

/**
 * OpenAPI under the routed /file prefix and ONLY behind basic auth: with no SWAGGER_PASSWORD the documentation is not mounted at all
 * (the Billing / Organization / Notification pattern). Returns whether it was mounted.
 */
export function mountDocs(app: NestExpressApplication, config: FileConfig): boolean {
  if (!config.docs.password) return false;
  const document = new DocumentBuilder()
    .setTitle('file-service API')
    .setDescription(
      'Generic file objects (ADR-0048). Service routes need a service token and the caller policy; the ticket route (/file/t/{token}) ' +
        'needs only the ticket. Bytes are raw streamed bodies with a required Content-Length; the type is decided from the bytes.',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  app.use(['/file/docs', '/file/docs-json'], basicAuth(config.docs.username, config.docs.password));
  SwaggerModule.setup('file/docs', app, SwaggerModule.createDocument(app, document));
  return true;
}
