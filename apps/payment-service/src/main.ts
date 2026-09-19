import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { JsonLogger, ReadinessRegistry, configureApp } from '@nawara/service-kit';
import { AppModule } from './app.module.js';
import { basicAuth } from './docs/basic-auth.js';
import { loadPaymentConfig } from './config/payment-config.js';
import { registerRabbitmqReadiness } from './health/rabbitmq-readiness.js';

async function bootstrap() {
  const config = loadPaymentConfig(); // throws ConfigError (fail closed), without echoing values
  const logger = new JsonLogger(config.serviceName, config.logLevel);

  // rawBody: true captures the exact request bytes into req.rawBody (needed for webhook signature verification,
  // section 7 of the SDD) alongside the normal parsed body; bodyParser: false lets the kit install its own bounded one.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, rawBody: true, bufferLogs: true });
  configureApp(app, config, logger);

  if (config.rabbitmqUrl) registerRabbitmqReadiness(app.get(ReadinessRegistry), config.rabbitmqUrl);

  const document = new DocumentBuilder()
    .setTitle('payment-service API')
    .setDescription('How an obligation was paid, by which method, and the payment state (ADR-0035). Not the billing or accounting system.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  // Served under the routed /payment prefix (the gateway forwards only /payment/*) and only behind basic auth: with
  // no SWAGGER_PASSWORD configured the docs are not mounted at all.
  if (config.docs.password) {
    const guard = basicAuth(config.docs.username, config.docs.password);
    app.use(['/payment/docs', '/payment/docs-json'], guard);
    SwaggerModule.setup('payment/docs', app, SwaggerModule.createDocument(app, document));
  }

  await app.listen(config.port);
}
await bootstrap();
