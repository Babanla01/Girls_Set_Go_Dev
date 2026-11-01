/**
 * video-position.dto.ts - where the student paused a video ("Resume from 03:12").
 */
import { IsInt, IsUUID, Max, Min } from 'class-validator';

import { MAX_VIDEO_SECONDS } from '../learning.constants';

export class VideoPositionDto {
  /** The video block inside the lesson. */
  @IsUUID()
  blockId!: string;

  /** Seconds from the start of the video. */
  @IsInt()
  @Min(0)
  @Max(MAX_VIDEO_SECONDS)
  seconds!: number;
}
