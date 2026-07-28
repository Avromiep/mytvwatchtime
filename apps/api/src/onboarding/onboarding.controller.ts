import { BadRequestException, Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { FeatureFlagService } from '../common/feature-flag.service';
import { OnboardingService } from './onboarding.service';
import { ApplyOnboardingDto } from './dto/apply-onboarding.dto';
import { UpdateOnboardingStateDto } from './dto/update-onboarding-state.dto';

@ApiTags('onboarding')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me/onboarding')
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly flags: FeatureFlagService,
  ) {}

  @Get()
  getState(@CurrentUser('id') userId: string) {
    return this.onboarding.getState(userId);
  }

  @Patch()
  updateState(@CurrentUser('id') userId: string, @Body() dto: UpdateOnboardingStateDto) {
    return this.onboarding.updateState(userId, dto);
  }

  @Post('apply')
  async apply(@CurrentUser('id') userId: string, @Body() dto: ApplyOnboardingDto) {
    if (!(await this.flags.isEnabled('onboarding_enabled'))) {
      throw new BadRequestException('Onboarding is temporarily disabled');
    }
    return this.onboarding.apply(userId, dto);
  }
}
