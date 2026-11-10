/**
 * uploaded-picture.ts
 * ---------------------------------------------------------------------------
 * The few facts about an uploaded file that the media library uses. (The upload
 * library hands over more; this is all that is needed, kept explicit so the
 * code does not depend on any global type.)
 */
export interface UploadedPicture {
  /** The file's bytes. */
  buffer: Buffer;
  /** The name the file had on the uploader's computer. */
  originalname: string;
  mimetype: string;
  size: number;
}