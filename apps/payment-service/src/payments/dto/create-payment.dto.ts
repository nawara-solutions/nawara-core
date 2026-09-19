import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PartyDto } from './party.dto.js';

const OFFSET_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** The payment request contract (SDD section 3.1): the message by which an authorized producer asks payment-service
 * to collect one obligation. Unknown fields are rejected globally (the kit's ValidationPipe, `forbidNonWhitelisted`). */
export class CreatePaymentDto {
  @ApiProperty({ format: 'uuid', description: 'Producer-generated; the natural idempotency key together with the calling service' })
  @IsUUID()
  paymentRequestId!: string;

  @ApiProperty({ description: "The producer's own opaque vocabulary, e.g. \"invoice\". Payment never interprets it.", pattern: '^[a-z][a-z0-9_]{1,62}$' })
  @Matches(/^[a-z][a-z0-9_]{1,62}$/)
  sourceType!: string;

  @ApiProperty({ description: "Id in the producer's system; no foreign key, no lookup", minLength: 1, maxLength: 128 })
  @IsString()
  @Length(1, 128)
  sourceId!: string;

  @ApiProperty({ type: PartyDto, description: 'Who pays' })
  @ValidateNested()
  @Type(() => PartyDto)
  payer!: PartyDto;

  @ApiProperty({ type: PartyDto, description: 'Who is paid (merchant/issuer); must differ from payer' })
  @ValidateNested()
  @Type(() => PartyDto)
  seller!: PartyDto;

  @ApiPropertyOptional({ format: 'uuid', description: 'The organization isolation boundary; must equal seller.id when seller.type is organization' })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({ description: 'Integer minor units', minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amount!: number;

  @ApiProperty({ description: 'ISO 4217, upper case', pattern: '^[A-Z]{3}$' })
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @ApiPropertyOptional({ description: 'Absolute timestamp with an explicit offset. Null/absent: no expiry (SDD O-16, not yet decided).' })
  @IsOptional()
  @Matches(OFFSET_TIMESTAMP)
  expiresAt?: string;

  @ApiPropertyOptional({ description: 'Statement/display text only. Never used in a decision.', maxLength: 140 })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  description?: string;

  @ApiPropertyOptional({ description: 'For example an invoice number. Never used in a decision.', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  reference?: string;
}
