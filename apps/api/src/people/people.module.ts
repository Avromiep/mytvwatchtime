import { Module } from '@nestjs/common';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';
import { PeopleController } from './people.controller';
import { PeopleService } from './people.service';

@Module({
  imports: [MediaMetadataModule],
  controllers: [PeopleController],
  providers: [PeopleService],
})
export class PeopleModule {}
