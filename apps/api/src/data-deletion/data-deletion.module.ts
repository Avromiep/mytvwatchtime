import { Module } from '@nestjs/common';
import { DataDeletionController } from './data-deletion.controller';
import { DataDeletionService } from './data-deletion.service';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  controllers: [DataDeletionController],
  providers: [DataDeletionService],
})
export class DataDeletionModule {}
