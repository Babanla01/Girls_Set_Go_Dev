/**
 * public-people.query.ts
 *   GET /api/v1/public/people?kind=TEAM|INSTRUCTOR&placement=about|cohort
 * A profile marked BOTH appears under either kind.
 */
import { IsIn, IsOptional } from 'class-validator';

export class PublicPeopleQuery {
  @IsOptional()
  @IsIn(['TEAM', 'INSTRUCTOR'])
  kind?: 'TEAM' | 'INSTRUCTOR';

  /** about = the About page (team); cohort = the cohort page (instructors). */
  @IsOptional()
  @IsIn(['about', 'cohort'])
  placement?: 'about' | 'cohort';
}