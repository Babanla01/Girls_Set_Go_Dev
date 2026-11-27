/**
 * audience-preview.query.ts
 *   GET /api/v1/announcements/audience-preview?audienceType=COHORT&cohortId=<id>
 * "This will reach 24 learners" - shown in the compose form before publishing.
 */
import { AnnAudienceType } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

export class AudiencePreviewQuery {
  @IsEnum(AnnAudienceType)
  audienceType!: AnnAudienceType;

  @IsOptional()
  @IsUUID()
  trackId?: string;

  @IsOptional()
  @IsUUID()
  cohortId?: string;
}