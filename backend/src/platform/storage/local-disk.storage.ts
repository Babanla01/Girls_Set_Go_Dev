/**
 * local-disk.storage.ts
 * ---------------------------------------------------------------------------
 * Keeps files in a folder on the server (STORAGE_DIR in ".env", default
 * "./storage"). Fine for development and a single server; the interface in
 * storage.types.ts makes moving to cloud storage a small, separate change.
 *
 * Safety:
 *  - a key can never point outside the storage folder (checked twice);
 *  - a file is written to a temporary name and then renamed, so a crash in the
 *    middle never leaves a half-written picture behind.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import type { Env } from '../../config/env.validation';
import type { StorageProvider, StoredFile } from './storage.types';

@Injectable()
export class LocalDiskStorage implements StorageProvider {
  private readonly root: string;

  constructor(config: ConfigService<Env, true>) {
    this.root = resolve(config.get('STORAGE_DIR', { infer: true }) ?? './storage');
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.pathOf(key);
    await mkdir(dirname(target), { recursive: true });

    const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, data);
    await rename(temporary, target);
  }

  async open(key: string): Promise<StoredFile | null> {
    const target = this.pathOf(key);
    try {
      const info = await stat(target);
      if (!info.isFile()) return null;
      return { stream: createReadStream(target), size: info.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathOf(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.pathOf(key))).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  /** The real path of a key, refusing anything that would escape the storage folder. */
  private pathOf(key: string): string {
    const target = resolve(this.root, key);
    const inside = relative(this.root, target);
    if (inside === '' || inside.startsWith('..') || inside.split(sep).includes('..')) {
      throw new Error('Unsafe storage key.');
    }
    return target;
  }
}