import { Module } from '@nestjs/common';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProviderAlertsController } from './provider-alerts.controller';
import { ProviderAlertsService } from './provider-alerts.service';

@Module({
  imports: [MediaMetadataModule, NotificationsModule],
  controllers: [ProviderAlertsController],
  providers: [ProviderAlertsService],
  exports: [ProviderAlertsService],
})
export class ProviderAlertsModule {}
