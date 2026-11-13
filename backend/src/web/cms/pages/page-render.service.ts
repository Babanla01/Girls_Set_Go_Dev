/**
 * page-render.service.ts
 * ---------------------------------------------------------------------------
 * Turns a page's stored content into exactly what the PUBLIC website receives:
 *
 *   - hidden sections are left out
 *   - light-formatting text becomes a safe structure (paragraphs, lists, bold,
 *     italic, links) - the website never inserts HTML
 *   - a picture id becomes the picture: its address (with version), alt text,
 *     size and ready-made smaller sizes
 *   - facts that live elsewhere are filled in at this moment:
 *       "people"              the published People profiles
 *       "applications_panel"  open or closed, from the website settings
 *       "contact_info"        contact details from the website settings
 *       "video_row", "showcase_grid"  empty lists until their libraries exist
 *
 * The same renderer serves the published page and the admin preview, so a
 * preview is exactly what publishing would produce.
 */
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';
import { publicImageSelect, toPublicImage } from '../media/media.view';
import { PeopleService } from '../people/people.service';
import { SiteService } from '../site/site.service';
import { PageContent, pageAssetIds, StoredSection } from './page-content';
import { parseRichText } from './rich-text';
import { mapPaths } from './section-paths';
import { SECTION_TYPES } from './section-types';

type SitePublicView = Awaited<ReturnType<SiteService['publicView']>>;

export interface RenderMeta {
  /** The live version number; null for a preview. */
  version: number | null;
  publishedAt: Date | null;
  preview: boolean;
}

@Injectable()
export class PageRenderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly people: PeopleService,
    private readonly site: SiteService,
  ) {}

  async render(page: { path: string; title: string }, content: PageContent, meta: RenderMeta) {
    const visible = content.sections.filter((section) => !section.hidden);

    // Load every picture the page shows in ONE query.
    const assetIds = pageAssetIds({ seo: content.seo, sections: visible });
    const assets =
      assetIds.length === 0
        ? []
        : await this.prisma.cmsMediaAsset.findMany({ where: { id: { in: assetIds } }, select: { id: true, ...publicImageSelect } });
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const image = (id: unknown) => {
      const asset = typeof id === 'string' ? byId.get(id) : undefined;
      return asset ? toPublicImage(asset) : null; // a picture that no longer exists is simply left out
    };

    const needsSite = visible.some((section) => section.type === 'applications_panel' || section.type === 'contact_info');
    const siteView = needsSite ? await this.site.publicView() : null;

    const sections = await Promise.all(
      visible.map(async (section) => {
        const definition = SECTION_TYPES[section.type];
        const withText = mapPaths(section.fields, definition.rich, (value) => (typeof value === 'string' ? parseRichText(value) : value));
        const fields = mapPaths(withText, definition.images, image);
        return { id: section.id, type: section.type, fields, resolved: await this.resolve(section, siteView) };
      }),
    );

    return {
      path: page.path,
      title: page.title,
      seo: {
        title: content.seo.title || page.title,
        description: content.seo.description || null,
        image: content.seo.imageAssetId ? image(content.seo.imageAssetId) : null,
      },
      sections,
      version: meta.version,
      publishedAt: meta.publishedAt,
      preview: meta.preview,
    };
  }

  /** The live facts a section needs, read now. */
  private async resolve(section: StoredSection, site: SitePublicView | null): Promise<Record<string, unknown>> {
    switch (section.type) {
      case 'people':
        return this.people.listPublic({
          kind: section.fields.kind as 'TEAM' | 'INSTRUCTOR',
          placement: section.fields.placement as 'about' | 'cohort',
        });
      case 'applications_panel':
        return site ? { state: site.applications.open ? 'OPEN' : 'CLOSED', applications: site.applications } : {};
      case 'contact_info':
        return site ? { contact: site.contact } : {};
      case 'video_row':
      case 'showcase_grid':
        return { items: [] };
      default:
        return {};
    }
  }
}