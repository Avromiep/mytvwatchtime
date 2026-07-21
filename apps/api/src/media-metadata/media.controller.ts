import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt.guard';
import { DiscoveryService } from './discovery.service';
import { DiscoverQueryDto, SearchQueryDto } from './dto/discover.dto';

@ApiTags('discovery')
@Controller()
export class MediaController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Get('search')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  search(@Query() q: SearchQueryDto, @CurrentUser('id') userId?: string) {
    return this.discovery.search(q, userId);
  }

  @Get('discover/shows')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  discoverShows(@Query() q: DiscoverQueryDto, @CurrentUser('id') userId?: string) {
    return this.discovery.discoverShows(q, userId);
  }

  @Get('discover/movies')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  discoverMovies(@Query() q: DiscoverQueryDto, @CurrentUser('id') userId?: string) {
    return this.discovery.discoverMovies(q, userId);
  }

  @Get('trending/shows')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  trendingShows(
    @Query('page') page = '1',
    @Query('genre') genre: string | undefined,
    @CurrentUser('id') userId?: string,
  ) {
    return this.discovery.trendingShows(userId, parseInt(page), 20, genre);
  }

  @Get('trending/movies')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  trendingMovies(
    @Query('page') page = '1',
    @Query('genre') genre: string | undefined,
    @CurrentUser('id') userId?: string,
  ) {
    return this.discovery.trendingMovies(userId, parseInt(page), 20, genre);
  }

  @Get('discover/sections')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  sections(@Query('genre') genre: string | undefined, @CurrentUser('id') userId?: string) {
    return this.discovery.discoverSections(userId, genre);
  }

  /** Paginated personalized suggestions (see-all for "Top shows for you"). */
  @Get('discover/for-you')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  forYou(
    @Query('page') page = '1',
    @Query('genre') genre: string | undefined,
    @CurrentUser('id') userId?: string,
  ) {
    return this.discovery.forYou(userId, parseInt(page), 20, genre);
  }

  /** Catalog genres (most-used first) — filter chip lists in explore/search/see-all. */
  @Get('genres')
  genres() {
    return this.discovery.listGenres();
  }
}
