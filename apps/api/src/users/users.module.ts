import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UserImageService } from './user-image.service';
import { ExportService } from './export.service';
import { UsersController } from './users.controller';
import { AppleAuthService } from '../auth/apple-auth.service';
import { StatsModule } from '../stats/stats.module';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';
import { ProfileTasteService } from './profile-taste.service';

@Module({
  imports: [StatsModule, MediaMetadataModule],
  providers: [UsersService, UserImageService, ExportService, AppleAuthService, ProfileTasteService],
  controllers: [UsersController],
  exports: [UsersService, ProfileTasteService],
})
export class UsersModule {}
