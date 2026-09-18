import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, IsUUID, Length, MaxLength, MinLength } from 'class-validator';

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
