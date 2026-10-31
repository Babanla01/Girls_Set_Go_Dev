/**
 * course-catalog.controller.ts
 * ---------------------------------------------------------------------------
 * Admin-only overview of every course, its master template and each cohort's copy.
 *
 *   GET /api/v1/admin/course-catalog?trackId=&status=&search=&page=&pageSize=
 */
import { Controller, Get, Query } from '@nestjs/common';
import { Role } from '@prisma/client';

import { Roles } from '../auth/decorators/roles.decorator';
import { CourseCatalogService } from './course-catalog.service';
import { CourseCatalogQuery } from './dto/course-catalog.query';

@Roles(Role.ADMIN)
@Controller('admin/course-catalog')
export class CourseCatalogController {
  constructor(private readonly catalog: CourseCatalogService) {}

  @Get()
  list(@Query() query: CourseCatalogQuery) {
    return this.catalog.list(query);
  }
}
