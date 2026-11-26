-- WEB account, batch W4: notifications (the bell), announcements, and the public forms.
--
--   platform_notifications   one row per item in a person's notification bell
--   ann_announcements        updates written by admins / instructors for a cohort, a track or all cohorts
--   form_submissions         messages sent through the Contact, Volunteer and Partner forms
--   form_notify_me_signups   the "notify me when applications open" list
--
-- New tables only: no existing data is converted and no LMS table is changed.
-- The CHECK rules and the partial index below are HAND-WRITTEN (Prisma cannot express them).

-- ---------------------------------------------------------------- enums
CREATE TYPE "AnnAudienceType"      AS ENUM ('ALL_COHORTS', 'TRACK', 'COHORT');
CREATE TYPE "AnnStatus"            AS ENUM ('DRAFT', 'PUBLISHED');
CREATE TYPE "FormSubmissionType"   AS ENUM ('CONTACT', 'VOLUNTEER', 'PARTNER');
CREATE TYPE "FormSubmissionStatus" AS ENUM ('NEW', 'READ', 'ARCHIVED');
CREATE TYPE "FormNotifyMeStatus"   AS ENUM ('SUBSCRIBED', 'UNSUBSCRIBED');

-- ------------------------------------------------------ platform_notifications
CREATE TABLE "platform_notifications" (
    "id"           UUID           NOT NULL DEFAULT gen_random_uuid(),
    "recipient_id" UUID           NOT NULL,
    "type"         VARCHAR(60)    NOT NULL,
    "payload"      JSONB          NOT NULL DEFAULT '{}',
    "dedupe_key"   VARCHAR(120),
    "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at"      TIMESTAMPTZ(3),
    CONSTRAINT "platform_notifications_pkey" PRIMARY KEY ("id")
);

