import { Module } from '@nestjs/common';
import { EventConsumer } from './event-consumer.js';
import { IntakeService } from './intake.service.js';
import { IntentCore } from './intent-core.js';

/** Stage 16.5: the event intake (SDD §7.1). The bus and the configuration come from the application module. */
@Module({ providers: [IntentCore, IntakeService, EventConsumer], exports: [IntentCore, IntakeService, EventConsumer] })
export class IntakeModule {}
