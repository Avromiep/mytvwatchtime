import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { FeatureFlagService } from '../feature-flag.service';
import { SettingService } from '../setting.service';
import { CapabilityService } from '../capability.service';
import { EmailService } from '../email.service';
import { MediaVotesService } from '../media-votes.service';

@Global()
@Module({
  providers: [
    PrismaService,
    FeatureFlagService,
    SettingService,
    CapabilityService,
    EmailService,
    MediaVotesService,
  ],
  exports: [
    PrismaService,
    FeatureFlagService,
    SettingService,
    CapabilityService,
    EmailService,
    MediaVotesService,
  ],
})
export class PrismaModule {}
