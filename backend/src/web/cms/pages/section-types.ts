/**
 * section-types.ts
 * ---------------------------------------------------------------------------
 * The catalog of building blocks ("sections") an admin can put on a page. Each
 * type says:
 *   - which fields it has and how much each may hold   (schema)
 *   - what it needs before the page can be PUBLISHED    (required)
 *   - which fields hold light-formatted text            (rich)
 *   - which fields hold a picture from the media library (images)
 *
 * The website has one designed component per type, so every page always looks
 * on-brand. Adding a new type later is one new entry here (plus one component
 * on the website). Facts that live elsewhere are NOT typed into pages:
 *   - "people" reads the published People profiles
 *   - "applications_panel" and "contact_info" read the site settings
 *   - "video_row" and "showcase_grid" are filled by their own modules later
 */
import { z } from 'zod';

import { buttons, href, imageRef, link, need, rich, text } from './section-fields';

export interface SectionTypeDefinition {
  label: string;
  description: string;
  /** What an editor may type (checked on every save; empty is fine for a draft). */
  schema: z.ZodType<Record<string, unknown>>;
  /** What is still missing before publishing (plain-English sentences). */
  required: (fields: Record<string, unknown>) => string[];
  /** Fields holding light-formatted text. "[]" = every item of a list. */
  rich: string[];
  /** Fields holding a picture id. */
  images: string[];
}

function defineSection<S extends z.ZodType>(definition: {
  label: string;
  description: string;
  schema: S;
  required: (fields: z.output<S>) => string[];
  rich?: string[];
  images?: string[];
}): SectionTypeDefinition {
  return { rich: [], images: [], ...definition } as unknown as SectionTypeDefinition;
}

const nonEmpty = (items: string[]) => items.filter((item) => item.trim() !== '');

