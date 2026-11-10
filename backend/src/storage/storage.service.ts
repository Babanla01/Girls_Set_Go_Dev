/**
 * storage.service.ts
 * ---------------------------------------------------------------------------
 * File storage for the whole application. The rest of the code talks to the abstract
 * StorageService only, so the place files live can change (a local folder now, an
 * S3-compatible bucket later) without touching submissions or anything else.
 *
 *   save()         stores the bytes and records the file (name, type, size, checksum)
 *   linkFor()      a short-lived link for ONE file (made fresh every time it is needed)
 *   openFromToken  turns a link back into the file to send, or null when the link is
 *                  invalid or has expired
 *   remove()       deletes a file nothing refers to (used to clean up a failed upload)
 *
 * This version keeps files in a folder (STORAGE_DIR). Files are never public: the only way
 * to read one is through a signed link.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { DiskStore, keyFor } from './disk-store';
import { isInlineContentType } from './file-types';
import { signLink, verifyLink } from './signed-links';
import { FILE_LINK_PREFIX, SIGNED_LINK_TTL_SECONDS } from './storage.constants';

export interface SaveFileInput {
  name: string;
  contentType: string;
  buffer: Buffer;
  sha256: string;
  uploadedById: string;
}

export interface StoredFileView {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
}

export interface OpenedFile {
  stream: Readable;
  name: string;
  contentType: string;
  sizeBytes: number;
  /** true = may be shown in the page; false = always a download. */
  inline: boolean;
}

export abstract class StorageService {
  abstract save(input: SaveFileInput): Promise<StoredFileView>;
  abstract linkFor(fileId: string): string;
  abstract openFromToken(token: string): Promise<OpenedFile | null>;
  abstract remove(fileId: string): Promise<void>;
}

@Injectable()
export class LocalStorageService extends StorageService {
  private readonly store: DiskStore;
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    super();
    this.store = new DiskStore(config.get('STORAGE_DIR', { infer: true }));
    this.secret = config.get('SESSION_SECRET', { infer: true });
  }

  async save(input: SaveFileInput): Promise<StoredFileView> {
    const id = randomUUID();
    const storageKey = keyFor(id);

    await this.store.write(storageKey, input.buffer);
    try {
      await this.prisma.storedFile.create({
        data: {
          id,
          storageKey,
          originalName: input.name,
          contentType: input.contentType,
          sizeBytes: input.buffer.length,
          sha256: input.sha256,
          uploadedById: input.uploadedById,
        },
      });
    } catch (error) {
      await this.store.remove(storageKey); // never leave a file nothing knows about
      throw error;
    }
    return { id, name: input.name, contentType: input.contentType, sizeBytes: input.buffer.length };
  }

  linkFor(fileId: string): string {
    const expiresAt = Math.floor(Date.now() / 1000) + SIGNED_LINK_TTL_SECONDS;
    return `${FILE_LINK_PREFIX}/${signLink(this.secret, { fileId, expiresAt })}`;
  }

  async openFromToken(token: string): Promise<OpenedFile | null> {
    const claims = verifyLink(this.secret, token, Math.floor(Date.now() / 1000));
    if (!claims) return null;

    const row = await this.prisma.storedFile.findUnique({
      where: { id: claims.fileId },
      select: { storageKey: true, originalName: true, contentType: true },
    });
    if (!row) return null;

    const sizeBytes = await this.store.size(row.storageKey);
    if (sizeBytes === null) return null;

    return {
      stream: this.store.open(row.storageKey),
      name: row.originalName,
      contentType: row.contentType,
      sizeBytes,
      inline: isInlineContentType(row.contentType),
    };
  }

  async remove(fileId: string): Promise<void> {
    const row = await this.prisma.storedFile.findUnique({ where: { id: fileId }, select: { storageKey: true } });
    if (!row) return;
    await this.prisma.storedFile.delete({ where: { id: fileId } }); // refused while a submission still uses it
    await this.store.remove(row.storageKey);
  }
}
