/**
 * media-usage.service.ts
 * ---------------------------------------------------------------------------
 * Keeps the "used on" list of every picture up to date.
 *
 * Whenever something that shows pictures is saved (a person, a page, a banner,
 * a video thumbnail, a product ...), it tells THIS service which pictures it
 * uses, in the same database transaction. The media library then knows where a
 * picture appears and refuses to delete a picture that is still in use.
 *
 *     await usage.replaceFor('person', person.id, 'Person: Queen Tane',
 *                            [{ field: 'photo', assetId: person.photoAssetId }], tx);
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import type { CmsMediaFolder } from '@prisma/client';

import type { DbClient } from '../../../common/types/db-client';

/** The facts about a picture that other features need when they use it. */
export interface MediaAssetRef {
  id: string;
  key: string;
  folder: CmsMediaFolder;
  version: number;
  altText: string;
  width: number;
  height: number;
  consentRecordedAt: Date | null;
}

export interface UsageRef {
  /** Which part of the thing uses the picture, e.g. "photo", "hero". */
  field: string;
  assetId: string | null | undefined;
}

@Injectable()
export class MediaUsageService {
  /** Replaces everything this one thing uses with the given list. */
  async replaceFor(entityType: string, entityId: string, label: string, refs: UsageRef[], db: DbClient): Promise<void> {
    await db.cmsMediaUsage.deleteMany({ where: { entityType, entityId } });

    const unique = new Map<string, { assetId: string; field: string }>();
    for (const ref of refs) {
      if (ref.assetId) unique.set(`${ref.assetId}|${ref.field}`, { assetId: ref.assetId, field: ref.field });
    }
    if (unique.size === 0) return;

    await db.cmsMediaUsage.createMany({
      data: [...unique.values()].map(({ assetId, field }) => ({
        assetId,
        entityType,
        entityId,
        field,
        label: label.slice(0, 200),
      })),
    });
  }

  /** Forgets everything this thing used (call when it is deleted). */
  async removeFor(entityType: string, entityId: string, db: DbClient): Promise<void> {
    await db.cmsMediaUsage.deleteMany({ where: { entityType, entityId } });
  }

  /** Loads the pictures with the given ids; refuses clearly if any does not exist. */
  async requireAssets(assetIds: string[], db: DbClient): Promise<Map<string, MediaAssetRef>> {
    const unique = [...new Set(assetIds)];
    if (unique.length === 0) return new Map();

    const rows = await this.loadAssets(unique, db);
    const found = new Map(rows.map((row) => [row.id, row]));
    const missing = unique.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `${missing.length === 1 ? 'A picture' : `${missing.length} pictures`} you chose no longer exist${missing.length === 1 ? 's' : ''} in the media library.`,
      );
    }
    return found;
  }

  private loadAssets(ids: string[], db: DbClient): Promise<MediaAssetRef[]> {
    return db.cmsMediaAsset.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        key: true,
        folder: true,
        version: true,
        altText: true,
        width: true,
        height: true,
        consentRecordedAt: true,
      },
    });
  }
}