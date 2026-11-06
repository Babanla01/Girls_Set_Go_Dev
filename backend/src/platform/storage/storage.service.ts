/**
 * storage.service.ts
 * ---------------------------------------------------------------------------
 * The ONE door to file storage for the whole system (website pictures, shop
 * photos, and later the learning portal's student uploads).
 *
 * Keys look like "people/queen-tane.jpg". Two kinds exist:
 *   - PUBLIC pictures live under a media folder ("people/", "banners/" ...) and
 *     are served to anyone through the media routes;
 *   - PRIVATE files (student work and the like) MUST start with "private/" and
 *     are only ever handed out through short-lived signed links (see
 *     signed-url.service.ts). The public routes never serve a private/ key.
 */
import { Inject, Injectable } from '@nestjs/common';

import { STORAGE_PROVIDER, StorageProvider, StoredFile } from './storage.types';

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

  open(key: string): Promise<StoredFile | null> {
    return this.provider.open(this.checked(key));
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