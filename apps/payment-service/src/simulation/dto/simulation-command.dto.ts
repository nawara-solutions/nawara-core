import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, ValidateIf } from 'class-validator';

/** The caller's stable identity for one command (F-S6): the shape of an Idempotency-Key. */
const COMMAND_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export const INITIATION_MODES = ['accepted', 'ambiguous', 'rejected'] as const;
export const OUTCOMES = ['succeeded', 'amount_mismatch', 'failed', 'expired', 'no_record', 'pending'] as const;
export const DELIVERIES = ['immediate', 'held'] as const;

/** How the simulation provider answers the next attempts of one payment. No money, payer or settlement field exists (F-S3). */
export class SimulationInitiationDto {
  @ApiProperty({ description: 'Stable identity of this command: an identical replay changes nothing; other content under it is refused.', pattern: COMMAND_ID.source })
  @IsString()
  @Matches(COMMAND_ID)
  commandId!: string;

  @ApiProperty({ enum: INITIATION_MODES, description: '`accepted` (the default when no plan exists), `ambiguous` (recorded by the provider, answer lost), `rejected` (declined at initiation).' })
  @IsIn(INITIATION_MODES)
  mode!: (typeof INITIATION_MODES)[number];

  @ApiPropertyOptional({ description: 'Required for, and only for, `rejected`.', pattern: FAILURE_CODE.source })
  @ValidateIf((o: SimulationInitiationDto) => o.mode === 'rejected' || o.failureCode !== undefined)
  @IsString()
  @Matches(FAILURE_CODE)
  failureCode?: string;
}

/** What the simulation provider says happened to one of its attempts. Amount, currency and transaction are derived by Payment (F-S3). */
export class SimulationOutcomeDto {
  @ApiProperty({ description: 'Stable identity of this command: an identical replay changes nothing; other content under it is refused.', pattern: COMMAND_ID.source })
  @IsString()
  @Matches(COMMAND_ID)
  commandId!: string;

  @ApiProperty({
    enum: OUTCOMES,
    description: '`succeeded` (the snapshot amount), `amount_mismatch` (one minor unit away), `failed`, `expired` (provider session expiry), `no_record` (the provider has no record: status read only), `pending` (status read only).',
  })
  @IsIn(OUTCOMES)
  outcome!: (typeof OUTCOMES)[number];

  @ApiPropertyOptional({ description: 'Required for, and only for, `failed`.', pattern: FAILURE_CODE.source })
  @ValidateIf((o: SimulationOutcomeDto) => o.outcome === 'failed' || o.failureCode !== undefined)
  @IsString()
  @Matches(FAILURE_CODE)
  failureCode?: string;

  @ApiPropertyOptional({ enum: DELIVERIES, default: 'immediate', description: 'For an outcome with a notification: deliver it now, or hold it for a later deliver call (delayed / out-of-order delivery).' })
  @IsOptional()
  @IsIn(DELIVERIES)
  delivery?: (typeof DELIVERIES)[number];
}

/** Core V2 S6b (R6B-6): how the simulated provider answers the refund dispatches of one payment. No money or outcome-owner field exists. */
export const REFUND_DISPATCH_MODES = ['accepted', 'ambiguous', 'rejected'] as const;
export const REFUND_OUTCOMES = ['succeeded', 'amount_mismatch', 'failed', 'no_record', 'pending'] as const;

export class SimulationRefundDispatchPlanDto {
  @ApiProperty({ description: 'Stable identity of this command: an identical replay changes nothing; other content under it is refused.', pattern: COMMAND_ID.source })
  @IsString()
  @Matches(COMMAND_ID)
  commandId!: string;

  @ApiProperty({ enum: REFUND_DISPATCH_MODES, description: '`accepted` (the default when no plan exists), `ambiguous` (recorded by the provider, its answer lost), `rejected` (declined: definitive for the key).' })
  @IsIn(REFUND_DISPATCH_MODES)
  mode!: (typeof REFUND_DISPATCH_MODES)[number];

  @ApiPropertyOptional({ description: 'Required for, and only for, `rejected`.', pattern: FAILURE_CODE.source })
  @ValidateIf((o: SimulationRefundDispatchPlanDto) => o.mode === 'rejected' || o.failureCode !== undefined)
  @IsString()
  @Matches(FAILURE_CODE)
  failureCode?: string;
}

/** What the simulated provider says happened to one refund it received. Amount, currency and the refund reference are derived by Payment. */
export class SimulationRefundOutcomeDto {
  @ApiProperty({ description: 'Stable identity of this command: an identical replay changes nothing; other content under it is refused.', pattern: COMMAND_ID.source })
  @IsString()
  @Matches(COMMAND_ID)
  commandId!: string;

  @ApiProperty({
    enum: REFUND_OUTCOMES,
    description: '`succeeded` (the attempt amount), `amount_mismatch` (one minor unit away), `failed` (provider-confirmed), `no_record` (status read only), `pending` (status read only).',
  })
  @IsIn(REFUND_OUTCOMES)
  outcome!: (typeof REFUND_OUTCOMES)[number];

  @ApiPropertyOptional({ description: 'Required for, and only for, `failed`.', pattern: FAILURE_CODE.source })
  @ValidateIf((o: SimulationRefundOutcomeDto) => o.outcome === 'failed' || o.failureCode !== undefined)
  @IsString()
  @Matches(FAILURE_CODE)
  failureCode?: string;

  @ApiPropertyOptional({ enum: DELIVERIES, default: 'immediate', description: 'For an outcome with a notification: deliver it now, or hold it for a later deliver call.' })
  @IsOptional()
  @IsIn(DELIVERIES)
  delivery?: (typeof DELIVERIES)[number];
}
