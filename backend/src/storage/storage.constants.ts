/**
 * storage.constants.ts
 * ---------------------------------------------------------------------------
 * The limits and names of file storage, in ONE place.
 */

/** How long a file link works after it is handed out (seconds). Links are made fresh on every request. */
export const SIGNED_LINK_TTL_SECONDS = 300;

/** The address files are served from (the token is appended). */
export const FILE_LINK_PREFIX = '/api/v1/files';

/** The biggest single upload (20 MB). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Longest file name we keep (the real name is only for display; storage uses a random key). */
export const MAX_FILE_NAME_LENGTH = 120;
