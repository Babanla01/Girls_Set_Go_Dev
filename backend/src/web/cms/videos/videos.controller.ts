/**
 * videos.controller.ts
 * ---------------------------------------------------------------------------
 * Admin-only video library (class-level @Roles(ADMIN): students and instructors
 * get 403, signed-out visitors get 401).
 *
 *   POST   /api/v1/admin/videos                    new video (draft). Embedded: send the link. Uploaded: then send the file
 *   GET    /api/v1/admin/videos                    list (category, status, search, captions=missing, pages) + counts
 *   POST   /api/v1/admin/videos/reorder            order the videos of one category
 *   GET    /api/v1/admin/videos/:id                one video, with what is missing to publish it
 *   PATCH  /api/v1/admin/videos/:id                change details, thumbnail, consent, where it appears
 *   PUT    /api/v1/admin/videos/:id/file           the video file as the request body (Content-Type: video/mp4 or video/quicktime)
 *   GET    /api/v1/admin/videos/:id/file           play the stored file (admin preview; works for drafts, supports seeking)
 *   PUT    /api/v1/admin/videos/:id/captions       the .vtt text as the request body (Content-Type: text/vtt)
 *   DELETE /api/v1/admin/videos/:id/captions       remove the captions (drafts only)
 *   PUT    /api/v1/admin/videos/:id/transcript     the transcript text as the request body (Content-Type: text/plain)
 *   DELETE /api/v1/admin/videos/:id/transcript     remove the transcript
 *   POST   /api/v1/admin/videos/:id/publish        put it on the website (only when complete)
 *   POST   /api/v1/admin/videos/:id/unpublish      take it off the website
 *   DELETE /api/v1/admin/videos/:id                delete a draft that no banner slide uses
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request, Response } from 'express';

import { AuthenticatedUser, getRequestContext } from '../../../auth/auth.types';
import { CurrentUser } from '../../../auth/decorators/current-user.decorator';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { StorageService } from '../../../platform/storage/storage.service';
import { sendStoredFile } from './byte-range';
import { CreateVideoDto } from './dto/create-video.dto';
import { ListVideosQuery } from './dto/list-videos.query';
import { ReorderVideosDto } from './dto/reorder-videos.dto';
import { UpdateVideoDto } from './dto/update-video.dto';
import { VideosService } from './videos.service';

@Roles(Role.ADMIN)
@Controller('admin/videos')
export class VideosController {
  constructor(
    private readonly videos: VideosService,
    private readonly storage: StorageService,
  ) {}

  @Post()
  create(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateVideoDto, @Req() req: Request) {
    return this.videos.create(admin, dto, getRequestContext(req));
  }

  @Get()
  list(@Query() query: ListVideosQuery) {
    return this.videos.list(query);
  }

  // "reorder" is a fixed word, declared before the ":id" routes so it is never mistaken for an id.
  @Post('reorder')
  @HttpCode(200)
  reorder(@CurrentUser() admin: AuthenticatedUser, @Body() dto: ReorderVideosDto, @Req() req: Request) {
    return this.videos.reorder(admin, dto, getRequestContext(req));
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.videos.getOne(id);
  }

  @Patch(':id')
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateVideoDto,
    @Req() req: Request,
  ) {
    return this.videos.update(admin, id, dto, getRequestContext(req));
  }

  @Put(':id/file')
  @HttpCode(200)
  uploadFile(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.videos.uploadFile(admin, id, req, getRequestContext(req));
  }

  @Get(':id/file')
  async file(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | undefined> {
    const stored = await this.videos.adminFile(id);
    return sendStoredFile(this.storage, req, res, { key: stored.key, contentType: stored.contentType, cacheControl: 'private, no-store' });
  }

  @Put(':id/captions')
  @HttpCode(200)
  setCaptions(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.videos.setCaptions(admin, id, req, getRequestContext(req));
  }

  @Delete(':id/captions')
  clearCaptions(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.videos.clearCaptions(admin, id, getRequestContext(req));
  }

  @Put(':id/transcript')
  @HttpCode(200)
  setTranscript(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.videos.setTranscript(admin, id, req, getRequestContext(req));
  }

  @Delete(':id/transcript')
  clearTranscript(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.videos.clearTranscript(admin, id, getRequestContext(req));
  }

  @Post(':id/publish')
  @HttpCode(200)
  publish(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.videos.publish(admin, id, getRequestContext(req));
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  unpublish(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.videos.unpublish(admin, id, getRequestContext(req));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request): Promise<void> {
    await this.videos.remove(admin, id, getRequestContext(req));
  }
}