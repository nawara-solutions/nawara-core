import { Module } from '@nestjs/common';
import { RateLimitModule } from '@nawara/service-kit';
import { IntakeModule } from '../intake/intake.module.js';
import { NotificationApiController } from './notification-api.controller.js';
import { NotificationApiService } from './notification-api.service.js';

/** Stage 16.6: the internal send API (SDD §7.2). It shares the intake core with the event intake. */
@Module({ imports: [IntakeModule, RateLimitModule], controllers: [NotificationApiController], providers: [NotificationApiService] })
export class ApiModule {}
