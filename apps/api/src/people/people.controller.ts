import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PersonCreditsQueryDto } from './dto/person-credits-query.dto';
import { PeopleService } from './people.service';

@ApiTags('people')
@Controller()
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  /** Person details + capped acting-credit rails (locale from Accept-Language). */
  @Get('people/:id')
  detail(@Param('id') id: string) {
    return this.people.getPerson(id);
  }

  /** Full paginated filmography for one type ("See all" grids). */
  @Get('people/:id/credits')
  credits(@Param('id') id: string, @Query() q: PersonCreditsQueryDto) {
    return this.people.getCredits(id, q.type, q.page ?? 1);
  }
}
