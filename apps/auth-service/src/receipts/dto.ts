import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { IsObject, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * The receipts' wire DTOs (Core V2 S2-Auth.2; D-A2 receipt contract §5). `binding` is validated as an object here and then parsed
 * STRICTLY by `parseBinding` (exactly the F-2 fields, their types and canonical forms), so an extra, missing or mistyped field is
 * `400 receipt_binding_invalid`, never silently dropped. No field is ever echoed in an error.
 */
export class RefundBindingDto {
  @ApiProperty({ enum: ['refund'] }) operation!: 'refund';
  @ApiProperty({ enum: ['payment-service'] }) audience!: 'payment-service';
  @ApiProperty({ format: 'uuid', description: "The Owner's own Company." }) companyId!: string;
  @ApiProperty({ format: 'uuid' }) refundCaseId!: string;
  @ApiProperty({ format: 'uuid' }) paymentId!: string;
  @ApiProperty({ type: 'integer', minimum: 1, description: 'Minor units.' }) amount!: number;
  @ApiProperty({ pattern: '^[A-Z]{3}$', description: 'ISO 4217, upper case.' }) currency!: string;
  @ApiProperty({ pattern: '^[a-z][a-z0-9_]{0,63}$', description: 'A bounded reason code, never free text (Q2).' }) reason!: string;
  @ApiPropertyOptional({ default: false, description: 'Part of what the Owner approved; confers no authority (Q1).' }) legalOverride?: boolean;
}

/** Core V2 S6e Auth prerequisite (the Owner's R6E-3): an Owner's decision on one Payment dispute of their own Company. */
export class DisputeDecisionBindingDto {
  @ApiProperty({ enum: ['dispute_decision'] }) operation!: 'dispute_decision';
  @ApiProperty({ enum: ['payment-service'] }) audience!: 'payment-service';
  @ApiProperty({ format: 'uuid', description: "The Owner's own Company." }) companyId!: string;
  @ApiProperty({ format: 'uuid' }) disputeId!: string;
  @ApiProperty({ format: 'uuid' }) paymentId!: string;
  @ApiProperty({ enum: ['contest', 'accept'] }) decision!: 'contest' | 'accept';
}

/** A refund binding or a dispute-decision binding, by `operation` (parsed strictly by `parseBinding`). */
const BINDING_SCHEMA = { oneOf: [{ $ref: getSchemaPath(RefundBindingDto) }, { $ref: getSchemaPath(DisputeDecisionBindingDto) }] };

@ApiExtraModels(RefundBindingDto, DisputeDecisionBindingDto)
/** AUTH-01 body. The step-up proof is never stored with the receipt, logged, audited or part of the replay hash (D-A2 §12). */
export class IssueReceiptDto {
  @ApiProperty({ format: 'uuid', description: "A fresh, factor-only step-up proof of this session for the binding's operation: the refund-authorization purpose (refund) or the dispute-decision purpose (dispute_decision)." })
  @IsString() @MaxLength(64) stepUpToken!: string;

  @ApiProperty(BINDING_SCHEMA) @IsObject() binding!: Record<string, unknown>;
}

export class IssuedReceiptDto {
  @ApiProperty({ format: 'uuid' }) receiptId!: string;
  @ApiProperty({ description: 'base64url of 32 random bytes. Returned ONCE, in this response only; never on a replay.' }) secret!: string;
  @ApiProperty({ format: 'date-time', description: 'issuedAt + 10 minutes, by the database clock.' }) expiresAt!: string;
}

/** AUTH-02 body. */
export class ConsumeReceiptDto {
  @ApiProperty({ description: 'The receipt secret from AUTH-01.' }) @IsString() @MaxLength(64) secret!: string;
  @ApiProperty(BINDING_SCHEMA) @IsObject() binding!: Record<string, unknown>;
  @ApiProperty({ format: 'uuid', description: "The consumer's durable reference for this consumption (its attempt id)." })
  @IsUUID() consumeRef!: string;
}

/** AUTH-03 body: no secret (F-10). A POST so the binding never travels in a URL. */
export class LookupConsumptionDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() consumeRef!: string;
  @ApiProperty(BINDING_SCHEMA) @IsObject() binding!: Record<string, unknown>;
}

export class ApprovedByDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
}

/** AUTH-02 and AUTH-03 response: never a secret. `approvedBy` is the issuer from Auth's own row (F-16). */
export class ReceiptConsumptionDto {
  @ApiProperty({ format: 'uuid' }) receiptId!: string;
  @ApiProperty({ format: 'uuid' }) consumeRef!: string;
  @ApiProperty({ format: 'date-time' }) consumedAt!: string;
  @ApiProperty({ type: ApprovedByDto }) approvedBy!: ApprovedByDto;
  @ApiProperty({ format: 'uuid' }) companyId!: string;
}
