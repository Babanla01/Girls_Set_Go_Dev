/**
 * upload.constants.ts
 * ---------------------------------------------------------------------------
 * The limits of a student upload, in ONE place.
 */

/** The biggest single upload (20 MB). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Longest file name we keep (the real name is only for display; storage uses a random key). */
export const MAX_FILE_NAME_LENGTH = 120;
