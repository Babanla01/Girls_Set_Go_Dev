/**
 * revalidation.service.ts
 * ---------------------------------------------------------------------------
 * Tells the PUBLIC WEBSITE to refresh a page right after an admin publishes or
 * takes it offline, so visitors see the change within seconds instead of when a
 * cache happens to expire.
 *
 * It is optional: with FRONTEND_REVALIDATE_URL and FRONTEND_REVALIDATE_SECRET
 * empty, nothing is sent and the website simply refreshes on its own schedule.
 * A failure never breaks publishing - the page is already saved - it is only logged.
 *
 * What the website receives:
 *   POST <FRONTEND_REVALIDATE_URL>
 *   header  x-revalidate-secret: <FRONTEND_REVALIDATE_SECRET>
 *   body    { "paths": ["/about"] }
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../../config/env.validation';

@Injectable()
export class RevalidationService {
  private readonly logger = new Logger(RevalidationService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  async pagesChanged(paths: string[]): Promise<void> {
    const url = this.config.get('FRONTEND_REVALIDATE_URL', { infer: true });
    const secret = this.config.get('FRONTEND_REVALIDATE_SECRET', { infer: true });
    if (!url || !secret || paths.length === 0) return;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-revalidate-secret': secret },
        body: JSON.stringify({ paths }),
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) this.logger.warn(`The website answered ${response.status} when asked to refresh ${paths.join(', ')}.`);
    } catch (error) {
      this.logger.warn(`Could not ask the website to refresh ${paths.join(', ')}: ${(error as Error).message}`);
    }
  }
}