-- -------------------------------------------------------------- ann_announcements
CREATE TABLE "ann_announcements" (
    "id"            UUID              NOT NULL DEFAULT gen_random_uuid(),
    "title"         VARCHAR(120)      NOT NULL,
    "message"       VARCHAR(1500)     NOT NULL,
    "audience_type" "AnnAudienceType" NOT NULL,
    "track_id"      UUID,
    "cohort_id"     UUID,
    "status"        "AnnStatus"       NOT NULL DEFAULT 'DRAFT',
    "author_id"     UUID              NOT NULL,
    "author_role"   "Role"            NOT NULL,
    "published_at"  TIMESTAMPTZ(3),
    "edited_at"     TIMESTAMPTZ(3),
    "created_at"    TIMESTAMPTZ(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMPTZ(3)    NOT NULL,
    CONSTRAINT "ann_announcements_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------- form_submissions
CREATE TABLE "form_submissions" (
    "id"           UUID                   NOT NULL DEFAULT gen_random_uuid(),
    "type"         "FormSubmissionType"   NOT NULL,
    "status"       "FormSubmissionStatus" NOT NULL DEFAULT 'NEW',
    "sender_name"  VARCHAR(160)           NOT NULL,
    "sender_email" VARCHAR(254)           NOT NULL,
    "payload"      JSONB                  NOT NULL,
    "summary"      VARCHAR(200)           NOT NULL,
    "routed_to"    VARCHAR(254),
    "content_hash" CHAR(64)               NOT NULL,
    "handled_by_id" UUID,
    "handled_at"   TIMESTAMPTZ(3),
    "created_at"   TIMESTAMPTZ(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "form_submissions_pkey" PRIMARY KEY ("id")
);

-- ------------------------------------------------------- form_notify_me_signups
CREATE TABLE "form_notify_me_signups" (
    "id"              UUID                 NOT NULL DEFAULT gen_random_uuid(),
    "email"           VARCHAR(254)         NOT NULL,
    "role_label"      VARCHAR(60)          NOT NULL,
    "interested_in"   VARCHAR(100)         NOT NULL,
    "guardian_knows"  BOOLEAN              NOT NULL DEFAULT false,
    "status"          "FormNotifyMeStatus" NOT NULL DEFAULT 'SUBSCRIBED',
    "subscribed_at"   TIMESTAMPTZ(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unsubscribed_at" TIMESTAMPTZ(3),
    "last_notified_at" TIMESTAMPTZ(3),
    "created_at"      TIMESTAMPTZ(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMPTZ(3)       NOT NULL,
    CONSTRAINT "form_notify_me_signups_pkey" PRIMARY KEY ("id")
);

-- ------------------------------------------------------------------ indexes
CREATE INDEX "platform_notifications_recipient_id_read_at_created_at_idx"
    ON "platform_notifications"("recipient_id", "read_at", "created_at" DESC);
CREATE INDEX "ann_announcements_status_published_at_idx" ON "ann_announcements"("status", "published_at" DESC);
CREATE INDEX "ann_announcements_cohort_id_idx" ON "ann_announcements"("cohort_id");
CREATE INDEX "ann_announcements_track_id_idx" ON "ann_announcements"("track_id");
CREATE INDEX "ann_announcements_author_id_idx" ON "ann_announcements"("author_id");
CREATE INDEX "form_submissions_type_status_created_at_idx" ON "form_submissions"("type", "status", "created_at" DESC);
CREATE INDEX "form_submissions_content_hash_created_at_idx" ON "form_submissions"("content_hash", "created_at");
CREATE UNIQUE INDEX "form_notify_me_signups_email_key" ON "form_notify_me_signups"("email");
CREATE INDEX "form_notify_me_signups_status_idx" ON "form_notify_me_signups"("status");

-- ------------------------------------------------------------- foreign keys
ALTER TABLE "platform_notifications" ADD CONSTRAINT "platform_notifications_recipient_id_fkey"
    FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ann_announcements" ADD CONSTRAINT "ann_announcements_author_id_fkey"
    FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_handled_by_id_fkey"
    FOREIGN KEY ("handled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- HAND-WRITTEN: rules the database itself enforces
-- ===========================================================================

-- The same event can never notify the same person twice (when the sender gives it a key).
CREATE UNIQUE INDEX "platform_notifications_dedupe_key"
    ON "platform_notifications"("recipient_id", "dedupe_key") WHERE "dedupe_key" IS NOT NULL;

ALTER TABLE "platform_notifications" ADD CONSTRAINT "platform_notifications_basic_chk"
    CHECK ("type" ~ '^[a-z][a-z0-9_.]*$' AND jsonb_typeof("payload") = 'object');

-- An announcement: not blank, and its audience columns agree with its audience type
-- (all cohorts has neither; a track has only a track; a cohort has only a cohort).
ALTER TABLE "ann_announcements" ADD CONSTRAINT "ann_announcements_basic_chk"
    CHECK (length(btrim("title")) > 0 AND length(btrim("message")) > 0);

ALTER TABLE "ann_announcements" ADD CONSTRAINT "ann_announcements_audience_chk"
    CHECK (("audience_type" = 'ALL_COHORTS' AND "track_id" IS NULL AND "cohort_id" IS NULL)
        OR ("audience_type" = 'TRACK'       AND "track_id" IS NOT NULL AND "cohort_id" IS NULL)
        OR ("audience_type" = 'COHORT'      AND "cohort_id" IS NOT NULL AND "track_id" IS NULL));

-- Published means it has a publish time; a draft has none.
ALTER TABLE "ann_announcements" ADD CONSTRAINT "ann_announcements_published_chk"
    CHECK (("status" = 'PUBLISHED' AND "published_at" IS NOT NULL)
        OR ("status" = 'DRAFT' AND "published_at" IS NULL AND "edited_at" IS NULL));

-- Form messages and the notify-me list always store addresses in lowercase.
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_basic_chk"
    CHECK ("sender_email" = lower("sender_email") AND length(btrim("sender_name")) > 0 AND jsonb_typeof("payload") = 'object');

ALTER TABLE "form_notify_me_signups" ADD CONSTRAINT "form_notify_me_signups_basic_chk"
    CHECK ("email" = lower("email")
       AND (("status" = 'UNSUBSCRIBED') = ("unsubscribed_at" IS NOT NULL)));