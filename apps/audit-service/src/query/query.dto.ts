import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** OpenAPI description of the response only (the query string is parsed strictly by `parseQuery`, not by a DTO). */
export class AuditActorDto {
  @ApiProperty({ enum: ['user', 'service', 'system'] }) type!: string;
  @ApiProperty({ description: 'A user UUID, a service name or a cataloged process code' }) id!: string;
  @ApiPropertyOptional({ enum: ['member', 'owner', 'operator'], description: 'Only for a user actor: its kind when it acted' }) userKind?: string;
}

export class AuditReferenceDto {
  @ApiProperty({ example: 'membership' }) type!: string;
  @ApiProperty({ format: 'uuid' }) id!: string;
}

export class AuditRecordDto {
  @ApiProperty({ format: 'uuid', description: 'The producer\'s event id (unique per source service)' }) eventId!: string;
  @ApiProperty({ format: 'date-time', description: 'When the action happened (the producer\'s database clock)' }) occurredAt!: string;
  @ApiProperty({ format: 'date-time', description: 'When Audit stored it (Audit\'s clock)' }) recordedAt!: string;
  @ApiProperty({ example: 'membership.revoked', description: 'A cataloged action (docs/architecture/audit-event-catalog.md)' }) action!: string;
  @ApiProperty({ enum: ['security', 'business', 'commercial', 'administrative'] }) category!: string;
  @ApiProperty({ example: 'auth-service' }) sourceService!: string;
  @ApiProperty({ type: AuditActorDto }) actor!: AuditActorDto;
  @ApiProperty({ format: 'uuid', nullable: true, type: String, description: 'null = a platform-level record' }) organizationId!: string | null;
  @ApiProperty({ type: AuditReferenceDto }) resource!: AuditReferenceDto;
  @ApiProperty({ type: AuditReferenceDto, nullable: true }) subject!: AuditReferenceDto | null;
  @ApiProperty({ enum: ['succeeded', 'denied'] }) outcome!: string;
  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true, description: 'Cataloged change facts only' }) changes!: Record<string, unknown> | null;
  @ApiProperty({ nullable: true, type: String, description: 'Navigation only, never evidence' }) correlationId!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) causationId!: string | null;
}

export class AuditPageDto {
  @ApiProperty({ type: [AuditRecordDto] }) items!: AuditRecordDto[];
  @ApiProperty({ nullable: true, type: String, description: 'Opaque; valid only with the same query; null when there is no further page' }) nextCursor!: string | null;
}
