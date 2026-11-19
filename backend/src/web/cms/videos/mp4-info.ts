/**
 * mp4-info.ts
 * ---------------------------------------------------------------------------
 * Reads the facts straight out of an uploaded MP4 / MOV file: that it REALLY is
 * a video file, how long it runs, and how big the picture is. (Nothing is taken
 * on trust from the browser or the file name.)
 *
 * An MP4/MOV file is a series of "boxes". We only look at the box headers, and
 * read the one "moov" box that holds the facts - never the whole video.
 */
import { open } from 'node:fs/promises';

export interface Mp4Info {
  /** The file's brand, e.g. "isom", "mp42" or "qt  ". */
  brand: string;
  durationSeconds: number;
  width: number;
  height: number;
}

const MAX_MOOV_BYTES = 32 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 10_000;

interface Box {
  type: string;
  start: number; // where the box's content begins
  end: number; // where the box ends
}

/** The boxes directly inside buffer[start, end). */
function boxesIn(buffer: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let position = start;

  while (position + 8 <= end && boxes.length < 1000) {
    let size = buffer.readUInt32BE(position);
    const type = buffer.toString('latin1', position + 4, position + 8);
    let header = 8;

    if (size === 1) {
      if (position + 16 > end) break;
      size = Number(buffer.readBigUInt64BE(position + 8));
      header = 16;
    } else if (size === 0) {
      size = end - position;
    }
    if (size < header || position + size > end) break;

    boxes.push({ type, start: position + header, end: position + size });
    position += size;
  }
  return boxes;
}

/** Reads the length (from "mvhd") and the picture size (from the first video "tkhd") inside the moov box. */
function readMoov(moov: Buffer): Omit<Mp4Info, 'brand'> | null {
  let duration = 0;
  let width = 0;
  let height = 0;

  for (const box of boxesIn(moov, 0, moov.length)) {
    if (box.type === 'mvhd') {
      const version = moov[box.start];
      if (version === 1 && box.end - box.start >= 32) {
        const timescale = moov.readUInt32BE(box.start + 20);
        duration = timescale > 0 ? Number(moov.readBigUInt64BE(box.start + 24)) / timescale : 0;
      } else if (version === 0 && box.end - box.start >= 20) {
        const timescale = moov.readUInt32BE(box.start + 12);
        duration = timescale > 0 ? moov.readUInt32BE(box.start + 16) / timescale : 0;
      }
    } else if (box.type === 'trak' && width === 0) {
      for (const inner of boxesIn(moov, box.start, box.end)) {
        if (inner.type !== 'tkhd') continue;
        const offset = moov[inner.start] === 1 ? 88 : 76; // where the picture size sits (16.16 numbers)
        if (inner.end - inner.start < offset + 8) continue;

        const w = moov.readUInt32BE(inner.start + offset) >>> 16;
        const h = moov.readUInt32BE(inner.start + offset + 4) >>> 16;
        if (w > 0 && h > 0) {
          width = w;
          height = h;
        }
      }
    }
  }

  if (!Number.isFinite(duration) || duration <= 0 || width === 0 || height === 0) return null; // no picture = not a video
  return { durationSeconds: Math.max(1, Math.round(duration)), width, height };
}

/**
 * The facts of the file at `path`, or null when it is not a readable MP4 / MOV video.
 * The WHOLE file is checked for being complete: every top-level box must fit inside it and the
 * boxes must run to the end, so a video that was cut short (or damaged) is refused.
 */
export async function readMp4Info(path: string): Promise<Mp4Info | null> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 16) return null;

    const head = Buffer.alloc(12);
    await handle.read(head, 0, 12, 0);
    if (head.toString('latin1', 4, 8) !== 'ftyp') return null; // every MP4/MOV starts with an "ftyp" box
    const brand = head.toString('latin1', 8, 12);

    let facts: Omit<Mp4Info, 'brand'> | null = null;
    let position = 0;
    for (let count = 0; position + 8 <= size && count < MAX_TOP_LEVEL_BOXES; count += 1) {
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, 16, position);
      if (bytesRead < 8) return null;

      let boxSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      let headerLength = 8;
      if (boxSize === 1) {
        if (bytesRead < 16) return null;
        boxSize = Number(header.readBigUInt64BE(8));
        headerLength = 16;
      } else if (boxSize === 0) {
        boxSize = size - position;
      }
      if (boxSize < headerLength || position + boxSize > size) return null; // damaged or cut short

      if (type === 'moov' && facts === null) {
        const length = boxSize - headerLength;
        if (length > MAX_MOOV_BYTES) return null;
        const moov = Buffer.alloc(length);
        await handle.read(moov, 0, length, position + headerLength);
        facts = readMoov(moov);
        if (!facts) return null;
      }
      position += boxSize;
    }

    // Complete only if the boxes ran right to the end of the file (a few spare bytes are tolerated).
    return facts && size - position < 8 ? { brand, ...facts } : null;
  } finally {
    await handle.close();
  }
}