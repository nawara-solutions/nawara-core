import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ACCEPTED_PURPOSES, type PaymentPurpose } from '../payment.types.js';
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

  @ApiPropertyOptional({
    enum: ACCEPTED_PURPOSES,
    description: "Core V2 S4a: the producer's immutable settlement purpose (ADR-0044 B2). REQUIRED for every new payment; absent only when " +
      'replaying a payment created before S4a. organization_subscription and direct_purchase are paid by a user, non_entitlement by a ' +
      'user or a Company. An Organization payer pays exactly assisted_settlement or recovery_settlement (Core V2 S4e: only a caller holding ' +
      'the default-denied payment.create.organization_payer, 403 otherwise; organizationId is the payer). liveMode is never a field: ' +
      'Payment derives it (false: Core V2 is simulation only).',
  })
  @IsOptional()
  @IsString() // the value is checked by the service: an unknown or not-yet-open purpose is 400 invalid_payment_request (P-7)
  purpose?: PaymentPurpose;

  @ApiPropertyOptional({ description: 'Core V2 S4a: the beneficiary user; required for direct_purchase (and equal to the payer) and assisted_settlement (Core V2 S4e), forbidden otherwise.', minLength: 1, maxLength: 128 })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  beneficiaryUserId?: string;
}
