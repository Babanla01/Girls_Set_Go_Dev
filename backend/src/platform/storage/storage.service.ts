/**
 * storage.service.ts
 * ---------------------------------------------------------------------------
 * The ONE door to file storage for the whole website side (pictures, videos,
 * shop photos).
 *
 * Keys look like "people/queen-tane.jpg". Two kinds exist:
 *   - PUBLIC pictures live under a media folder ("people/", "banners/" ...) and
 *     are served to anyone through the media routes;
 *   - PRIVATE files MUST start with "private/" and are only ever handed out
 *     through short-lived signed links (see signed-url.service.ts). The public
 *     routes never serve a private/ key.
 * Uploaded videos live under "video-files/" and are served by their own route.
 */
import { Inject, Injectable } from '@nestjs/common';

import { ByteRange, STORAGE_PROVIDER, StorageProvider, StoredFile } from './storage.types';

/** Lowercase segments separated by single slashes; the last one may contain dots. */
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_.-]*)+$/;
const MAX_KEY_LENGTH = 200;

export const PRIVATE_PREFIX = 'private/';

@Injectable()
export class StorageService {
  constructor(@Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider) {}

  static isValidKey(key: string): boolean {
    return key.length <= MAX_KEY_LENGTH && KEY_PATTERN.test(key) && !key.includes('..');
  }

  static isPrivateKey(key: string): boolean {
    return key.startsWith(PRIVATE_PREFIX);
  }

  put(key: string, data: Buffer): Promise<void> {
    return this.provider.put(this.checked(key), data);
  }

  /** Saves a file that is already on disk (large uploads), without reading it into memory. */
  putFile(key: string, sourcePath: string): Promise<void> {
    return this.provider.putFile(this.checked(key), sourcePath);
  }

  open(key: string, range?: ByteRange): Promise<StoredFile | null> {
    return this.provider.open(this.checked(key), range);
  }

  size(key: string): Promise<number | null> {
    return this.provider.size(this.checked(key));
  }

  read(key: string): Promise<Buffer | null> {
    return this.provider.read(this.checked(key));
  }

  exists(key: string): Promise<boolean> {
    return this.provider.exists(this.checked(key));
  }

  delete(key: string): Promise<void> {
    return this.provider.delete(this.checked(key));
  }

  private checked(key: string): string {
    if (!StorageService.isValidKey(key)) throw new Error(`Invalid storage key "${key}".`);
    return key;
  }
}