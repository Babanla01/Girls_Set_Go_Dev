/**
 * block-data.ts
 * ---------------------------------------------------------------------------
 * Checks and cleans the contents of a lesson block. Each kind of block has its
 * own fields, so the database keeps them as a flexible JSON object and THIS file
 * is what guarantees the object is valid:
 *
 *   TEXT      { body }
 *   VIDEO     { source: YOUTUBE | VIMEO | NONE, url?, transcript?, hasCaptions?, durationMinutes? }
 *   ACTIVITY  { title, instructions, estimatedMinutes? }
 *   STEPS     { title?, steps: [ { title, detail? } ] }
 *   CALLOUT   { tone: INFO | TIP | WARNING, title?, body }
 *   RESOURCE  { title, url, description? }        (a web link; file uploads come later)
 *
 * Rules that hold everywhere:
 *   - unknown fields are refused (nothing sneaks into the database);
 *   - text is trimmed, and single-line text has repeated spaces squashed;
 *   - EVERY problem is reported together, so the person fixes them in one go;
 *   - web addresses must be http:// or https:// with no embedded password
 *     (this blocks "javascript:" and similar tricks on the server);
 *   - a YouTube / Vimeo address is checked against that site and stored in its
 *     standard form together with the video id.
 */
import { BadRequestException } from '@nestjs/common';
import type { BlockType, Prisma } from '@prisma/client';

import { cleanLabel } from '../catalog/catalog.util';
import { LIMITS } from './course-content.constants';

type Input = Record<string, unknown>;
type Built = { problems: string[]; data: Prisma.InputJsonObject };

// ---------------------------------------------------------------- web addresses

/** Returns the parsed address, or null unless it is a plain http(s) link. */
export function parseHttpUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null; // no "user:password@" tricks
  if (url.hostname === '') return null;
  return url;
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be']);
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);

/** Finds the video id inside a YouTube address (watch, share, embed, shorts or live links). */
export function parseYouTube(url: URL): { videoId: string; url: string } | null {
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;

  let id: string | null | undefined;
  if (url.hostname.toLowerCase() === 'youtu.be') {
    id = url.pathname.split('/')[1];
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v');
  } else {
    id = /^\/(?:embed|shorts|live)\/([^/?]+)/.exec(url.pathname)?.[1];
  }

  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  return { videoId: id, url: `https://www.youtube.com/watch?v=${id}` };
}

/** Finds the video id inside a Vimeo address (an optional private-link hash is kept). */
export function parseVimeo(url: URL): { videoId: string; url: string } | null {
  if (!VIMEO_HOSTS.has(url.hostname.toLowerCase())) return null;

  const match = /^\/(?:video\/)?(\d{6,12})(?:\/([0-9a-f]{6,12}))?\/?$/.exec(url.pathname);
  if (!match) return null;

  const [, id, hash] = match;
  return { videoId: id, url: hash ? `https://vimeo.com/${id}/${hash}` : `https://vimeo.com/${id}` };
}

// ---------------------------------------------------------------- the reader

/** Reads fields from the submitted object, remembering every problem it meets. */
class Reader {
  readonly problems: string[] = [];

  constructor(
    readonly input: Input,
    allowedKeys: readonly string[],
    private readonly path = '',
  ) {
    for (const key of Object.keys(input)) {
      if (!allowedKeys.includes(key)) this.problems.push(`${path}${key} is not a field of this kind of block.`);
    }
  }

  private missing(key: string, optional: boolean | undefined): undefined {
    if (!optional) this.problems.push(`${this.path}${key} is required.`);
    return undefined;
  }

  /** Text. Empty text counts as "not provided". */
  text(key: string, options: { max: number; min?: number; multiline?: boolean; optional?: boolean }): string | undefined {
    const raw = this.input[key];
    if (raw === undefined || raw === null) return this.missing(key, options.optional);
    if (typeof raw !== 'string') {
      this.problems.push(`${this.path}${key} must be text.`);
      return undefined;
    }

    const value = options.multiline ? raw.replace(/\r\n?/g, '\n').trim() : cleanLabel(raw);
    if (value === '') return this.missing(key, options.optional);

    if (value.length < (options.min ?? 1)) {
      this.problems.push(`${this.path}${key} must be at least ${options.min} characters.`);
      return undefined;
    }
    if (value.length > options.max) {
      this.problems.push(`${this.path}${key} must be at most ${options.max} characters.`);
      return undefined;
    }
    return value;
  }

  /** A whole number between min and max. */
  integer(key: string, min: number, max: number, optional = false): number | undefined {
    const raw = this.input[key];
    if (raw === undefined || raw === null) return this.missing(key, optional);
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
      this.problems.push(`${this.path}${key} must be a whole number from ${min} to ${max}.`);
      return undefined;
    }
    return raw;
  }

  /** true or false. */
  flag(key: string): boolean | undefined {
    const raw = this.input[key];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'boolean') {
      this.problems.push(`${this.path}${key} must be true or false.`);
      return undefined;
    }
    return raw;
  }

  /** One of a fixed list of words. */
  choice<T extends string>(key: string, allowed: readonly T[]): T | undefined {
    const raw = this.input[key];
    if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
      this.problems.push(`${this.path}${key} must be one of: ${allowed.join(', ')}.`);
      return undefined;
    }
    return raw as T;
  }

  /** An http(s) web address. */
  webAddress(key: string, optional = false): URL | undefined {
    const raw = this.text(key, { max: LIMITS.url, optional });
    if (raw === undefined) return undefined;

    const parsed = parseHttpUrl(raw);
    if (!parsed) {
      this.problems.push(`${this.path}${key} must be a web address starting with http:// or https://.`);
      return undefined;
    }
    return parsed;
  }
}

