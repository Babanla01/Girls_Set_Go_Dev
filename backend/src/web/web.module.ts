/**
 * web.module.ts
 * ---------------------------------------------------------------------------
 * Everything on the WEBSITE side of the product, in one place:
 *   cms        the website editor (site settings, pictures, people, pages ...)
 * Later batches add: announcements, forms and the shop here.
 *
 * app.module.ts imports THIS module once, so adding a new website feature never
 * means editing the app's main module again.
 */
import { Module } from '@nestjs/common';

import { CmsModule } from './cms/cms.module';

@Module({
  imports: [CmsModule],
})
export class WebModule {}