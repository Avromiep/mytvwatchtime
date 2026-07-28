import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { MediaType } from '@tvwatch/shared';
import { IsEnum, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { LibraryService } from './library.service';

class HistoryQueryDto {
  @IsOptional()
  @IsEnum(MediaType)
  mediaType?: MediaType;

  @IsOptional()
  from?: string;

  @IsOptional()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number = 20;
}

class PastCursorQueryDto {
  @IsString()
  @IsNotEmpty()
  before!: string;

  @IsString()
  @IsNotEmpty()
  beforeId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

class WatchNextBucketQueryDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(['START_WATCHING', 'NOT_RECENTLY'])
  bucket!: 'START_WATCHING' | 'NOT_RECENTLY';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 10;
}

@ApiTags('library')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me')
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  @Get('watch-next')
  watchNext(@CurrentUser('id') userId: string) {
    return this.library.watchNext(userId);
  }

  @Get('watch-next/bucket')
  watchNextBucket(@CurrentUser('id') userId: string, @Query() q: WatchNextBucketQueryDto) {
    return this.library.watchNextBucket(userId, q.bucket, q.offset ?? 0, q.limit ?? 10);
  }

  @Get('watch-next/paused')
  pausedWatchNext(@CurrentUser('id') userId: string) {
    return this.library.pausedWatchNext(userId);
  }

  // Burst-by-design (infinite scroll-up pagination) — double the global 60/min.
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('watch-next/history')
  watchNextHistory(@CurrentUser('id') userId: string, @Query() q: PastCursorQueryDto) {
    return this.library.watchNextHistory(userId, q);
  }

  @Get('upcoming')
  upcoming(@CurrentUser('id') userId: string) {
    return this.library.upcoming(userId);
  }

  // Burst-by-design (infinite scroll-up pagination) — double the global 60/min.
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('upcoming/past')
  upcomingPast(@CurrentUser('id') userId: string, @Query() q: PastCursorQueryDto) {
    return this.library.upcomingPast(userId, q);
  }

  @Get('history')
  history(@CurrentUser('id') userId: string, @Query() q: HistoryQueryDto) {
    return this.library.history(userId, q);
  }

  @Get('shows/progress')
  showsByStatus(@CurrentUser('id') userId: string) {
    return this.library.showsByStatus(userId);
  }
}
