/**
 * storage.types.ts
 * ---------------------------------------------------------------------------
 * What a "place to keep files" must be able to do. Today files live on the
 * server's disk (see local-disk.storage.ts); to move to cloud storage later,
 * write one more class that implements this interface and change ONE line in
 * platform.module.ts. Nothing else in the system needs to change.
 */
import type { Readable } from 'node:stream';

export interface StoredFile {
  stream: Readable;
  size: number;
}

export interface StorageProvider {
  /** Saves (or overwrites) a file. */
  put(key: string, data: Buffer): Promise<void>;
  /** Opens a file for streaming, or null when it does not exist. */
  open(key: string): Promise<StoredFile | null>;
  /** Reads a whole file into memory, or null when it does not exist. */
  read(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  /** Removes a file. A file that is already gone is not an error. */
  delete(key: string): Promise<void>;
}

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');