/**
 * media.controller.ts
 * ---------------------------------------------------------------------------
 * Admin-only media library (class-level @Roles(ADMIN): students and instructors
 * get 403, signed-out visitors get 401).
 *
 *   POST   /api/v1/admin/media                upload a picture (multipart form: file + folder, title, altText, consent)
 *   GET    /api/v1/admin/media                list pictures (folder, search, pages)
 *   GET    /api/v1/admin/media/:id            one picture with its "used on" list
 *   PATCH  /api/v1/admin/media/:id            change title, alt text or consent
 *   POST   /api/v1/admin/media/:id/replace    put a new picture under the same key (multipart: file)
 *   GET    /api/v1/admin/media/:id/download   download the stored picture
 *   DELETE /api/v1/admin/media/:id            delete it (refused while it is in use)
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
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../../../auth/auth.types';
import { CurrentUser } from '../../../auth/decorators/current-user.decorator';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { ListMediaQuery } from './dto/list-media.query';
import { ReplaceMediaDto } from './dto/replace-media.dto';
import { UpdateMediaDto } from './dto/update-media.dto';
import { UploadMediaDto } from './dto/upload-media.dto';
import { MEDIA_MAX_BYTES } from './media.constants';
import { MediaService } from './media.service';
import type { UploadedPicture } from './uploaded-picture';

/** One picture per request, at most 10 MB (larger files are refused before they are read). */
const pictureUpload = () => FileInterceptor('file', { limits: { fileSize: MEDIA_MAX_BYTES, files: 1 } });

@Roles(Role.ADMIN)
@Controller('admin/media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post()
  @UseInterceptors(pictureUpload())
  upload(
    @CurrentUser() admin: AuthenticatedUser,
    @UploadedFile() file: UploadedPicture | undefined,
    @Body() dto: UploadMediaDto,
    @Req() req: Request,
  ) {
    return this.media.upload(admin, file, dto, getRequestContext(req));
  }

  @Get()
  list(@Query() query: ListMediaQuery) {
    return this.media.list(query);
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.media.getOne(id);
  }

  @Patch(':id')
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateMediaDto,
    @Req() req: Request,
  ) {
    return this.media.update(admin, id, dto, getRequestContext(req));
  }

  @Post(':id/replace')
  @HttpCode(200)
  @UseInterceptors(pictureUpload())
  replace(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @UploadedFile() file: UploadedPicture | undefined,
    @Body() dto: ReplaceMediaDto,
    @Req() req: Request,
  ) {
    return this.media.replace(admin, id, file, dto, getRequestContext(req));
  }

  @Get(':id/download')
  async download(@Param('id', new ParseUUIDPipe()) id: string): Promise<StreamableFile> {
    const file = await this.media.openForDownload(id);
    return new StreamableFile(file.stream, {
      type: file.contentType,
      length: file.size,
      disposition: `attachment; filename="${file.filename}"`,
    });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request): Promise<void> {
    await this.media.remove(admin, id, getRequestContext(req));
  }
}