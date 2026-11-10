/**
 * people.view.ts
 * ---------------------------------------------------------------------------
 * What a public profile looks like: the full version for the admin screen
 * (with a "can it be published?" check) and the small version for the website.
 */
import type { CmsContentStatus, CmsMediaFolder, CmsPersonKind, Prisma } from '@prisma/client';

import { PERSON_PHOTO_MIN_SIDE } from '../media/media.constants';
import { publicImageSelect, toPublicImage } from '../media/media.view';

export const personSelect = {
  id: true,
  fullName: true,
  title: true,
  subtitle: true,
  kind: true,
  bio: true,
  photoAssetId: true,
  showOnAbout: true,
  showOnCohort: true,
  displayOrder: true,
  status: true,
  publishedAt: true,
  linkedInstructorId: true,
  createdAt: true,
  updatedAt: true,
  photo: { select: { id: true, folder: true, consentRecordedAt: true, ...publicImageSelect } },
} satisfies Prisma.CmsPersonSelect;

type PersonRow = Prisma.CmsPersonGetPayload<{ select: typeof personSelect }>;

interface PhotoFacts {
  folder: CmsMediaFolder;
  consentRecordedAt: Date | null;
  width: number;
  height: number;
}

/**
 * What is still missing before a profile may be published (an empty list means
 * it is ready). The database enforces the title and photo; the rest is checked here.
 */
export function personProblems(person: { title: string; photo: PhotoFacts | null }): string[] {
  const problems: string[] = [];

  if (!person.title.trim()) problems.push('A title is needed.');

  if (!person.photo) {
    problems.push('A photo is needed.');
  } else {
    if (person.photo.folder !== 'PEOPLE') problems.push('The photo must come from the People folder.');
    if (!person.photo.consentRecordedAt) problems.push('The photo needs its consent recorded.');
    if (Math.min(person.photo.width, person.photo.height) < PERSON_PHOTO_MIN_SIDE) {
      problems.push(`The photo must be at least ${PERSON_PHOTO_MIN_SIDE} × ${PERSON_PHOTO_MIN_SIDE} px.`);
    }
  }
  return problems;
}

export function toPersonView(row: PersonRow) {
  const problems = personProblems({ title: row.title, photo: row.photo });
  return {
    id: row.id,
    fullName: row.fullName,
    title: row.title,
    subtitle: row.subtitle,
    kind: row.kind as CmsPersonKind,
    bio: row.bio,
    photo: row.photo ? { assetId: row.photo.id, ...toPublicImage(row.photo) } : null,
    showOnAbout: row.showOnAbout,
    showOnCohort: row.showOnCohort,
    displayOrder: row.displayOrder,
    status: row.status as CmsContentStatus,
    publishedAt: row.publishedAt,
    /** Set when this is the profile of an instructor account of the learning portal. */
    linkedInstructorId: row.linkedInstructorId,
    /** Whether it can be published now, and what is missing if not. */
    completeness: { canPublish: problems.length === 0, missing: problems },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The small version shown on the public website. */
export function toPublicPerson(row: PersonRow) {
  return {
    id: row.id,
    fullName: row.fullName,
    title: row.title,
    subtitle: row.subtitle,
    kind: row.kind as CmsPersonKind,
    bio: row.bio || null,
    photo: row.photo ? toPublicImage(row.photo) : null,
  };
}