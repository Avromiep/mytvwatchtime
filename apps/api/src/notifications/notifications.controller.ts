import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { NotificationService } from './notification.service';
import { UpdatePreferencesDto } from './dto/notification.dto';

class ListQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  unreadOnly?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number = 30;

  @IsOptional()
  @IsString()
  sort?: string;
}

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me')
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  @Get('notifications')
  list(@CurrentUser('id') userId: string, @Query() q: ListQueryDto) {
    const unreadOnly =
      q.unreadOnly === true || (q.unreadOnly as any) === 'true' || (q.unreadOnly as any) === '1';
    return this.notifications.list(userId, {
      unreadOnly,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Patch('notifications/:id/read')
  markRead(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.notifications.markRead(userId, id);
  }

  @Post('notifications/mark-all-read')
  markAllRead(@CurrentUser('id') userId: string) {
    return this.notifications.markAllRead(userId);
  }

  @Delete('notifications')
  clearAll(@CurrentUser('id') userId: string) {
    return this.notifications.clearAll(userId);
  }

  @Delete('notifications/:id')
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.notifications.remove(userId, id);
  }

  @Get('notification-preferences')
  getPreferences(@CurrentUser('id') userId: string) {
    return this.notifications.getPreferences(userId);
  }

  @Patch('notification-preferences')
  updatePreferences(@CurrentUser('id') userId: string, @Body() dto: UpdatePreferencesDto) {
    return this.notifications.updatePreferences(userId, dto);
  }
}
