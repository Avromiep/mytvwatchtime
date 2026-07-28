import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { OnboardingMovieAction, OnboardingShowAction } from '@tvwatch/shared';

const SHOW_ACTIONS: OnboardingShowAction[] = ['WATCHLIST', 'CAUGHT_UP', 'WATCHED_THROUGH'];
const MOVIE_ACTIONS: OnboardingMovieAction[] = ['WATCHLIST', 'WATCHED'];

export class OnboardingShowItem {
  @ApiProperty()
  @IsString()
  mediaId!: string;

  @ApiProperty({ enum: SHOW_ACTIONS })
  @IsIn(SHOW_ACTIONS)
  action!: OnboardingShowAction;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  throughSeasonNumber?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  throughEpisodeNumber?: number;
}

export class OnboardingMovieItem {
  @ApiProperty()
  @IsString()
  mediaId!: string;

  @ApiProperty({ enum: MOVIE_ACTIONS })
  @IsIn(MOVIE_ACTIONS)
  action!: OnboardingMovieAction;
}

export class ApplyOnboardingDto {
  @ApiProperty({ type: [OnboardingShowItem] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OnboardingShowItem)
  shows!: OnboardingShowItem[];

  @ApiProperty({ type: [OnboardingMovieItem] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OnboardingMovieItem)
  movies!: OnboardingMovieItem[];
}
