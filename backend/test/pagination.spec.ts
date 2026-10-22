/**
 * pagination.spec.ts
 * ---------------------------------------------------------------------------
 * The shared paging helper: correct slices, correct totals, and safe limits.
 */
import 'reflect-metadata'; // the decorators need this; the real app loads it at start-up
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  buildPage,
  MAX_PAGE_SIZE,
  PaginationQueryDto,
  toSkipTake,
} from '../src/common/pagination/pagination';

const check = async (query: Record<string, string>) =>
  validate(plainToInstance(PaginationQueryDto, query), { whitelist: true, forbidNonWhitelisted: true });

describe('pagination', () => {
  it('turns a page number into the right database slice', () => {
    expect(toSkipTake({ page: 1, pageSize: 20 })).toEqual({ skip: 0, take: 20 });
    expect(toSkipTake({ page: 3, pageSize: 10 })).toEqual({ skip: 20, take: 10 });
  });

  it('builds the standard response, including the page count', () => {
    expect(buildPage(['a', 'b'], 25, { page: 2, pageSize: 10 })).toEqual({
      items: ['a', 'b'],
      page: 2,
      pageSize: 10,
      total: 25,
      totalPages: 3,
    });
  });

  it('always reports at least one page, even for an empty list', () => {
    expect(buildPage([], 0, { page: 1, pageSize: 20 }).totalPages).toBe(1);
  });

  it('applies sensible defaults when nothing is asked for', () => {
    const query = plainToInstance(PaginationQueryDto, {});
    expect(query.page).toBe(1);
    expect(query.pageSize).toBe(20);
  });

  it('converts text from the web address into numbers', () => {
    const query = plainToInstance(PaginationQueryDto, { page: '3', pageSize: '50' });
    expect(query.page).toBe(3);
    expect(query.pageSize).toBe(50);
  });

  it('accepts reasonable requests', async () => {
    expect(await check({ page: '2', pageSize: '25' })).toHaveLength(0);
    expect(await check({ pageSize: String(MAX_PAGE_SIZE) })).toHaveLength(0);
  });

  it('rejects limits that are too big, too small, or not whole numbers', async () => {
    const badQueries: Array<Record<string, string>> = [
      { pageSize: String(MAX_PAGE_SIZE + 1) },
      { pageSize: '0' },
      { page: '0' },
      { page: '-1' },
      { page: '1.5' },
      { page: 'abc' },
      { page: '99999999999' },
    ];
    for (const bad of badQueries) {
      expect((await check(bad)).length).toBeGreaterThan(0);
    }
  });
});