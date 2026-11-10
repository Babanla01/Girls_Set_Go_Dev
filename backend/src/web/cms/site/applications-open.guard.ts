/**
 * applications-open.guard.ts
 * ---------------------------------------------------------------------------
 * Refuses a request while applications are CLOSED (the "Applications are open"
 * website setting). Put it on the student signup route so that closing
 * applications in the website editor really stops new applications, not only
 * hides the button:
 *
 *     @UseGuards(ApplicationsOpenGuard)
 *     @Post('register')
 *
 * The answer is a plain 403 with a friendly message the signup form can show.
 */
import { CanActivate, ForbiddenException, Injectable } from '@nestjs/common';

import { SettingsService } from '../../../platform/settings/settings.service';

export const APPLICATIONS_CLOSED_MESSAGE =
  'Applications are closed right now. Please leave your email to be told when they open.';

@Injectable()
export class ApplicationsOpenGuard implements CanActivate {
  constructor(private readonly settings: SettingsService) {}

  async canActivate(): Promise<boolean> {
    if (!(await this.settings.getValue<boolean>('site.applications_open'))) {
      throw new ForbiddenException(APPLICATIONS_CLOSED_MESSAGE);
    }
    return true;
  }
}