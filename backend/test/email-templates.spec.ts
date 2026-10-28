/**
 * email-templates.spec.ts - the words of every email the system sends.
 *
 * Proves each template builds a proper subject, plain-text and HTML version;
 * that nothing a person typed can become markup; that only ordinary web links
 * are used; that the decline email never gives a reason; and that a template
 * that cannot be built is reported (null) instead of being sent broken.
 */
import { VERIFY_LINK_TTL_MS } from '../src/auth/auth.constants';
import { KNOWN_EMAIL_TEMPLATES, renderEmail } from '../src/common/email/email.templates';

const LINK = 'https://learn.example.org/verify-email?token=abc123';

describe('renderEmail', () => {
  it('knows every template the system queues', () => {
    expect([...KNOWN_EMAIL_TEMPLATES].sort()).toEqual([
      'application-accepted',
      'application-declined',
      'application-received',
      'instructor-invite',
      'password-reset',
      'verify-email',
    ]);
  });

  describe('verify-email', () => {
    it('has a subject, the link in both versions, and says how long the link lasts', () => {
      const email = renderEmail('verify-email', { fullName: 'Ada Okoye', actionUrl: LINK });

      expect(email).not.toBeNull();
      expect(email!.subject).toBe('Please confirm your email address');
      expect(email!.text).toContain('Hello Ada Okoye,');
      expect(email!.text).toContain(LINK);
      expect(email!.html).toContain(`href="${LINK}"`);
      expect(email!.text).toMatch(/expires in \d+ (hours|days)/);
    });

    it('states the real lifetime of the link', () => {
      const hours = VERIFY_LINK_TTL_MS / (60 * 60 * 1000);
      const expected = hours >= 48 && hours % 24 === 0 ? `${hours / 24} days` : `${hours} hours`;

      expect(renderEmail('verify-email', { actionUrl: LINK })!.text).toContain(`expires in ${expected}`);
    });

    it('cannot be built without a link', () => {
      expect(renderEmail('verify-email', { fullName: 'Ada' })).toBeNull();
      expect(renderEmail('verify-email', { fullName: 'Ada', actionUrl: '' })).toBeNull();
    });
  });

  describe('application-received', () => {
    it('names the track when there is one', () => {
      const email = renderEmail('application-received', { fullName: 'Ada Okoye', preferredTrack: 'AI & Robotics' });

      expect(email!.subject).toBe('We received your application');
      expect(email!.text).toContain('AI & Robotics track');
      expect(email!.html).toContain('AI &amp; Robotics track'); // escaped in the HTML version
    });

    it('works without a track name', () => {
      const email = renderEmail('application-received', { fullName: 'Ada Okoye' });
      expect(email!.text).toContain('We have received your application.');
    });
  });

  describe('application-accepted', () => {
    const payload = {
      fullName: 'Ada Okoye',
      trackName: 'AI & Robotics',
      courseTitle: 'Intro to AI',
      cohortName: 'Cohort 1',
      startsOn: '2026-11-01',
      endsOn: '2027-01-30',
      actionUrl: 'https://learn.example.org/login',
    };

    it('congratulates her, lists the track, course, cohort and dates, and links to sign in', () => {
      const email = renderEmail('application-accepted', payload);

      expect(email!.subject).toBe('Your application was accepted');
      expect(email!.text).toContain('Track: AI & Robotics');
      expect(email!.text).toContain('Course: Intro to AI');
      expect(email!.text).toContain('Cohort: Cohort 1');
      expect(email!.text).toContain('Runs from 2026-11-01 to 2027-01-30');
      expect(email!.text).toContain('https://learn.example.org/login');
    });

    it('cannot be built without a sign-in link', () => {
      expect(renderEmail('application-accepted', { ...payload, actionUrl: undefined })).toBeNull();
    });
  });

  describe('application-declined', () => {
    it('is polite and gives no reason', () => {
      const email = renderEmail('application-declined', { fullName: 'Ada Okoye' });

      expect(email!.subject).toBe('About your application');
      expect(email!.text).toContain('unable to offer you a place at this time');
    });

    it('can never include the private admin note, even if one is handed to it', () => {
      const email = renderEmail('application-declined', { fullName: 'Ada Okoye', decisionNote: 'Outside our age range', note: 'secret' });

      for (const part of [email!.subject, email!.text, email!.html]) {
        expect(part).not.toContain('Outside our age range');
        expect(part).not.toContain('secret');
      }
    });

    it('needs no link', () => {
      expect(renderEmail('application-declined', { fullName: 'Ada' })).not.toBeNull();
    });
  });

  describe('password-reset', () => {
    it('gives the link and how long it lasts', () => {
      const email = renderEmail('password-reset', { fullName: 'Ada', actionUrl: LINK, expiresInMinutes: 60 });

      expect(email!.subject).toBe('Reset your password');
      expect(email!.text).toContain(LINK);
      expect(email!.text).toContain('expires in 60 minutes');
      expect(email!.text).toContain('you can ignore this email');
    });

    it('says "1 minute", not "1 minutes"', () => {
      const email = renderEmail('password-reset', { actionUrl: LINK, expiresInMinutes: 1 });
      expect(email!.text).toContain('expires in 1 minute.');
    });

    it('cannot be built without a link', () => {
      expect(renderEmail('password-reset', { fullName: 'Ada', expiresInMinutes: 60 })).toBeNull();
    });
  });

  describe('instructor-invite', () => {
    it('names who invited her and how long the link lasts', () => {
      const email = renderEmail('instructor-invite', {
        fullName: 'Tina Teacher',
        actionUrl: 'https://learn.example.org/set-password?token=xyz',
        invitedBy: 'Pat Admin',
        expiresInDays: 7,
      });

      expect(email!.subject).toBe('You have been invited to teach at Girls Set Go');
      expect(email!.text).toContain('Pat Admin has invited you');
      expect(email!.text).toContain('expires in 7 days');
    });

    it('says "1 day", not "1 days"', () => {
      const email = renderEmail('instructor-invite', { actionUrl: LINK, expiresInDays: 1 });
      expect(email!.text).toContain('expires in 1 day.');
    });

    it('cannot be built without a link', () => {
      expect(renderEmail('instructor-invite', { fullName: 'Tina', invitedBy: 'Pat' })).toBeNull();
    });
  });

  describe('safety', () => {
    it('never turns something a person typed into markup', () => {
      const email = renderEmail('application-received', {
        fullName: '<script>alert(1)</script> & "Ada" <b>',
        preferredTrack: '<img src=x onerror=alert(1)>',
      });

      expect(email!.html).not.toContain('<script>');
      expect(email!.html).not.toContain('<img');
      expect(email!.html).not.toContain('<b>');
      expect(email!.html).toContain('&lt;script&gt;');
      expect(email!.html).toContain('&quot;Ada&quot;');
      expect(email!.text).toContain('<script>alert(1)</script>'); // plain text keeps the raw words
    });

    it('escapes a link as well', () => {
      const email = renderEmail('verify-email', { actionUrl: 'https://example.org/a?x=1&y="2"' });
      expect(email!.html).toContain('href="https://example.org/a?x=1&amp;y=&quot;2&quot;"');
    });

    it.each(['javascript:alert(1)', 'data:text/html,hello', 'ftp://example.org/file', '//example.org', 'example.org/login', 'https://exa mple.org'])(
      'refuses the link "%s"',
      (actionUrl) => {
        expect(renderEmail('verify-email', { actionUrl })).toBeNull();
        expect(renderEmail('password-reset', { actionUrl })).toBeNull();
      },
    );

    it('accepts both http and https links', () => {
      expect(renderEmail('verify-email', { actionUrl: 'http://localhost:3000/verify-email?token=a' })).not.toBeNull();
      expect(renderEmail('verify-email', { actionUrl: 'https://learn.example.org/verify-email?token=a' })).not.toBeNull();
    });
  });

  describe('things that are not templates', () => {
    it.each(['', 'nope', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'VERIFY-EMAIL'])(
      'returns null for "%s"',
      (template) => {
        expect(renderEmail(template, { actionUrl: LINK })).toBeNull();
      },
    );

    it.each([null, undefined, 'text', 42, ['a']])('copes with the odd values %p', (payload) => {
      expect(renderEmail('application-declined', payload)!.text).toContain('Hello,');
      expect(renderEmail('verify-email', payload)).toBeNull();
    });
  });

  it('every message has a subject, a text part, an HTML part and a sign-off', () => {
    const samples: Array<[string, Record<string, unknown>]> = [
      ['verify-email', { actionUrl: LINK }],
      ['application-received', {}],
      ['application-accepted', { actionUrl: LINK }],
      ['application-declined', {}],
      ['password-reset', { actionUrl: LINK }],
      ['instructor-invite', { actionUrl: LINK }],
    ];

    for (const [template, payload] of samples) {
      const email = renderEmail(template, payload);
      expect(email).not.toBeNull();
      expect(email!.subject.length).toBeGreaterThan(5);
      expect(email!.text).toContain('The Girls Set Go team');
      expect(email!.html).toContain('<!doctype html>');
      expect(email!.html).toContain('The Girls Set Go team');
    }
  });
});