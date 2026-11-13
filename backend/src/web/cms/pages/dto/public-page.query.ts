/**
 * public-page.query.ts - GET /api/v1/public/page?path=/about
 */
import { IsString, Length } from 'class-validator';

export class PublicPageQuery {
  @IsString()
  @Length(1, 120)
  path!: string;
}