export const SECTION_TYPES = {
  hero: defineSection({
    label: 'Hero',
    description: 'The big opening block of a page: small label, heading, short text, a picture and up to three buttons.',
    schema: z.strictObject({ eyebrow: text(80), heading: text(160), text: rich(600), image: imageRef, buttons: buttons() }),
    required: (f) => need(f.heading, 'Heading'),
    rich: ['text'],
    images: ['image'],
  }),

  text_image: defineSection({
    label: 'Text and picture',
    description: 'A heading and some text beside a picture (either side), with optional buttons.',
    schema: z.strictObject({
      heading: text(160),
      body: rich(3000),
      image: imageRef,
      imagePosition: z.enum(['LEFT', 'RIGHT']).default('RIGHT'),
      buttons: buttons(),
    }),
    required: (f) => (f.heading.trim() === '' && f.body.trim() === '' ? ['Add a heading or some text.'] : []),
    rich: ['body'],
    images: ['image'],
  }),

  rich_text: defineSection({
    label: 'Text',
    description: 'A heading and one or more paragraphs or lists. Good for "Why it matters" and other plain writing.',
    schema: z.strictObject({ heading: text(160), body: rich(5000) }),
    required: (f) => need(f.body, 'Text'),
    rich: ['body'],
  }),

  key_facts: defineSection({
    label: 'Key facts row',
    description: 'A row of short verified facts, for example "Free", "8 weeks", "2 tracks". Only write facts that are true.',
    schema: z.strictObject({
      items: z.array(z.strictObject({ value: text(30), label: text(60), note: text(120) })).max(8, 'At most 8 facts.').default([]),
    }),
    required: (f) =>
      f.items.length === 0
        ? ['Add at least one fact.']
        : f.items.some((item) => item.value.trim() === '' || item.label.trim() === '')
          ? ['Every fact needs a value and a label.']
          : [],
  }),

  card_grid: defineSection({
    label: 'Cards',
    description:
      'A heading and a grid of cards. Used for program cards, "four supports", values and pillars. Choose a style; each card has a title, text, optional picture and link.',
    schema: z.strictObject({
      variant: z.enum(['PLAIN', 'PROGRAM', 'SUPPORT', 'VALUE', 'PILLAR']).default('PLAIN'),
      heading: text(160),
      intro: rich(600),
      columns: z.number().int().min(1).max(4).default(3),
      cards: z
        .array(z.strictObject({ eyebrow: text(60), title: text(100), body: rich(600), image: imageRef, link }))
        .max(12, 'At most 12 cards.')
        .default([]),
    }),
    required: (f) =>
      f.cards.length === 0 ? ['Add at least one card.'] : f.cards.some((card) => card.title.trim() === '') ? ['Every card needs a title.'] : [],
    rich: ['intro', 'cards[].body'],
    images: ['cards[].image'],
  }),

  mission_vision: defineSection({
    label: 'Mission and vision',
    description: 'A heading with two text cards: the mission and the vision.',
    schema: z.strictObject({
      heading: text(160),
      mission: z.strictObject({ title: text(80), body: rich(800) }).default({ title: 'Our mission', body: '' }),
      vision: z.strictObject({ title: text(80), body: rich(800) }).default({ title: 'Our vision', body: '' }),
    }),
    required: (f) => [...need(f.mission.body, 'The mission text'), ...need(f.vision.body, 'The vision text')],
    rich: ['mission.body', 'vision.body'],
  }),

  people: defineSection({
    label: 'Our people',
    description: 'Cards of team members or instructors. They are read from the People profiles (only published ones), never typed here.',
    schema: z.strictObject({
      heading: text(160),
      intro: rich(400),
      kind: z.enum(['TEAM', 'INSTRUCTOR']).default('TEAM'),
      placement: z.enum(['about', 'cohort']).default('about'),
    }),
    required: (f) => need(f.heading, 'Heading'),
    rich: ['intro'],
  }),

  cta_band: defineSection({
    label: 'Call-to-action band',
    description: 'A closing band with a heading, a line of text and up to three buttons ("Apply", "Get involved", "Donate").',
    schema: z.strictObject({ heading: text(160), text: rich(400), buttons: buttons() }),
    required: (f) => need(f.heading, 'Heading'),
    rich: ['text'],
  }),

  steps: defineSection({
    label: 'Steps',
    description: 'Numbered steps, for example "From application to showcase".',
    schema: z.strictObject({
      heading: text(160),
      intro: rich(400),
      steps: z.array(z.strictObject({ title: text(100), body: rich(400) })).max(10, 'At most 10 steps.').default([]),
    }),
    required: (f) =>
      f.steps.length === 0 ? ['Add at least one step.'] : f.steps.some((step) => step.title.trim() === '') ? ['Every step needs a title.'] : [],
    rich: ['intro', 'steps[].body'],
  }),

  faq: defineSection({
    label: 'Questions and answers',
    description: 'A list of questions with their answers.',
    schema: z.strictObject({
      heading: text(160),
      items: z.array(z.strictObject({ question: text(200), answer: rich(1500) })).max(40, 'At most 40 questions.').default([]),
    }),
    required: (f) =>
      f.items.length === 0
        ? ['Add at least one question.']
        : f.items.some((item) => item.question.trim() === '' || item.answer.trim() === '')
          ? ['Every question needs an answer.']
          : [],
    rich: ['items[].answer'],
  }),

  curriculum_weeks: defineSection({
    label: 'Curriculum weeks',
    description: 'For each track: its weeks, each with a title and the class project.',
    schema: z.strictObject({
      heading: text(160),
      intro: rich(600),
      tracks: z
        .array(
          z.strictObject({
            name: text(80),
            summary: rich(400),
            weeks: z
              .array(z.strictObject({ week: z.number().int().min(1).max(52).default(1), title: text(120), project: text(120) }))
              .max(16, 'At most 16 weeks per track.')
              .default([]),
          }),
        )
        .max(4, 'At most 4 tracks.')
        .default([]),
    }),
    required: (f) => {
      if (f.tracks.length === 0) return ['Add at least one track.'];
      const problems: string[] = [];
      for (const track of f.tracks) {
        if (track.name.trim() === '') problems.push('Every track needs a name.');
        if (track.weeks.length === 0) problems.push(`Track "${track.name || 'unnamed'}" needs at least one week.`);
        if (track.weeks.some((week) => week.title.trim() === '')) problems.push(`Every week of "${track.name || 'unnamed'}" needs a title.`);
      }
      return problems;
    },
    rich: ['intro', 'tracks[].summary'],
  }),

  checklist: defineSection({
    label: 'Checklist',
    description: 'A short list of ticked points, for example "Who it is for".',
    schema: z.strictObject({ heading: text(160), intro: rich(300), items: z.array(text(200)).max(12, 'At most 12 points.').default([]) }),
    required: (f) => (nonEmpty(f.items).length === 0 ? ['Add at least one point.'] : []),
    rich: ['intro'],
  }),

  applications_panel: defineSection({
    label: 'Applications panel',
    description:
      'The status box of the bootcamp page. The website setting "Applications are open" decides which version visitors see (open: apply buttons; closed: the notice and the notify-me form).',
    schema: z.strictObject({
      openHeading: text(160),
      openText: rich(500),
      openButtons: buttons(),
      closedHeading: text(160),
      closedText: rich(500),
      showNotifyMeForm: z.boolean().default(true),
    }),
    required: (f) => [...need(f.openHeading, 'The "applications open" heading'), ...need(f.closedHeading, 'The "applications closed" heading')],
    rich: ['openText', 'closedText'],
  }),

  form_embed: defineSection({
    label: 'Form',
    description: 'Shows one of the website forms: contact, volunteer, partner or notify-me.',
    schema: z.strictObject({
      form: z.enum(['CONTACT', 'VOLUNTEER', 'PARTNER', 'NOTIFY_ME']).default('CONTACT'),
      heading: text(160),
      intro: rich(400),
    }),
    required: () => [],
    rich: ['intro'],
  }),

  video_row: defineSection({
    label: 'Video row',
    description: 'A row of video cards (for example "From the Creative Studio"). Filled from the Videos library.',
    schema: z.strictObject({
      heading: text(160),
      source: z.enum(['FEATURED', 'CATEGORY']).default('FEATURED'),
      category: text(40),
      count: z.number().int().min(1).max(6).default(3),
      seeAllHref: href,
    }),
    required: (f) => need(f.heading, 'Heading'),
  }),

  showcase_grid: defineSection({
    label: 'Showcase grid',
    description: 'Learner projects shared with consent, with filters by track. Filled from the showcase library.',
    schema: z.strictObject({ heading: text(160), intro: rich(400), showFilters: z.boolean().default(true) }),
    required: (f) => need(f.heading, 'Heading'),
    rich: ['intro'],
  }),

  portal_band: defineSection({
    label: 'Learning portal band',
    description: '"Already part of Girls Set Go?" band with log-in and apply buttons.',
    schema: z.strictObject({ heading: text(160), text: rich(400), buttons: buttons() }),
    required: (f) => need(f.heading, 'Heading'),
    rich: ['text'],
  }),

  contact_info: defineSection({
    label: 'Contact details',
    description: 'Shows the contact email, phone and address from the website settings (the address only once it is confirmed).',
    schema: z.strictObject({ heading: text(160), intro: rich(400) }),
    required: (f) => need(f.heading, 'Heading'),
    rich: ['intro'],
  }),
} satisfies Record<string, SectionTypeDefinition>;

export type SectionTypeKey = keyof typeof SECTION_TYPES;
export const SECTION_TYPE_KEYS = Object.keys(SECTION_TYPES) as [SectionTypeKey, ...SectionTypeKey[]];