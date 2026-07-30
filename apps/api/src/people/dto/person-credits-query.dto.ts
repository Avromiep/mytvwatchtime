import { ApiPropertyOptional } from '@nestjs/swagger';
import { MediaType } from '@tvwatch/shared';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';

export class PersonCreditsQueryDto {
  @ApiPropertyOptional({ enum: MediaType })
  @IsEnum(MediaType)
  type!: MediaType;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
