import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JsonLogger, ReadinessRegistry, configureApp } from '@nawara/service-kit';
import { AppModule } from './app.module.js';
import { loadBillingConfig } from './config/billing-config.js';
import { mountDocs } from './docs/mount-docs.js';
import { registerRabbitmqReadiness } from './health/rabbitmq-readiness.js';

async function bootstrap() {
  const config = loadBillingConfig(); // throws ConfigError (fail closed), never echoing a value
  const logger = new JsonLogger(config.serviceName, config.logLevel);

  // bodyParser: false lets the kit install its own bounded JSON parser (size limit) inside configureApp.
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), { bodyParser: false, bufferLogs: true });
  configureApp(app, config, logger);

  if (config.rabbitmqUrl) registerRabbitmqReadiness(app.get(ReadinessRegistry), config.rabbitmqUrl);

  mountDocs(app, config);

  await app.listen(config.port);
}
await bootstrap();
