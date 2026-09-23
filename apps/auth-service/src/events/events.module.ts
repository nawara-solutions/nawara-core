import { Module, type DynamicModule } from '@nestjs/common';
import { RabbitMQModule } from '@golevelup/nestjs-rabbitmq';
import { EVENTS_EXCHANGE } from './events.constants.js';
import { EventsPublisherService } from './events-publisher.service.js';

/** The broker URL comes from the validated configuration (`AppConfig.events`), never straight from the environment. */
@Module({})
export class EventsModule {
  static register(rabbitmqUrl: string): DynamicModule {
    return {
      module: EventsModule,
      imports: [
        RabbitMQModule.forRoot({
          exchanges: [{ name: EVENTS_EXCHANGE, type: 'topic', options: { durable: true } }],
          uri: rabbitmqUrl,
          connectionInitOptions: { wait: false },
        }),
      ],
      providers: [EventsPublisherService],
      exports: [EventsPublisherService],
    };
  }
}
