import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Length, MaxLength, Matches, Max, Min, MinLength } from 'class-validator';

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
  @ApiProperty({ description: 'Onboarding hint for the app only. Auth stores it but enforces nothing from it; it carries no commercial authority.' })
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

export class CreateAdminInvitationDto {
  @ApiProperty({ description: 'Opaque, platform-defined label the platform interprets as its own privileged role (stored as the new member\'s role). "admin" is reserved.' })
  @IsString() @Matches(/^(?!admin$)[a-z][a-z0-9_-]{0,31}$/) invitationType!: string;
  @ApiPropertyOptional({ description: 'How long the invitation stays valid, in minutes. The server enforces its configured range (default 15 min to 7 days; default 24 h) and computes the absolute expiry; the client cannot set expiresAt.' })
  @IsOptional() @IsInt() @Min(1) @Max(43_200) expiresInMinutes?: number;
  @ApiPropertyOptional({ description: 'Optional: the e-mail or phone of the intended person. Acceptance must then use exactly that contact. Only an HMAC is stored.' })
  @IsOptional() @IsString() @MaxLength(254) inviteeContact?: string;
}

export class ResolveInvitationDto {
  @ApiProperty({ description: 'The administrator invitation code handed out by an authorized inviter.' })
  @IsString() @Length(12, 64) invitationCode!: string;
}

export class AcceptInvitationDto {
  @ApiProperty() @IsString() @Length(12, 64) invitationCode!: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @ApiProperty() @IsString() @MinLength(10) @MaxLength(72) password!: string;
}
