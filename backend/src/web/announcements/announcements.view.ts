/**
 * announcements.view.ts
 * ---------------------------------------------------------------------------
 * What an announcement looks like for staff (admin / instructor) and for a student.
 */
import { AnnAudienceType, Prisma, Role } from '@prisma/client';

export const announcementSelect = {
  id: true,
  title: true,
  message: true,
  audienceType: true,
  trackId: true,
  cohortId: true,
  status: true,
  authorId: true,
  authorRole: true,
  publishedAt: true,
  editedAt: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, fullName: true } },
} satisfies Prisma.AnnAnnouncementSelect;

export type AnnouncementRow = Prisma.AnnAnnouncementGetPayload<{ select: typeof announcementSelect }>;

const roleLabel = (role: Role) => (role === Role.ADMIN ? 'Admin' : role === Role.INSTRUCTOR ? 'Instructor' : 'Staff');

/** For the admin / instructor screens. */
export function toAnnouncementView(row: AnnouncementRow, audienceLabel: string, extras: { recipientCount?: number; canEdit: boolean }) {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    audience: { type: row.audienceType, trackId: row.trackId, cohortId: row.cohortId, label: audienceLabel },
    status: row.status,
    author: { id: row.author.id, name: row.author.fullName, role: row.authorRole },
    publishedAt: row.publishedAt,
    editedAt: row.editedAt,
    canEdit: extras.canEdit,
    ...(extras.recipientCount === undefined ? {} : { recipientCount: extras.recipientCount }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** For a student's announcements page: title, author, date, text. No replies, no reactions. */
export function toStudentCard(row: AnnouncementRow, audienceLabel: string) {
  return {
    id: row.id,
    tag: row.audienceType === AnnAudienceType.ALL_COHORTS ? 'Programme update' : 'Course update',
    title: row.title,
    message: row.message,
    author: { name: row.author.fullName, roleLabel: roleLabel(row.authorRole) },
    audienceLabel,
    publishedAt: row.publishedAt,
    /** Set when the text was changed after it was published. */
    editedAt: row.editedAt,
  };
}