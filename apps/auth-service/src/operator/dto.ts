import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';

export class CreateOperatorDto {
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) phone?: string;
}
export class OperatorRequestCodeDto {
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) phone?: string;
}
export class OperatorCodeDto extends OperatorRequestCodeDto {
  @ApiProperty() @IsString() @Length(6, 6) code!: string;
}
export class GrantAssignmentDto {
  @ApiProperty() @IsUUID() platformId!: string;
}
