import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, IsUrl, Matches } from 'class-validator';

export class StartAttemptDto {
  @ApiPropertyOptional({ description: 'Must be an enabled provider (only the test provider in this phase).', default: 'test' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9_-]{0,62}$/)
  provider?: string;

  @ApiPropertyOptional({ description: 'Opaque, validated by the adapter (e.g. the test provider\'s `scenario`).' })
  @IsOptional()
  @IsObject()
  providerOptions?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Must match a configured allow-list. Not yet enforced against a real allow-list mechanism.' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  returnUrl?: string;
}
