import { Module } from '@nestjs/common';
import { SocialController } from './social.controller';
import { CommentsService } from './comments.service';
import { SocialService } from './social.service';
import { ModerationService } from './moderation.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { CommentImageModule } from '../comment-images/comment-image.module';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';
import { TranslationService } from './translation.service';

@Module({
  imports: [NotificationsModule, CommentImageModule, MediaMetadataModule],
  controllers: [SocialController],
  providers: [CommentsService, SocialService, ModerationService, TranslationService],
  exports: [ModerationService],
})
export class SocialModule {}
