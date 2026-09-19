import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Length } from 'class-validator';

export const PARTY_TYPES = ['user', 'organization', 'company'] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

export class PartyDto {
  @ApiProperty({ enum: PARTY_TYPES, description: 'Who this party is' })
  @IsIn(PARTY_TYPES)
  type!: PartyType;

  @ApiProperty({ description: "Opaque id in that party's own system; payment-service holds no foreign key to it", minLength: 1, maxLength: 128 })
  @IsString()
  @Length(1, 128)
  id!: string;
}
