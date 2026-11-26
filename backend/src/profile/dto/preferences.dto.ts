/**
 * preferences.dto.ts - the settings a person can save for herself. For now: the profile panel.
 */
import { IsEnum } from 'class-validator';
import { PanelState } from '@prisma/client';

export class UpdatePreferencesDto {
  /** OPEN, COLLAPSED (a thin rail with icons) or CLOSED. */
  @IsEnum(PanelState)
  profilePanel!: PanelState;
}
