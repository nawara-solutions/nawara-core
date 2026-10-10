import { ApiProperty } from '@nestjs/swagger';

/** The answer of a hierarchy reference repair (ADR-0061 §4 step 8): the kind, the id, and whether a row was placed. Nothing else. */
export class ReferenceRepairResponseDto {
  @ApiProperty({ enum: ['platform', 'organization'], description: 'The kind of the repaired reference.' })
  kind!: 'platform' | 'organization';

  @ApiProperty({ format: 'uuid', description: 'The id of the repaired reference, as requested.' })
  id!: string;

  @ApiProperty({ description: "true when this request inserted the target's reference row; false when it was already present." })
  placed!: boolean;
}
