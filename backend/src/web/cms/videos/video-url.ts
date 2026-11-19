/**
 * video-url.ts
 * ---------------------------------------------------------------------------
 * Embedded videos (YouTube, Vimeo): an admin pastes the video's link; we keep
 * only its id on that service and build the embed address ourselves. A link to
 * any other site is refused, so a video can never point somewhere unexpected.
 * The privacy-friendly player addresses are used (no tracking cookies).
 */
export type ExternalSource = 'YOUTUBE' | 'VIMEO';

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** The video's id on that service, or null when the link is not a link to such a video. */
export function parseExternalVideo(source: ExternalSource, input: string): { id: string } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);

  if (source === 'YOUTUBE') {
    if (!YOUTUBE_HOSTS.has(host)) return null;
    const id =
      host === 'youtu.be'
        ? parts[0]
        : parts[0] === 'watch'
          ? (url.searchParams.get('v') ?? undefined)
          : ['embed', 'live', 'shorts', 'v'].includes(parts[0] ?? '')
            ? parts[1]
            : undefined;
    return id && YOUTUBE_ID.test(id) ? { id } : null;
  }

  if (!VIMEO_HOSTS.has(host)) return null;
  const index = parts.findIndex((part) => /^\d{6,12}$/.test(part));
  if (index === -1) return null;
  const hash = parts[index + 1] && /^[a-f0-9]{8,12}$/i.test(parts[index + 1]) ? parts[index + 1] : url.searchParams.get('h');
  return { id: hash && /^[a-f0-9]{8,12}$/i.test(hash) ? `${parts[index]}:${hash}` : parts[index] };
}

/** Where the embedded player lives. */
export function embedUrl(source: ExternalSource, externalId: string): string {
  if (source === 'YOUTUBE') return `https://www.youtube-nocookie.com/embed/${externalId}?rel=0&modestbranding=1&cc_load_policy=1`;
  const [id, hash] = externalId.split(':');
  return `https://player.vimeo.com/video/${id}?dnt=1&texttrack=en${hash ? `&h=${hash}` : ''}`;
}

/** The video's page on that service (for a "watch there" link). */
export function watchUrl(source: ExternalSource, externalId: string): string {
  if (source === 'YOUTUBE') return `https://www.youtube.com/watch?v=${externalId}`;
  const [id, hash] = externalId.split(':');
  return `https://vimeo.com/${id}${hash ? `/${hash}` : ''}`;
}