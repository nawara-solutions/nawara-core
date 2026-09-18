import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

export class ResolveJoinCodeDto {
  @ApiProperty({ description: 'The organization join code as handed out by the organization.' })
  @IsString() @Length(10, 64) joinCode!: string;
}

export class VerifyContactDto {
  @ApiProperty({ description: '6-digit code delivered to the member’s e-mail or phone.' })
  @IsString() @Matches(/^\d{6}$/) code!: string;
}

export class CreateJoinCodeDto {
  @ApiProperty({ description: 'Opaque registration audience label chosen by the platform (e.g. "student", "teacher"). Auth never interprets it; "admin" is reserved.' })
  @IsString() @Matches(/^(?!admin$)[a-z][a-z0-9_-]{0,31}$/) audience!: string;
  @ApiProperty({ description: 'New members start as PENDING and need an organization decision.' })
  @IsBoolean() requiresApproval!: boolean;
  @ApiProperty({ description: 'Onboarding hint for the app only; entitlement is owned by payment-service.' })
  @IsBoolean() requiresSubscription!: boolean;
  @ApiPropertyOptional({ description: 'Days until the code expires (default 30, max 365). Codes are never permanent.' })
  @IsOptional() @IsInt() @Min(1) @Max(365) expiresInDays?: number;
  @ApiPropertyOptional({ description: 'Maximum number of registrations; unlimited when omitted.' })
  @IsOptional() @IsInt() @Min(1) @Max(100_000) maxUses?: number;
}

export class ListMembershipsQuery {
  @ApiPropertyOptional({ enum: ['pending', 'active', 'rejected'], default: 'pending' })
  @IsOptional() @IsIn(['pending', 'active', 'rejected']) status?: 'pending' | 'active' | 'rejected';
}
