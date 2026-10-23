/**
 * instructor-cohorts.controller.ts
 * ---------------------------------------------------------------------------
 * What an instructor sees of the learning structure (class-level
 * @Roles(INSTRUCTOR): students get 403, signed-out visitors get 401).
 *
 *   GET /api/v1/instructor/cohorts        my cohorts (active by default)
 *   GET /api/v1/instructor/cohorts/:id    one of my cohorts (404 if it is not mine)
 *   GET /api/v1/instructor/cohorts/:id/students   who is enrolled in it (names only)
 */
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Role } from '@prisma/client';

import { AuthenticatedUser } from '../auth/auth.types';
import { PaginationQueryDto } from '../common/pagination/pagination';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ListMyCohortsQuery } from './dto/list-my-cohorts.query';
import { InstructorCohortsService } from './instructor-cohorts.service';

@Roles(Role.INSTRUCTOR)
@Controller('instructor/cohorts')
export class InstructorCohortsController {
  constructor(private readonly cohorts: InstructorCohortsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListMyCohortsQuery) {
    return this.cohorts.listMine(user, query);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.cohorts.getMine(user, id);
  }

  @Get(':id/students')
  students(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.cohorts.listStudents(user, id, query);
  }
}