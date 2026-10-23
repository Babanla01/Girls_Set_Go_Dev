/**
 * students.controller.ts  (admin side)
 * ---------------------------------------------------------------------------
 * Admin-only, READ-ONLY web addresses for students (class-level @Roles(ADMIN)).
 *
 *   GET /api/v1/admin/students        list (search, status, track, cohort, pages)
 *   GET /api/v1/admin/students/:id    one student: profile, application, enrollment history
 */
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Role } from '@prisma/client';

import { Roles } from '../../auth/decorators/roles.decorator';
import { ListStudentsQuery } from './dto/list-students.query';
import { AdminStudentsService } from './students.service';

@Roles(Role.ADMIN)
@Controller('admin/students')
export class AdminStudentsController {
  constructor(private readonly students: AdminStudentsService) {}

  @Get()
  list(@Query() query: ListStudentsQuery) {
    return this.students.list(query);
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.students.getOne(id);
  }
}