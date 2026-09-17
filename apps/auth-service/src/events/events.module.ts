import { Module } from '@nestjs/common';
import { RabbitMQModule } from '@golevelup/nestjs-rabbitmq';
import { EVENTS_EXCHANGE } from './events.constants.js';
import { EventsPublisherService } from './events-publisher.service.js';

@Module({
  imports: [
    RabbitMQModule.forRoot({
      exchanges: [{ name: EVENTS_EXCHANGE, type: 'topic', options: { durable: true } }],
      uri: process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672',
      connectionInitOptions: { wait: false },
    }),
  ],
  providers: [EventsPublisherService],
  exports: [EventsPublisherService],
})
export class EventsModule {}
