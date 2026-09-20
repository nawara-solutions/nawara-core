import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @ApiProperty() @IsString() @MinLength(10) @MaxLength(72) password!: string;
  @ApiProperty({ description: 'Organization join code. Organization, platform and audience are resolved from it server-side.' })
  @IsString() @Length(10, 64) joinCode!: string;
}

export class LoginDto {
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @ApiProperty() @IsString() @MaxLength(72) password!: string;
}

export class RefreshDto {
  @ApiProperty() @IsString() @Length(20, 200) refreshToken!: string;
}

export class VerifyStepUpDto {
  @ApiProperty({ description: 'The sensitive-operation purpose this step-up was issued for (e.g. "organization.create").' })
  @IsString() @Length(1, 64) purpose!: string;
  @ApiProperty({ description: 'The stepUpToken returned by POST /auth/admin/step-up.' })
  @IsString() @Length(20, 200) stepUpToken!: string;
}
