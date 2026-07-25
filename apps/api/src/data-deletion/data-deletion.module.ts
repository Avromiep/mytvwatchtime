import { Module } from '@nestjs/common';
import { DataDeletionController } from './data-deletion.controller';
import { DataDeletionService } from './data-deletion.service';
import { AppleAuthService } from '../auth/apple-auth.service';

@Module({
  controllers: [DataDeletionController],
  providers: [DataDeletionService, AppleAuthService],
})
export class DataDeletionModule {}
