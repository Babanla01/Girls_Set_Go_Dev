/**
 * course-content.controller.ts
 * ---------------------------------------------------------------------------
 * The web addresses for building a course. Admins and instructors use the SAME
 * addresses; WHICH course copies a person may open is decided on every request
 * (an instructor only gets the copy of a cohort assigned to her).
 *
 * Finding the editable copy:
 *   GET    /api/v1/course-content/course/:courseId/template   a course's master template (admins; created on first use)
 *   GET    /api/v1/course-content/cohort/:cohortId            a cohort's own copy (created from the template on first use)
 *
 * Reading:
 *   GET    /api/v1/course-content/:contentId                  outline: weeks and their lessons
 *   GET    /api/v1/course-content/:contentId/lessons/:lessonId  one lesson with its blocks
 *
 * Weeks:
 *   POST   /api/v1/course-content/:contentId/weeks            add a week
 *   PUT    /api/v1/course-content/:contentId/weeks/order      reorder the weeks
 *   PATCH  /api/v1/course-content/:contentId/weeks/:weekId    rename / change the summary
 *   DELETE /api/v1/course-content/:contentId/weeks/:weekId    remove a week (and what is inside it)
 *
 * Lessons:
 *   POST   /api/v1/course-content/:contentId/weeks/:weekId/lessons        add a lesson
 *   PUT    /api/v1/course-content/:contentId/weeks/:weekId/lessons/order  reorder a week's lessons
 *   PATCH  /api/v1/course-content/:contentId/lessons/:lessonId            edit a lesson
 *   POST   /api/v1/course-content/:contentId/lessons/:lessonId/move       move to another place or week
 *   DELETE /api/v1/course-content/:contentId/lessons/:lessonId            remove a lesson (and its blocks)
 *
 * Blocks:
 *   POST   /api/v1/course-content/:contentId/lessons/:lessonId/blocks        add a block
 *   PUT    /api/v1/course-content/:contentId/lessons/:lessonId/blocks/order  reorder a lesson's blocks
 *   PATCH  /api/v1/course-content/:contentId/blocks/:blockId                 edit a block (send expectedRevision)
 *   DELETE /api/v1/course-content/:contentId/blocks/:blockId                 remove a block
 *
 * Publishing and versions:
 *   GET    /api/v1/course-content/:contentId/draft-changes    what a publish would change, who edited it, who will see it
 *   POST   /api/v1/course-content/:contentId/publish          publish the draft as the next version
 *   GET    /api/v1/course-content/:contentId/versions         the version history
 *   GET    /api/v1/course-content/:contentId/versions/:number one saved version, with its contents
 *   GET    /api/v1/course-content/:contentId/compare?from=&to=  compare "live", "draft" or version numbers
 *
 * Every draft change answers with the new draftRevision, so the screen can show "Saved".
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

import { AuthenticatedUser, getRequestContext } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CourseContentService } from './course-content.service';
import { CourseStructureService } from './course-structure.service';
import { CourseVersionsService } from './course-versions.service';
import { CreateBlockDto, UpdateBlockDto } from './dto/block.dto';
import { CompareQuery } from './dto/compare.query';
import { CreateLessonDto, MoveLessonDto, UpdateLessonDto } from './dto/lesson.dto';
import { OrderDto } from './dto/order.dto';
import { PublishDto } from './dto/publish.dto';
import { CreateWeekDto, UpdateWeekDto } from './dto/week.dto';
import { LessonBlocksService } from './lesson-blocks.service';

const uuid = () => new ParseUUIDPipe();

@Roles(Role.ADMIN, Role.INSTRUCTOR)
@Controller('course-content')
export class CourseContentController {
  constructor(
    private readonly content: CourseContentService,
    private readonly structure: CourseStructureService,
    private readonly blocks: LessonBlocksService,
    private readonly versions: CourseVersionsService,
  ) {}

  // ------------------------------------------------ finding the editable copy

  @Roles(Role.ADMIN)
  @Get('course/:courseId/template')
  template(@CurrentUser() admin: AuthenticatedUser, @Param('courseId', uuid()) courseId: string, @Req() req: Request) {
    return this.content.getOrCreateTemplate(admin, courseId, getRequestContext(req));
  }

  @Get('cohort/:cohortId')
  cohortCopy(@CurrentUser() user: AuthenticatedUser, @Param('cohortId', uuid()) cohortId: string, @Req() req: Request) {
    return this.content.getOrCreateCohortCopy(user, cohortId, getRequestContext(req));
  }

  // ------------------------------------------------------------------ reading

  @Get(':contentId')
  outline(@CurrentUser() user: AuthenticatedUser, @Param('contentId', uuid()) contentId: string) {
    return this.content.getOutline(user, contentId);
  }

  @Get(':contentId/lessons/:lessonId')
  lesson(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('lessonId', uuid()) lessonId: string,
  ) {
    return this.content.getLesson(user, contentId, lessonId);
  }

  // -------------------------------------------------------------------- weeks

  @Post(':contentId/weeks')
  addWeek(@CurrentUser() user: AuthenticatedUser, @Param('contentId', uuid()) contentId: string, @Body() dto: CreateWeekDto) {
    return this.structure.addWeek(user, contentId, dto);
  }

  @Put(':contentId/weeks/order')
  reorderWeeks(@CurrentUser() user: AuthenticatedUser, @Param('contentId', uuid()) contentId: string, @Body() dto: OrderDto) {
    return this.structure.reorderWeeks(user, contentId, dto);
  }

  @Patch(':contentId/weeks/:weekId')
  updateWeek(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('weekId', uuid()) weekId: string,
    @Body() dto: UpdateWeekDto,
  ) {
    return this.structure.updateWeek(user, contentId, weekId, dto);
  }

  @Delete(':contentId/weeks/:weekId')
  @HttpCode(200)
  removeWeek(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('weekId', uuid()) weekId: string,
    @Req() req: Request,
  ) {
    return this.structure.removeWeek(user, contentId, weekId, getRequestContext(req));
  }

  // ------------------------------------------------------------------ lessons

  @Post(':contentId/weeks/:weekId/lessons')
  addLesson(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('weekId', uuid()) weekId: string,
    @Body() dto: CreateLessonDto,
  ) {
    return this.structure.addLesson(user, contentId, weekId, dto);
  }

  @Put(':contentId/weeks/:weekId/lessons/order')
  reorderLessons(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('weekId', uuid()) weekId: string,
    @Body() dto: OrderDto,
  ) {
    return this.structure.reorderLessons(user, contentId, weekId, dto);
  }

  @Patch(':contentId/lessons/:lessonId')
  updateLesson(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('lessonId', uuid()) lessonId: string,
    @Body() dto: UpdateLessonDto,
  ) {
    return this.structure.updateLesson(user, contentId, lessonId, dto);
  }

  @Post(':contentId/lessons/:lessonId/move')
  @HttpCode(200)
  moveLesson(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('lessonId', uuid()) lessonId: string,
    @Body() dto: MoveLessonDto,
  ) {
    return this.structure.moveLesson(user, contentId, lessonId, dto);
  }

  @Delete(':contentId/lessons/:lessonId')
  @HttpCode(200)
  removeLesson(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('lessonId', uuid()) lessonId: string,
    @Req() req: Request,
  ) {
    return this.structure.removeLesson(user, contentId, lessonId, getRequestContext(req));
  }

  // ------------------------------------------------------------------- blocks

  @Post(':contentId/lessons/:lessonId/blocks')
  addBlock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('lessonId', uuid()) lessonId: string,
    @Body() dto: CreateBlockDto,
  ) {
    return this.blocks.addBlock(user, contentId, lessonId, dto);
  }

  @Put(':contentId/lessons/:lessonId/blocks/order')
  reorderBlocks(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('lessonId', uuid()) lessonId: string,
    @Body() dto: OrderDto,
  ) {
    return this.blocks.reorderBlocks(user, contentId, lessonId, dto);
  }

  @Patch(':contentId/blocks/:blockId')
  updateBlock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('blockId', uuid()) blockId: string,
    @Body() dto: UpdateBlockDto,
  ) {
    return this.blocks.updateBlock(user, contentId, blockId, dto);
  }

  @Delete(':contentId/blocks/:blockId')
  @HttpCode(200)
  removeBlock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('blockId', uuid()) blockId: string,
  ) {
    return this.blocks.removeBlock(user, contentId, blockId);
  }

  // ------------------------------------------------- publishing and versions

  @Get(':contentId/draft-changes')
  draftChanges(@CurrentUser() user: AuthenticatedUser, @Param('contentId', uuid()) contentId: string) {
    return this.versions.getDraftChanges(user, contentId);
  }

  @Post(':contentId/publish')
  publish(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Body() dto: PublishDto,
    @Req() req: Request,
  ) {
    return this.versions.publish(user, contentId, dto, getRequestContext(req));
  }

  @Get(':contentId/versions')
  listVersions(@CurrentUser() user: AuthenticatedUser, @Param('contentId', uuid()) contentId: string) {
    return this.versions.listVersions(user, contentId);
  }

  @Get(':contentId/versions/:number')
  version(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('number', new ParseIntPipe()) number: number,
  ) {
    return this.versions.getVersion(user, contentId, number);
  }

  @Get(':contentId/compare')
  compare(@CurrentUser() user: AuthenticatedUser, @Param('contentId', uuid()) contentId: string, @Query() query: CompareQuery) {
    return this.versions.compare(user, contentId, query.from, query.to);
  }
}
