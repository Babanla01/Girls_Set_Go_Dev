/**
 * public-file.query.ts
 *   GET /api/v1/files/public/people/queen-tane.jpg?v=3&w=480
 *   v  the picture's version (makes the address change when the picture is replaced)
 *   w  the width wanted, in pixels (a smaller copy is made and remembered)
 */
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

export class PublicFileQuery {
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,6}$/)
  v?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(16)
  @Max(4000)
  w?: number;
}