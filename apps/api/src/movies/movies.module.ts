import { Module } from '@nestjs/common';
import { MoviesController } from './movies.controller';
import { MoviesService } from './movies.service';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';
import { CollectionsModule } from '../collections/collections.module';
import { StatsModule } from '../stats/stats.module';

@Module({
  imports: [MediaMetadataModule, CollectionsModule, StatsModule],
  controllers: [MoviesController],
  providers: [MoviesService],
})
export class MoviesModule {}
