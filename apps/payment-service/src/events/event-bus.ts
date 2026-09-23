import { Logger } from '@nestjs/common';
import { ConfigError, InMemoryEventBus, RabbitMqEventBus, type EventBus } from '@nawara/service-kit';
import type { PaymentConfig } from '../config/payment-config.js';

/**
 * The event bus the outbox relay publishes to. RabbitMQ whenever it is configured; the in-memory bus only outside production,
 * where it is a development and test convenience. Configuration already refuses a production run without `RABBITMQ_URL`; this
 * repeats the rule at the point of choice so no future caller can select the in-memory bus in production by accident.
 * Stage 14.7: the bus's operational notices (publisher-confirm timeouts, above all) are logged; they were previously dropped here.
 */
export function createEventBus(config: Pick<PaymentConfig, 'rabbitmqUrl' | 'isProduction'> & Partial<Pick<PaymentConfig, 'rabbitmqConfirmTimeoutMs'>>): EventBus {
  if (config.rabbitmqUrl) {
    return new RabbitMqEventBus({
      url: config.rabbitmqUrl,
      confirmTimeoutMs: config.rabbitmqConfirmTimeoutMs,
      onNotice: (message, level) => new Logger('RabbitMqEventBus')[level === 'info' ? 'log' : level](message),
    });
  }
  if (config.isProduction) throw new ConfigError('RABBITMQ_URL is required in production (the in-memory event bus is for development and tests only)');
  return new InMemoryEventBus();
}
