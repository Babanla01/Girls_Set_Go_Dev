/**
 * pages.controller.ts
 * ---------------------------------------------------------------------------
 * Admin-only page editor (class-level @Roles(ADMIN): students and instructors
 * get 403, signed-out visitors get 401).
 *
 *   GET    /api/v1/admin/pages/section-types          the catalog of section types (labels, defaults, fields)
 *   POST   /api/v1/admin/pages                        new page (empty draft)
 *   GET    /api/v1/admin/pages                        list (search, status, pages)
 *   GET    /api/v1/admin/pages/:id                    one page with its draft and what is missing to publish it
 *   PATCH  /api/v1/admin/pages/:id                    change the title, or the address (never-published pages only)
 *   PUT    /api/v1/admin/pages/:id/draft              autosave the draft (send the revision you last saw)
 *   POST   /api/v1/admin/pages/:id/publish            make the draft live as a new numbered version
 *   POST   /api/v1/admin/pages/:id/unpublish          take it offline
 *   GET    /api/v1/admin/pages/:id/versions           version history
 *   GET    /api/v1/admin/pages/:id/versions/:number   one version in full
 *   POST   /api/v1/admin/pages/:id/versions/:number/restore   copy that version into the draft
 *   POST   /api/v1/admin/pages/:id/preview-link       a 30-minute link to preview the draft on the website
 *   DELETE /api/v1/admin/pages/:id                    delete a page that was never published
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../../../auth/auth.types';
import { CurrentUser } from '../../../auth/decorators/current-user.decorator';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { CreatePageDto } from './dto/create-page.dto';
import { ListPagesQuery } from './dto/list-pages.query';
import { PublishPageDto } from './dto/publish-page.dto';
import { RestoreVersionDto } from './dto/restore-version.dto';
import { SaveDraftDto } from './dto/save-draft.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { PagesService } from './pages.service';

@Roles(Role.ADMIN)
@Controller('admin/pages')
export class PagesController {
  constructor(private readonly pages: PagesService) {}

  // "section-types" is a fixed word, declared before the ":id" routes so it is never mistaken for an id.
  @Get('section-types')
  sectionTypes() {
    return this.pages.sectionTypes();
  }

  @Post()
  create(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreatePageDto, @Req() req: Request) {
    return this.pages.create(admin, dto, getRequestContext(req));
  }

  @Get()
  list(@Query() query: ListPagesQuery) {
    return this.pages.list(query);
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.pages.getOne(id);
  }

  @Patch(':id')
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePageDto,
    @Req() req: Request,
  ) {
    return this.pages.updateDetails(admin, id, dto, getRequestContext(req));
  }

  @Put(':id/draft')
  saveDraft(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: SaveDraftDto) {
    return this.pages.saveDraft(admin, id, dto);
  }

  @Post(':id/publish')
  @HttpCode(200)
  publish(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: PublishPageDto,
    @Req() req: Request,
  ) {
    return this.pages.publish(admin, id, dto, getRequestContext(req));
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  unpublish(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.pages.unpublish(admin, id, getRequestContext(req));
  }

  @Get(':id/versions')
  versions(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.pages.listVersions(id);
  }

  @Get(':id/versions/:number')
  version(@Param('id', new ParseUUIDPipe()) id: string, @Param('number', ParseIntPipe) number: number) {
    return this.pages.getVersion(id, number);
  }

  @Post(':id/versions/:number/restore')
  @HttpCode(200)
  restore(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('number', ParseIntPipe) number: number,
    @Body() dto: RestoreVersionDto,
    @Req() req: Request,
  ) {
    return this.pages.restoreVersion(admin, id, number, dto, getRequestContext(req));
  }

  @Post(':id/preview-link')
  @HttpCode(200)
  previewLink(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.pages.createPreviewLink(id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request): Promise<void> {
    await this.pages.remove(admin, id, getRequestContext(req));
  }
}