// ---------------------------------------------------------------- one builder per kind of block

function buildText(input: Input): Built {
  const r = new Reader(input, ['body']);
  const body = r.text('body', { max: LIMITS.textBody, multiline: true });
  return { problems: r.problems, data: { body: body ?? '' } };
}

function buildVideo(input: Input): Built {
  // "videoId" is something we work out ourselves; it may come back from the screen, so it is allowed but ignored.
  const r = new Reader(input, ['source', 'url', 'videoId', 'transcript', 'hasCaptions', 'durationMinutes']);
  const source = r.choice('source', ['YOUTUBE', 'VIMEO', 'NONE'] as const);
  const transcript = r.text('transcript', { max: LIMITS.transcript, multiline: true, optional: true });
  const hasCaptions = r.flag('hasCaptions');
  const durationMinutes = r.integer('durationMinutes', 1, LIMITS.minutes, true);

  let video: { videoId: string; url: string } | undefined;
  if (source === 'NONE') {
    if (input.url !== undefined && input.url !== null && input.url !== '') {
      r.problems.push('A block with no video cannot have a web address.');
    }
  } else if (source) {
    const address = r.webAddress('url');
    if (address) {
      const parsed = source === 'YOUTUBE' ? parseYouTube(address) : parseVimeo(address);
      if (parsed) video = parsed;
      else r.problems.push(`url must be a ${source === 'YOUTUBE' ? 'YouTube' : 'Vimeo'} video address.`);
    }
  }

  return {
    problems: r.problems,
    data: {
      source: source ?? 'NONE',
      ...(video ? { url: video.url, videoId: video.videoId } : {}),
      ...(transcript ? { transcript } : {}),
      hasCaptions: hasCaptions ?? false,
      ...(durationMinutes ? { durationMinutes } : {}),
    },
  };
}

function buildActivity(input: Input): Built {
  const r = new Reader(input, ['title', 'instructions', 'estimatedMinutes']);
  const title = r.text('title', { min: 2, max: LIMITS.title });
  const instructions = r.text('instructions', { max: LIMITS.instructions, multiline: true });
  const estimatedMinutes = r.integer('estimatedMinutes', 1, LIMITS.minutes, true);
  return {
    problems: r.problems,
    data: { title: title ?? '', instructions: instructions ?? '', ...(estimatedMinutes ? { estimatedMinutes } : {}) },
  };
}

function buildSteps(input: Input): Built {
  const r = new Reader(input, ['title', 'steps']);
  const title = r.text('title', { max: LIMITS.title, optional: true });

  const steps: Prisma.InputJsonObject[] = [];
  const raw = input.steps;
  if (!Array.isArray(raw) || raw.length === 0) {
    r.problems.push('steps must be a list with at least one step.');
  } else if (raw.length > LIMITS.steps) {
    r.problems.push(`steps can have at most ${LIMITS.steps} steps.`);
  } else {
    raw.forEach((item: unknown, index: number) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        r.problems.push(`steps[${index}] must be an object.`);
        return;
      }
      const step = new Reader(item as Input, ['title', 'detail'], `steps[${index}].`);
      const stepTitle = step.text('title', { max: LIMITS.stepTitle });
      const detail = step.text('detail', { max: LIMITS.stepDetail, multiline: true, optional: true });
      r.problems.push(...step.problems);
      steps.push({ title: stepTitle ?? '', ...(detail ? { detail } : {}) });
    });
  }

  return { problems: r.problems, data: { ...(title ? { title } : {}), steps } };
}

function buildCallout(input: Input): Built {
  const r = new Reader(input, ['tone', 'title', 'body']);
  const tone = r.choice('tone', ['INFO', 'TIP', 'WARNING'] as const);
  const title = r.text('title', { max: LIMITS.title, optional: true });
  const body = r.text('body', { max: LIMITS.calloutBody, multiline: true });
  return { problems: r.problems, data: { tone: tone ?? 'INFO', ...(title ? { title } : {}), body: body ?? '' } };
}

function buildResource(input: Input): Built {
  const r = new Reader(input, ['title', 'url', 'description']);
  const title = r.text('title', { min: 2, max: LIMITS.title });
  const address = r.webAddress('url');
  const description = r.text('description', { max: LIMITS.description, optional: true });
  return {
    problems: r.problems,
    data: { title: title ?? '', url: address?.href ?? '', ...(description ? { description } : {}) },
  };
}

const BUILDERS: Record<BlockType, (input: Input) => Built> = {
  TEXT: buildText,
  VIDEO: buildVideo,
  ACTIVITY: buildActivity,
  STEPS: buildSteps,
  CALLOUT: buildCallout,
  RESOURCE: buildResource,
};

/**
 * Checks and cleans a block's contents. Returns the clean object to store, or
 * throws a 400 listing EVERY problem found.
 */
export function normalizeBlockData(type: BlockType, raw: unknown): Prisma.InputJsonObject {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('data must be an object.');
  }

  const built = BUILDERS[type](raw as Input);
  if (built.problems.length > 0) throw new BadRequestException(built.problems);
  return built.data;
}
