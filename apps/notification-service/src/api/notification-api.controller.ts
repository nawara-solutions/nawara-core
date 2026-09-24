import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CallerService, ServiceTokenGuard } from '@nawara/service-kit';
import { AcceptedDto, NotificationViewDto, SendNotificationDto } from './dto.js';
import { NotificationApiService } from './notification-api.service.js';

/**
 * The internal send API (SDD §7.2). Every route requires a Core service token (`ServiceTokenGuard`); the caller's identity is the
 * authenticated token, never a field of the request. Errors use the kit envelope `{ statusCode, message, error, code, requestId }`.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(ServiceTokenGuard)
@Controller('notification/notifications')
export class NotificationApiController {
  constructor(@Inject(NotificationApiService) private readonly api: NotificationApiService) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: 'Record a notification intent by template; accepted as durable work, never sent synchronously.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '8-128 of [A-Za-z0-9._:-]; the same key and body replay the original 202.' })
  @ApiBody({ type: SendNotificationDto })
  @ApiResponse({ status: 202, type: AcceptedDto, description: 'Committed: the intent and its PENDING deliveries.' })
  @ApiResponse({ status: 400, description: 'validation_error / idempotency_key_required' })
  @ApiResponse({ status: 401, description: 'No, a bad, a malformed or a non-service token.' })
  @ApiResponse({ status: 403, description: 'template_not_allowed / channel_not_allowed / organization_not_allowed (the caller policy)' })
  @ApiResponse({ status: 404, description: 'unknown_template' })
  @ApiResponse({ status: 422, description: 'idempotency_key_reused / invalid_template_data / invalid_destination / duplicate_channel / schedule_out_of_range' })
  @ApiResponse({ status: 429, description: 'rate_limited (the per-caller intake limit)' })
  send(@CallerService() caller: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    return this.api.send(caller, key, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'The status of a notification this caller created (derived from its deliveries).' })
  @ApiResponse({ status: 200, type: NotificationViewDto })
  @ApiResponse({ status: 401, description: 'No, a bad, a malformed or a non-service token.' })
  @ApiResponse({ status: 404, description: 'notification_not_found (also for a notification another caller created)' })
  get(@CallerService() caller: string, @Param('id') id: string) {
    return this.api.get(caller, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel every PENDING delivery of a notification this caller created. Idempotent.' })
  @ApiResponse({ status: 200, type: NotificationViewDto })
  @ApiResponse({ status: 401, description: 'No, a bad, a malformed or a non-service token.' })
  @ApiResponse({ status: 404, description: 'notification_not_found' })
  @ApiResponse({ status: 409, description: 'delivery_in_progress: a delivery is already being sent (the pending ones were cancelled)' })
  cancel(@CallerService() caller: string, @Param('id') id: string) {
    return this.api.cancel(caller, id);
  }
}
