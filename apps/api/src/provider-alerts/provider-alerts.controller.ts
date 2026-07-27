import { Body, Controller, Delete, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProviderOfferType } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ProviderAlertsService } from './provider-alerts.service';

function parseOfferType(raw: string): ProviderOfferType {
  const v = raw?.toUpperCase();
  if (v === 'STREAM' || v === 'RENT' || v === 'BUY') return v;
  return 'STREAM';
}

@ApiTags('provider-alerts')
@Controller()
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ProviderAlertsController {
  constructor(private readonly alerts: ProviderAlertsService) {}

  /** Regional provider catalog for the alert picker (icons + names). */
  @Get('watch-providers/catalog')
  catalog(@Query('country') country?: string) {
    return this.alerts.catalog(country);
  }

  @Get('media/:id/provider-alerts')
  getAlerts(@Param('id') mediaId: string, @CurrentUser('id') userId: string) {
    return this.alerts.getAlerts(userId, mediaId);
  }

  /** Subscribe (or re-arm): empty providerIds = any provider. */
  @Put('media/:id/provider-alerts/:offerType')
  upsert(
    @Param('id') mediaId: string,
    @Param('offerType') offerType: string,
    @Body() body: { providerIds?: number[]; country?: string },
    @CurrentUser('id') userId: string,
  ) {
    const ids = Array.isArray(body?.providerIds)
      ? body.providerIds.filter((n) => Number.isInteger(n))
      : [];
    return this.alerts.upsertAlert(userId, mediaId, parseOfferType(offerType), ids, body?.country);
  }

  @Delete('media/:id/provider-alerts/:offerType')
  remove(
    @Param('id') mediaId: string,
    @Param('offerType') offerType: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.alerts.removeAlert(userId, mediaId, parseOfferType(offerType));
  }
}
