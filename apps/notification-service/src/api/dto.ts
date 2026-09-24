import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/*
 * OpenAPI shapes ONLY. The request is validated by `send-request.ts` (every field typed and bounded, unknown fields refused), not by
 * these classes, so the documented and the enforced contract are listed side by side and kept identical by `openapi.spec.ts`.
 */

export class RecipientDto {
  @ApiProperty({ example: 'user', description: 'A generic recipient type, lowercase.' }) type!: string;
  @ApiProperty({ example: 'u-123', description: 'An opaque id in the owning service (never contact data).' }) id!: string;
}

export class ChannelDto {
  @ApiProperty({ enum: ['EMAIL', 'SMS'] }) channel!: 'EMAIL' | 'SMS';
  @ApiProperty({ example: '+21620000000', description: 'SMS: canonical E.164 (no country is ever assumed). EMAIL: an address. Stored as given.' }) destination!: string;
}

export class SendNotificationDto {
  @ApiProperty({ example: 'membership.approved', description: 'A published template key the caller\'s policy allows.' }) template!: string;
  @ApiPropertyOptional({ nullable: true, format: 'uuid', description: 'Allowed only when the caller\'s policy says organizations: "request".' }) organizationId?: string | null;
  @ApiPropertyOptional({ type: RecipientDto, nullable: true }) recipient?: RecipientDto | null;
  @ApiPropertyOptional({ example: 'fr-TN', description: 'BCP 47. Resolved per channel: exact, then base language, then the platform default.' }) locale?: string | null;
  @ApiProperty({ type: [ChannelDto], description: '1-2 channels, each at most once.' }) channels!: ChannelDto[];
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, description: 'The template variables, validated against the template (secret ones are sealed, never returned).' }) data?: Record<string, unknown>;
  @ApiPropertyOptional({ format: 'date-time', nullable: true, description: 'In the future, at most NOTIFICATION_MAX_SCHEDULE_AHEAD_SEC ahead.' }) scheduledAt?: string | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true, description: 'Never delivered after this; after scheduledAt.' }) expiresAt?: string | null;
}

export class AcceptedDeliveryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['EMAIL', 'SMS'] }) channel!: string;
  @ApiProperty({ enum: ['PENDING'] }) status!: string;
}

export class AcceptedDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['accepted'] }) status!: string;
  @ApiProperty({ type: [AcceptedDeliveryDto] }) deliveries!: AcceptedDeliveryDto[];
}

export class DeliveryViewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['EMAIL', 'SMS', 'IN_APP'] }) channel!: string;
  @ApiProperty({ enum: ['PENDING', 'SENDING', 'SENT', 'FAILED', 'UNCONFIRMED', 'EXPIRED', 'CANCELLED'] }) status!: string;
  @ApiProperty() attempts!: number;
  @ApiProperty({ example: 'fr' }) locale!: string;
  @ApiProperty() templateVersion!: number;
  @ApiProperty({ nullable: true, example: '…00', description: 'The last 2 characters of the destination only.' }) destinationHint!: string | null;
  @ApiProperty({ nullable: true, format: 'date-time' }) sentAt!: string | null;
  @ApiProperty({ nullable: true, example: 'invalid_destination' }) failureCode!: string | null;
}

export class NotificationViewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() template!: string;
  @ApiProperty({ enum: ['SECURITY', 'TRANSACTIONAL', 'OPTIONAL'] }) category!: string;
  @ApiProperty({ nullable: true, format: 'uuid' }) organizationId!: string | null;
  @ApiProperty({ enum: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'], description: 'Derived from the deliveries (no stored status).' }) status!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ nullable: true, format: 'date-time' }) scheduledAt!: string | null;
  @ApiProperty({ nullable: true, format: 'date-time' }) expiresAt!: string | null;
  @ApiProperty({ nullable: true, format: 'date-time' }) cancelledAt!: string | null;
  @ApiProperty({ type: [DeliveryViewDto] }) deliveries!: DeliveryViewDto[];
}
