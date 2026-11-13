/**
 * submission-files.service.ts
 * ---------------------------------------------------------------------------
 * Files that belong to student submissions, kept in the SHARED file storage
 * (src/platform/storage) - the same "one door" the website side uses.
 *
 *  - A file is stored under a private key, "private/submissions/<id>": never under the
 *    student's file name, and never reachable without a signed link.
 *  - A link is made for ONE person (the one who asked to see the file) and works for a few
 *    minutes: a student's link cannot be passed on, and an instructor's link works only for
 *    that instructor. Links are made fresh every time a page is loaded.
 *  - The database keeps what each file is (name, type, size, SHA-256 checksum) in
 *    "stored_files"; the bytes live in storage.
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { SignedUrlService } from '../platform/storage/signed-url.service';
import { StorageService } from '../platform/storage/storage.service';

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

/** What is needed to make a link for a stored file. */
export interface LinkableFile {
  storageKey: string;
  contentType: string;
  originalName: string;
}

/** Where file links are served (the shared private-file route). */
const PRIVATE_LINK_PREFIX = '/api/v1/files/private';

@Injectable()
export class SubmissionFilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly signed: SignedUrlService,
  ) {}

  /** Stores the bytes, then records the file. If recording fails, the bytes are removed again. */
  async save(input: SaveFileInput): Promise<StoredFileView> {
    const id = randomUUID();
    const storageKey = `private/submissions/${id}`;

    await this.storage.put(storageKey, input.buffer);
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
      await this.storage.delete(storageKey); // never leave a file nothing knows about
      throw error;
    }
    return { id, name: input.name, contentType: input.contentType, sizeBytes: input.buffer.length };
  }

  /** A short-lived link for ONE person to open ONE file. */
  linkFor(file: LinkableFile, viewerId: string): string {
    const token = this.signed.sign({
      key: file.storageKey,
      contentType: file.contentType,
      filename: file.originalName,
      userId: viewerId,
    });
    return `${PRIVATE_LINK_PREFIX}/${token}`;
  }

  /** Removes a file nothing refers to (the clean-up after a failed submission). */
  async remove(fileId: string): Promise<void> {
    const row = await this.prisma.storedFile.findUnique({ where: { id: fileId }, select: { storageKey: true } });
    if (!row) return;
    await this.prisma.storedFile.delete({ where: { id: fileId } }); // refused while a submission still uses it
    await this.storage.delete(row.storageKey);
  }
}
