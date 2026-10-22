/**
 * pagination.ts
 * ---------------------------------------------------------------------------
 * ONE reusable way to return long lists a page at a time. Every list in the
 * app (instructors, students, courses, ...) uses this, so it is built, tested
 * and secured once.
 *
 * Why pages: returning every row would get slower and heavier as the data
 * grows. Callers ask for ?page=2&pageSize=20 and get exactly that slice plus
 * the total, so the frontend can draw "page 2 of 7".
 *
 * Safety: the page size is capped (100) and the page number is bounded, so
 * nobody can ask for a million rows or push the database into an overflow.
 */
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const MAX_PAGE_NUMBER = 100_000;

/** The `?page=` and `?pageSize=` parts of a list request. Extend it to add filters. */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number) // query strings arrive as text; turn "2" into 2
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_NUMBER)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize: number = DEFAULT_PAGE_SIZE;
}

/** What every list endpoint returns. */
export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Converts page numbers into the `skip`/`take` the database understands. */
export function toSkipTake(query: { page: number; pageSize: number }): { skip: number; take: number } {
  return { skip: (query.page - 1) * query.pageSize, take: query.pageSize };
}

/** Wraps one page of rows plus the overall total into the standard response shape. */
export function buildPage<T>(
  items: T[],
  total: number,
  query: { page: number; pageSize: number },
): Paginated<T> {
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}