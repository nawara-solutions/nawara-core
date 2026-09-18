import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsObject, IsOptional, IsString, IsUUID, Length, MaxLength, MinLength } from 'class-validator';

export class OwnerVerifyDto {
  @ApiProperty() @IsString() @Length(20, 200) challengeToken!: string;
  @ApiProperty({ enum: ['totp', 'webauthn'] }) @IsIn(['totp', 'webauthn']) method!: 'totp' | 'webauthn';
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(6, 6) code?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() assertion?: any;
}
export class ChallengeTokenDto {
  @ApiProperty() @IsString() @Length(20, 200) challengeToken!: string;
}
export class EnrollTokenDto {
  @ApiProperty() @IsString() @Length(20, 200) enrollmentToken!: string;
}
export class ConfirmTotpDto {
  @ApiProperty() @IsUUID() factorId!: string;
  @ApiProperty() @IsString() @Length(6, 6) code!: string;
}
export class EnrollTotpConfirmDto extends ConfirmTotpDto {
  @ApiProperty() @IsString() @Length(20, 200) enrollmentToken!: string;
}
export class RegisterWebauthnDto {
  @ApiProperty() @IsUUID() challengeId!: string;
  @ApiProperty() @IsObject() response!: any;
}
export class EnrollRegisterWebauthnDto extends RegisterWebauthnDto {
  @ApiProperty() @IsString() @Length(20, 200) enrollmentToken!: string;
}
export class StepUpDto {
  @ApiProperty() @IsString() @MaxLength(64) purpose!: string;
  @ApiProperty({ enum: ['secret_key', 'totp', 'webauthn'] }) @IsIn(['secret_key', 'totp', 'webauthn']) method!: 'secret_key' | 'totp' | 'webauthn';
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(6, 6) code?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) secretKey?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() challengeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() assertion?: any;
}
export class StepUpOptionsDto {
  @ApiProperty() @IsString() @MaxLength(64) purpose!: string;
}
export class RecoveryStartDto {
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @ApiProperty() @IsString() @MaxLength(72) password!: string;
  @ApiProperty() @IsString() @MaxLength(80) secretKey!: string;
}
export class RecoveryCompleteDto {
  @ApiProperty() @IsString() @Length(20, 200) recoveryToken!: string;
  @ApiProperty() @IsString() @MaxLength(80) secretKey!: string;
}
export class ChangePasswordDto {
  @ApiProperty() @IsString() @MinLength(10) @MaxLength(72) newPassword!: string;
}
