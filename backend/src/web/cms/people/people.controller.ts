/**
 * people.controller.ts
 * ---------------------------------------------------------------------------
 * Admin-only management of public profiles (class-level @Roles(ADMIN)).
 *
 *   POST   /api/v1/admin/people              new profile (starts as a draft)
 *   GET    /api/v1/admin/people              list (kind, status, search, pages) in display order
 *   GET    /api/v1/admin/people/:id          one profile, with what is still missing to publish it
 *   PATCH  /api/v1/admin/people/:id          change it
 *   POST   /api/v1/admin/people/:id/publish      put it on the website (only when complete)
 *   POST   /api/v1/admin/people/:id/unpublish    take it off the website
 *   POST   /api/v1/admin/people/reorder      set the display order
 *   DELETE /api/v1/admin/people/:id          delete a DRAFT profile
 */
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../../../auth/auth.types';
import { CurrentUser } from '../../../auth/decorators/current-user.decorator';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { CreatePersonDto } from './dto/create-person.dto';
import { ListPeopleQuery } from './dto/list-people.query';
import { ReorderPeopleDto } from './dto/reorder-people.dto';
import { UpdatePersonDto } from './dto/update-person.dto';
import { PeopleService } from './people.service';

@Roles(Role.ADMIN)
@Controller('admin/people')
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  @Post()
  create(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreatePersonDto, @Req() req: Request) {
    return this.people.create(admin, dto, getRequestContext(req));
  }

  @Get()
  list(@Query() query: ListPeopleQuery) {
    return this.people.list(query);
  }

  // "reorder" is a fixed word, declared before the ":id" routes so it is never mistaken for an id.
  @Post('reorder')
  @HttpCode(200)
  reorder(@CurrentUser() admin: AuthenticatedUser, @Body() dto: ReorderPeopleDto, @Req() req: Request) {
    return this.people.reorder(admin, dto, getRequestContext(req));
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.people.getOne(id);
  }

  @Patch(':id')
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePersonDto,
    @Req() req: Request,
  ) {
    return this.people.update(admin, id, dto, getRequestContext(req));
  }

  @Post(':id/publish')
  @HttpCode(200)
  publish(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.people.publish(admin, id, getRequestContext(req));
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  unpublish(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.people.unpublish(admin, id, getRequestContext(req));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request): Promise<void> {
    await this.people.remove(admin, id, getRequestContext(req));
  }
}