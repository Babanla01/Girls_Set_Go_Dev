/**
 * compare.query.ts
 * ---------------------------------------------------------------------------
 *   ?from=live&to=draft          (the default)  what is waiting to be published
 *   ?from=6&to=7                 version 6 against version 7
 *   ?from=6&to=draft             version 6 against the current draft
 * Each side is "live", "draft" or a version number.
 */
import { IsOptional, Matches } from 'class-validator';

const REFERENCE = /^(live|draft|[1-9][0-9]{0,8})$/;
const MESSAGE = 'Use "live", "draft" or a version number.';

export class CompareQuery {
  @IsOptional()
  @Matches(REFERENCE, { message: MESSAGE })
  from: string = 'live';

  @IsOptional()
  @Matches(REFERENCE, { message: MESSAGE })
  to: string = 'draft';
}
