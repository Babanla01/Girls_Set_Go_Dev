/**
 * email-sender.integration.spec.ts
 * ---------------------------------------------------------------------------
 * The sender that delivers the emails waiting in the outbox: claiming, sending,
 * retrying, giving up, and never sending anything twice. The outside mail
 * server is replaced by a stand-in (a spy), so no real email is ever sent.
 * Real app, PostgreSQL and Redis (the TEST ones).
 *
 * Run with:  npm run test:db
 */
import './helpers/integration-env'; // must stay first: sets the environment

import { Prisma, Role } from '@prisma/client';

import {
  EMAIL_MAX_ATTEMPTS,
  EMAIL_RETRY_DELAYS_MINUTES,
  EmailSenderService,
} from '../src/common/email/email-sender.service';
import { MailTransport } from '../src/common/email/mail.transport';
import { makeStack } from './helpers/catalog-helpers';
import { makeApplicant } from './helpers/student-helpers';
import { createTestKit, GOOD_PASSWORD, TestAgent, TestKit } from './helpers/test-kit';

const MINUTE_MS = 60 * 1000;
const LINK = 'http://localhost:3000/reset-password?token=abc123';

describe('Email sender (integration)', () => {
  let kit: TestKit;
  let sender: EmailSenderService;
  let send: jest.SpyInstance;
  let admin: TestAgent;
  let trackId: string;
  let cohortId: string;

  beforeAll(async () => {
    kit = await createTestKit();
    sender = kit.app.get(EmailSenderService);
  });

  afterAll(async () => {
    await kit.close();
  });

  beforeEach(async () => {
    await kit.reset();
    await kit.createUser({ email: 'admin@example.org', fullName: 'Pat Admin', role: Role.ADMIN });
    admin = await kit.loginAgent('admin@example.org', 'admin');
    ({ trackId, cohortId } = await makeStack(admin));

    // The outside mail server is replaced: nothing real is ever sent.
    send = jest.spyOn(kit.app.get(MailTransport), 'send').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ----------------------------------------------------------------- helpers

  const queue = (over: Partial<Prisma.EmailOutboxUncheckedCreateInput> = {}) =>
    kit.prisma.emailOutbox.create({
      data: {
        toEmail: 'ada@example.org',
        template: 'password-reset',
        payload: { fullName: 'Ada Okoye', actionUrl: LINK, expiresInMinutes: 60 },
        ...over,
      },
    });

  const row = (id: string) => kit.prisma.emailOutbox.findUniqueOrThrow({ where: { id } });

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * MINUTE_MS);

  /** Makes a waiting email due again right now. */
  const makeDue = (id: string) =>
    kit.prisma.emailOutbox.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });

  const waitFor = async (condition: () => boolean, ms = 3000) => {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > ms) throw new Error('Timed out waiting.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  // ---------------------------------------------------------------- sending

  describe('sending', () => {
    it('builds the message, hands it to the mail server and marks the email SENT', async () => {
      const email = await queue();

      const result = await sender.processBatch();

      expect(result).toEqual({ claimed: 1, sent: 1, retrying: 0, failed: 0 });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'ada@example.org', subject: 'Reset your password' }),
      );
      const message = send.mock.calls[0][0] as { text: string; html: string };
      expect(message.text).toContain(LINK);
      expect(message.html).toContain(`href="${LINK}"`);

      expect(await row(email.id)).toMatchObject({ status: 'SENT', attempts: 1, lastError: null, toEmail: 'ada@example.org' });
      expect((await row(email.id)).sentAt).toBeInstanceOf(Date);
    });

    it('wipes the stored values after sending, because they may hold a one-time link', async () => {
      const email = await queue();
      await sender.processBatch();

      expect((await row(email.id)).payload).toEqual({});
    });

    it('never sends the same email twice', async () => {
      await queue();

      await sender.processBatch();
      expect(await sender.processBatch()).toEqual({ claimed: 0, sent: 0, retrying: 0, failed: 0 });

      expect(send).toHaveBeenCalledTimes(1);
    });

    it('sends the oldest first, and only as many as asked for', async () => {
      const third = await queue({ toEmail: 'three@example.org', nextAttemptAt: minutesAgo(1) });
      const first = await queue({ toEmail: 'one@example.org', nextAttemptAt: minutesAgo(3) });
      const second = await queue({ toEmail: 'two@example.org', nextAttemptAt: minutesAgo(2) });

      expect(await sender.processBatch(2)).toMatchObject({ claimed: 2, sent: 2 });
      expect(send.mock.calls.map((call) => (call[0] as { to: string }).to)).toEqual(['one@example.org', 'two@example.org']);
      expect((await row(third.id)).status).toBe('PENDING');

      expect(await sender.processBatch(2)).toMatchObject({ claimed: 1, sent: 1 });
      expect((await row(first.id)).status).toBe('SENT');
      expect((await row(second.id)).status).toBe('SENT');
      expect((await row(third.id)).status).toBe('SENT');
    });

    it('leaves alone emails already sent, emails that failed for good, and emails not due yet', async () => {
      await queue({ status: 'SENT', sentAt: new Date(), payload: {} });
      await queue({ status: 'FAILED', lastError: 'gave up' });
      const later = await queue({ nextAttemptAt: new Date(Date.now() + 10 * MINUTE_MS) });

      expect(await sender.processBatch()).toEqual({ claimed: 0, sent: 0, retrying: 0, failed: 0 });
      expect(send).not.toHaveBeenCalled();
      expect((await row(later.id)).attempts).toBe(0);
    });

    it('builds every kind of email the system queues', async () => {
      await queue({ template: 'verify-email', payload: { fullName: 'Ada', actionUrl: LINK } });
      await queue({ template: 'application-received', payload: { fullName: 'Ada', preferredTrack: 'AI & Robotics' } });
      await queue({ template: 'application-accepted', payload: { fullName: 'Ada', actionUrl: LINK } });
      await queue({ template: 'application-declined', payload: { fullName: 'Ada' } });
      await queue({ template: 'password-reset', payload: { fullName: 'Ada', actionUrl: LINK, expiresInMinutes: 60 } });
      await queue({ template: 'instructor-invite', payload: { fullName: 'Tina', actionUrl: LINK, invitedBy: 'Pat', expiresInDays: 7 } });

      expect(await sender.processBatch()).toEqual({ claimed: 6, sent: 6, retrying: 0, failed: 0 });
      expect(await kit.prisma.emailOutbox.count({ where: { status: 'SENT' } })).toBe(6);
    });
  });

  // ------------------------------------------------------------- failures

  describe('when the mail server refuses an email', () => {
    it('tries again later, and not before', async () => {
      send.mockRejectedValueOnce(new Error('Connection refused'));
      const email = await queue();

      expect(await sender.processBatch()).toEqual({ claimed: 1, sent: 0, retrying: 1, failed: 0 });

      const waiting = await row(email.id);
      expect(waiting).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'Connection refused' });
      const wait = waiting.nextAttemptAt.getTime() - Date.now();
      expect(wait).toBeGreaterThan(30 * 1000);
      expect(wait).toBeLessThan(90 * 1000); // about a minute

      expect(await sender.processBatch()).toMatchObject({ claimed: 0 }); // not yet

      await makeDue(email.id);
      expect(await sender.processBatch()).toMatchObject({ claimed: 1, sent: 1 });
      expect(await row(email.id)).toMatchObject({ status: 'SENT', attempts: 2, lastError: null });
    });

    it('waits longer each time: 1, 5, 15 and 60 minutes', async () => {
      send.mockRejectedValue(new Error('Still down'));
      const email = await queue();

      for (let attempt = 1; attempt <= EMAIL_RETRY_DELAYS_MINUTES.length; attempt += 1) {
        await sender.processBatch();

        const waiting = await row(email.id);
        const expectedMinutes = EMAIL_RETRY_DELAYS_MINUTES[attempt - 1];
        const waitMinutes = (waiting.nextAttemptAt.getTime() - Date.now()) / MINUTE_MS;
        expect(waiting.attempts).toBe(attempt);
        expect(Math.abs(waitMinutes - expectedMinutes)).toBeLessThan(0.75);

        await makeDue(email.id);
      }
      expect(EMAIL_RETRY_DELAYS_MINUTES).toEqual([1, 5, 15, 60]);
    });

    it('gives up for good after five attempts', async () => {
      send.mockRejectedValue(new Error('Mailbox does not exist'));
      const email = await queue();

      for (let attempt = 1; attempt < EMAIL_MAX_ATTEMPTS; attempt += 1) {
        expect(await sender.processBatch()).toMatchObject({ retrying: 1 });
        await makeDue(email.id);
      }
      expect(await sender.processBatch()).toEqual({ claimed: 1, sent: 0, retrying: 0, failed: 1 });

      expect(await row(email.id)).toMatchObject({ status: 'FAILED', attempts: EMAIL_MAX_ATTEMPTS, lastError: 'Mailbox does not exist' });
      expect(send).toHaveBeenCalledTimes(EMAIL_MAX_ATTEMPTS);

      await makeDue(email.id);
      expect(await sender.processBatch()).toMatchObject({ claimed: 0 }); // never again
    });

    it('keeps a very long error message to a sensible length', async () => {
      send.mockRejectedValueOnce(new Error('x'.repeat(2000)));
      const email = await queue();

      await sender.processBatch();

      expect((await row(email.id)).lastError).toHaveLength(500);
    });

    it('does not let one bad email stop the others', async () => {
      send.mockRejectedValueOnce(new Error('Rejected'));
      const bad = await queue({ toEmail: 'bad@example.org', nextAttemptAt: minutesAgo(2) });
      const good = await queue({ toEmail: 'good@example.org', nextAttemptAt: minutesAgo(1) });

      expect(await sender.processBatch()).toEqual({ claimed: 2, sent: 1, retrying: 1, failed: 0 });
      expect((await row(bad.id)).status).toBe('PENDING');
      expect((await row(good.id)).status).toBe('SENT');
    });
  });

  describe('an email that can never be built', () => {
    it('fails at once, without trying the mail server, when its template does not exist', async () => {
      const email = await queue({ template: 'made-up-template', payload: {} });

      expect(await sender.processBatch()).toEqual({ claimed: 1, sent: 0, retrying: 0, failed: 1 });

      expect(send).not.toHaveBeenCalled();
      expect(await row(email.id)).toMatchObject({ status: 'FAILED' });
      expect((await row(email.id)).lastError).toContain('made-up-template');
    });

    it('fails at once when the link it needs is missing', async () => {
      const email = await queue({ template: 'verify-email', payload: { fullName: 'Ada' } });

      expect(await sender.processBatch()).toMatchObject({ failed: 1 });

      expect(send).not.toHaveBeenCalled();
      expect((await row(email.id)).status).toBe('FAILED');
    });
  });

  // ------------------------------------------------------ two senders at once

  describe('two senders running at the same time', () => {
    it('cannot pick up an email that another sender is in the middle of sending', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      send.mockImplementation(() => gate); // the first send hangs until we let it go
      const email = await queue();

      const first = sender.processBatch();
      await waitFor(() => send.mock.calls.length === 1);

      expect(await sender.processBatch()).toMatchObject({ claimed: 0 }); // it is "borrowed"

      release();
      expect(await first).toMatchObject({ sent: 1 });
      expect(send).toHaveBeenCalledTimes(1);
      expect((await row(email.id)).status).toBe('SENT');
    });

    it('share the work: every email is sent exactly once', async () => {
      for (let n = 1; n <= 6; n += 1) await queue({ toEmail: `girl${n}@example.org`, nextAttemptAt: minutesAgo(10 - n) });

      const [one, two] = await Promise.all([sender.processBatch(4), sender.processBatch(4)]);

      expect(one.claimed + two.claimed).toBe(6);
      expect(one.sent + two.sent).toBe(6);
      const recipients = send.mock.calls.map((call) => (call[0] as { to: string }).to);
      expect(recipients).toHaveLength(6);
      expect(new Set(recipients).size).toBe(6); // nobody received two
    });

    it('lets a crashed sender’s email be picked up again once its "borrowing" time has passed', async () => {
      const email = await queue();
      send.mockImplementationOnce(() => new Promise(() => undefined)); // this send never finishes: the sender "crashed"
      void sender.processBatch();
      await waitFor(() => send.mock.calls.length === 1);

      expect((await row(email.id)).status).toBe('PENDING'); // never recorded as sent
      expect((await row(email.id)).nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 60 * 1000); // borrowed for a while

      await makeDue(email.id); // ...time passes
      expect(await sender.processBatch()).toMatchObject({ claimed: 1, sent: 1 });
      expect((await row(email.id)).attempts).toBe(2);
    });
  });

  // ------------------------------------------------------------ end to end

  describe('with the real system', () => {
    const signup = (email: string) =>
      kit
        .agent()
        .post('/api/v1/students/register')
        .send({
          fullName: 'Ada Okoye',
          email,
          phone: '08012345678',
          dateOfBirth: '2000-05-05',
          location: 'Lagos',
          schoolName: 'Government College',
          gradeLevel: 'SS2',
          preferredTrackId: trackId,
          whyJoin: 'I love building things with code.',
          hopeToLearn: 'How robots and AI really work.',
          password: GOOD_PASSWORD,
          confirmPassword: GOOD_PASSWORD,
          acceptTerms: true,
          acceptPrivacy: true,
        });

    it('sends the two emails a new applicant is queued, with the real confirmation link', async () => {
      await signup('ada@example.org').expect(201);
      const queuedLink = (
        (await kit.prisma.emailOutbox.findFirstOrThrow({ where: { template: 'verify-email' } })).payload as { actionUrl: string }
      ).actionUrl;

      expect(await sender.processBatch()).toEqual({ claimed: 2, sent: 2, retrying: 0, failed: 0 });

      const messages = send.mock.calls.map((call) => call[0] as { to: string; subject: string; text: string });
      expect(messages.map((m) => m.subject).sort()).toEqual(['Please confirm your email address', 'We received your application']);
      expect(messages.every((m) => m.to === 'ada@example.org')).toBe(true);
      expect(messages.find((m) => m.subject.startsWith('Please confirm'))!.text).toContain(queuedLink);

      // No one-time link is left lying in the database once it has been sent.
      expect(JSON.stringify(await kit.prisma.emailOutbox.findMany())).not.toContain('token=');
    });

    it('sends a decline email that gives no reason and never mentions the private note', async () => {
      const ada = await makeApplicant(kit, trackId, { email: 'ada@example.org' });
      await admin.post(`/api/v1/admin/applications/${ada.applicationId}/decline`).send({ note: 'Outside our age range' }).expect(200);

      await sender.processBatch();

      const message = send.mock.calls
        .map((call) => call[0] as { to: string; subject: string; text: string; html: string })
        .find((m) => m.subject === 'About your application')!;
      expect(message.to).toBe('ada@example.org');
      for (const part of [message.text, message.html]) {
        expect(part).not.toContain('Outside our age range');
        expect(part).not.toContain('age range');
      }
    });

    it('sends the acceptance email with the cohort details and a sign-in link', async () => {
      const ada = await makeApplicant(kit, trackId, { email: 'ada@example.org' });
      await admin.post(`/api/v1/admin/applications/${ada.applicationId}/accept`).send({ cohortId }).expect(200);

      await sender.processBatch();

      const message = send.mock.calls
        .map((call) => call[0] as { to: string; subject: string; text: string })
        .find((m) => m.subject === 'Your application was accepted')!;
      expect(message.text).toContain('Cohort: Cohort 1');
      expect(message.text).toContain('http://localhost:3000/login');
    });
  });
});