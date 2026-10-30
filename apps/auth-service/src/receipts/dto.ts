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
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Core V2 R6H-5: the one verified capture fact a capture-specific refund returns. Omit it for an ordinary refund (never null): '
      + 'a capture-specific receipt never authorizes an ordinary refund or another capture, nor the reverse.',
  }) captureFactId?: string;
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

/** Core V2 S6e-H Auth prerequisite (the Owner's H-2): an Owner's placement of one fraud hold (consumed by billing-service only). */
export class FraudHoldPlaceBindingDto {
  @ApiProperty({ enum: ['fraud_hold_place'] }) operation!: 'fraud_hold_place';
  @ApiProperty({ enum: ['billing-service'] }) audience!: 'billing-service';
  @ApiProperty({ format: 'uuid', description: "The Owner's own Company." }) companyId!: string;
  @ApiProperty({ format: 'uuid', description: 'The hold to place (its id, chosen before placement).' }) holdId!: string;
  @ApiProperty({ format: 'uuid' }) beneficiaryUserId!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ pattern: '^[a-z][a-z0-9_]{0,63}$', description: 'A bounded fraud reason code, never free text.' }) reason!: string;
}

/** Core V2 S6e-H Auth prerequisite (the Owner's H-2): an Owner's release of one fraud hold (consumed by billing-service only). */
export class FraudHoldReleaseBindingDto {
  @ApiProperty({ enum: ['fraud_hold_release'] }) operation!: 'fraud_hold_release';
  @ApiProperty({ enum: ['billing-service'] }) audience!: 'billing-service';
  @ApiProperty({ format: 'uuid', description: "The Owner's own Company." }) companyId!: string;
  @ApiProperty({ format: 'uuid' }) holdId!: string;
  @ApiProperty({ format: 'uuid' }) beneficiaryUserId!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
}

/** Core V2 S6f Auth prerequisite (the Owner's R6F-5): an Owner's record of one external recovery-surplus repayment (billing-service only). */
export class SurplusExternalBindingDto {
  @ApiProperty({ enum: ['recovery_surplus_external'] }) operation!: 'recovery_surplus_external';
  @ApiProperty({ enum: ['billing-service'] }) audience!: 'billing-service';
  @ApiProperty({ format: 'uuid', description: "The Owner's own Company." }) companyId!: string;
  @ApiProperty({ format: 'uuid' }) surplusId!: string;
  @ApiProperty({ format: 'uuid', description: 'The Organization the surplus is owed to.' }) organizationId!: string;
  @ApiProperty({ type: 'integer', minimum: 1, description: 'Minor units.' }) amount!: number;
  @ApiProperty({ pattern: '^[A-Z]{3}$' }) currency!: string;
}

/** Core V2 S6g Auth prerequisite (the Owner's R6G-1): an Owner's L-4 application of one late assisted settlement (billing-service only). */
export class LateSettlementApplyBindingDto {
  @ApiProperty({ enum: ['late_settlement_apply'] }) operation!: 'late_settlement_apply';
  @ApiProperty({ enum: ['billing-service'] }) audience!: 'billing-service';
  @ApiProperty({ format: 'uuid', description: "The Owner's own Company." }) companyId!: string;
  @ApiProperty({ format: 'uuid' }) lateSettlementId!: string;
  @ApiProperty({ format: 'uuid' }) assistanceRequestId!: string;
  @ApiProperty({ format: 'uuid' }) beneficiaryUserId!: string;
  @ApiProperty({ enum: ['cash_not_returned_attested', 'cash_not_returned_evidenced'] }) reasonCode!: string;
}

/** Core V2 S6h Auth prerequisite (the Owner's R6H-3): an Owner's association of one unmatched provider fact (payment-service only). */
export class ProviderFactAssociateBindingDto {
  @ApiProperty({ enum: ['provider_fact_associate'] }) operation!: 'provider_fact_associate';
  @ApiProperty({ enum: ['payment-service'] }) audience!: 'payment-service';
  @ApiProperty({ format: 'uuid', description: "The Owner's own Company." }) companyId!: string;
  @ApiProperty({ format: 'uuid' }) factId!: string;
  @ApiProperty({ enum: ['capture', 'refund', 'chargeback'] }) kind!: string;
  @ApiProperty({ type: 'integer', minimum: 1, description: 'Minor units: the fact\'s own amount.' }) amount!: number;
  @ApiProperty({ pattern: '^[A-Z]{3}$' }) currency!: string;
  @ApiProperty({ enum: ['payment', 'refund_authorization'] }) targetType!: string;
  @ApiProperty({ format: 'uuid' }) targetId!: string;
}

/** Core V2 S6h Auth prerequisite (the Owner's R6H-8): an Owner's recovery write-off, loss recognition only (billing-service only). */
export class RecoveryWriteOffBindingDto {
  @ApiProperty({ enum: ['recovery_write_off'] }) operation!: 'recovery_write_off';
  @ApiProperty({ enum: ['billing-service'] }) audience!: 'billing-service';
  @ApiProperty({ format: 'uuid', description: "The Owner's own Company." }) companyId!: string;
  @ApiProperty({ format: 'uuid' }) obligationId!: string;
  @ApiProperty({ format: 'uuid' }) organizationId!: string;
  @ApiProperty({ type: 'integer', minimum: 1, description: 'Minor units: the outstanding amount written off.' }) amount!: number;
  @ApiProperty({ pattern: '^[A-Z]{3}$' }) currency!: string;
}

/** A refund, dispute-decision, fraud-hold, external-surplus, late-settlement, provider-fact association or recovery write-off binding, by `operation` (parsed strictly by `parseBinding`). */
const BINDING_SCHEMA = { oneOf: [RefundBindingDto, DisputeDecisionBindingDto, FraudHoldPlaceBindingDto, FraudHoldReleaseBindingDto, SurplusExternalBindingDto, LateSettlementApplyBindingDto,
  ProviderFactAssociateBindingDto, RecoveryWriteOffBindingDto].map((d) => ({ $ref: getSchemaPath(d) })) };

@ApiExtraModels(RefundBindingDto, DisputeDecisionBindingDto, FraudHoldPlaceBindingDto, FraudHoldReleaseBindingDto, SurplusExternalBindingDto, LateSettlementApplyBindingDto, ProviderFactAssociateBindingDto, RecoveryWriteOffBindingDto)
/** AUTH-01 body. The step-up proof is never stored with the receipt, logged, audited or part of the replay hash (D-A2 §12). */
export class IssueReceiptDto {
  @ApiProperty({ format: 'uuid', description: "A fresh, factor-only step-up proof of this session for the binding's operation: its own dedicated purpose (refund, dispute_decision, fraud_hold_place, fraud_hold_release, recovery_surplus_external, late_settlement_apply, provider_fact_associate, recovery_write_off)." })
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
