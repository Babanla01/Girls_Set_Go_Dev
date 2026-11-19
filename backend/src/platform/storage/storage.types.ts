/**
 * storage.types.ts
 * ---------------------------------------------------------------------------
 * What a "place to keep files" must be able to do. Today files live on the
 * server's disk (see local-disk.storage.ts); to move to cloud storage later,
 * write one more class that implements this interface and change ONE line in
 * platform.module.ts. Nothing else in the system needs to change.
 */
import type { Readable } from 'node:stream';

/** A slice of a file: first and last byte, both included (like an HTTP "Range"). */
export interface ByteRange {
  start: number;
  end: number;
}

export interface StoredFile {
  /** The file's bytes - or only the asked-for slice, when a range was given. */
  stream: Readable;
  /** The size of the WHOLE file (not of the slice). */
  size: number;
}

export interface StorageProvider {
  /** Saves (or overwrites) a file. */
  put(key: string, data: Buffer): Promise<void>;
  /** Saves a file that is already on disk, without loading it into memory (for large uploads). */
  putFile(key: string, sourcePath: string): Promise<void>;
  /** Opens a file for streaming (all of it, or one slice), or null when it does not exist. */
  open(key: string, range?: ByteRange): Promise<StoredFile | null>;
  /** The size of a file in bytes, or null when it does not exist. */
  size(key: string): Promise<number | null>;
  /** Reads a whole file into memory, or null when it does not exist. */
  read(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  /** Removes a file. A file that is already gone is not an error. */
  delete(key: string): Promise<void>;
}

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');