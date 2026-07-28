import { Module } from '@nestjs/common';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({
  imports: [MediaMetadataModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
