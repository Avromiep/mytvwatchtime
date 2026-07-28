import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, Min } from 'class-validator';
import { OnboardingStatus } from '@tvwatch/shared';

const TRANSITIONS: Array<Exclude<OnboardingStatus, 'NOT_STARTED'>> = [
  'IN_PROGRESS',
  'COMPLETED',
  'SKIPPED',
];

export class UpdateOnboardingStateDto {
  @ApiProperty({ enum: TRANSITIONS })
  @IsIn(TRANSITIONS)
  status!: Exclude<OnboardingStatus, 'NOT_STARTED'>;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  version!: number;
}
