import { Logger, Module, type DynamicModule } from '@nestjs/common';
import { RabbitMqEventBus } from '@nawara/service-kit';
import { EVENTS_EXCHANGE } from './events.constants.js';
import { EventsPublisherService, KIT_EVENT_BUS } from './events-publisher.service.js';

/**
 * The broker settings come from the validated configuration (`AppConfig.events`), never straight from the environment.
 * Stage 16.2: the kit's `RabbitMqEventBus` (canonical envelope, persistent, bounded publisher confirm) replaces the
 * `@golevelup/nestjs-rabbitmq` connection. It connects lazily, on the first publish: startup does not depend on the broker.
 */
@Module({})
export class EventsModule {
  static register(events: { rabbitmqUrl: string; confirmTimeoutMs: number }): DynamicModule {
    return {
      module: EventsModule,
      providers: [
        {
          provide: KIT_EVENT_BUS,
          useFactory: () =>
            new RabbitMqEventBus({
              url: events.rabbitmqUrl,
              exchange: EVENTS_EXCHANGE,
              confirmTimeoutMs: events.confirmTimeoutMs,
              // Operational notices (confirm timeouts, above all). Never a URL, credential or payload.
              onNotice: (message, level) => new Logger('RabbitMqEventBus')[level === 'info' ? 'log' : level](message),
            }),
        },
        EventsPublisherService,
      ],
      exports: [EventsPublisherService],
    };
  }
}
