/**
 * disk-store.ts
 * ---------------------------------------------------------------------------
 * Keeps file CONTENTS in a folder on disk. Knows nothing about the database.
 *
 *  - A file is stored under a random key (two letters / a uuid), never under the
 *    student's file name, so a name can never reach outside the folder or collide.
 *  - Every key is checked against that exact shape and must stay inside the folder.
 *  - A file is never overwritten (it is written with "create only").
 *  - Files are readable only by the server's own account (permissions 640 / 750).
 */
import { createReadStream, ReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

const KEY_SHAPE = /^[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The storage key for a new file id: "ab/ab12...". */
export const keyFor = (fileId: string): string => `${fileId.slice(0, 2)}/${fileId}`;

export class DiskStore {
  private readonly root: string;

  constructor(folder: string) {
    this.root = resolve(folder);
  }

  private pathFor(key: string): string {
    if (!KEY_SHAPE.test(key)) throw new Error('Invalid storage key.');
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error('Invalid storage key.');
    return full;
  }

  async write(key: string, data: Buffer): Promise<void> {
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true, mode: 0o750 });
    await writeFile(full, data, { flag: 'wx', mode: 0o640 });
  }

  /** The size in bytes, or null when the file is not there. */
  async size(key: string): Promise<number | null> {
    try {
      return (await stat(this.pathFor(key))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  open(key: string): ReadStream {
    return createReadStream(this.pathFor(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
