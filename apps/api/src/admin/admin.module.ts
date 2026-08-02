import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { RolesGuard } from './roles.guard';
import { CronManagerService } from './cron-manager.service';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProviderAlertsModule } from '../provider-alerts/provider-alerts.module';
import { SocialModule } from '../social/social.module';
import { ContactModule } from '../contact/contact.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MediaMetadataModule,
    NotificationsModule,
    ProviderAlertsModule,
    ScheduleModule,
    SocialModule,
    ContactModule,
    UsersModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, RolesGuard, CronManagerService],
  exports: [RolesGuard],
})
export class AdminModule {}
