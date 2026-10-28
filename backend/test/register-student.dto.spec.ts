/**
 * register-student.dto.spec.ts - the signup form's field rules.
 *
 * These checks use the same strict settings as the real app (unknown fields
 * are rejected). Rules that need several fields together (under-18 guardian,
 * matching passwords, password strength) live in the service and are covered
 * by the integration tests, not here.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { RegisterStudentDto } from '../src/students/dto/register-student.dto';

const TRACK_ID = '11111111-1111-4111-8111-111111111111';

const validPayload = () => ({
  fullName: 'Ada Okoye',
  email: 'ada.okoye@example.org',
  phone: '08012345678',
  dateOfBirth: '2008-10-24',
  location: 'Lagos',
  schoolName: 'Government College',
  gradeLevel: 'SS2',
  preferredTrackId: TRACK_ID,
  whyJoin: 'I love building things with code.',
  hopeToLearn: 'How robots and AI really work.',
  password: 'Sunny-Garden-42!',
  confirmPassword: 'Sunny-Garden-42!',
  acceptTerms: true,
  acceptPrivacy: true,
});

const check = async (overrides: Record<string, unknown> = {}) => {
  const instance = plainToInstance(RegisterStudentDto, { ...validPayload(), ...overrides });
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  return { instance, errors, failed: errors.map((e) => e.property) };
};

const without = async (field: string) => {
  const payload: Record<string, unknown> = validPayload();
  delete payload[field];
  const instance = plainToInstance(RegisterStudentDto, payload);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((e) => e.property);
};

describe('RegisterStudentDto', () => {
  it('accepts a complete, valid signup', async () => {
    expect((await check()).errors).toHaveLength(0);
  });

  describe('required fields', () => {
    it.each([
      'fullName',
      'email',
      'phone',
      'dateOfBirth',
      'location',
      'schoolName',
      'gradeLevel',
      'preferredTrackId',
      'whyJoin',
      'hopeToLearn',
      'password',
      'confirmPassword',
      'acceptTerms',
      'acceptPrivacy',
    ])('rejects a signup with no %s', async (field) => {
      expect(await without(field)).toContain(field);
    });
  });

  describe('name, school and place', () => {
    it('squashes repeated spaces and trims a full name', async () => {
      const { instance, errors } = await check({ fullName: '  Ada    Okoye  ' });
      expect(errors).toHaveLength(0);
      expect(instance.fullName).toBe('Ada Okoye');
    });

    it('rejects a one-letter name', async () => {
      expect((await check({ fullName: 'A' })).failed).toContain('fullName');
    });

    it('rejects a name longer than 120 characters', async () => {
      expect((await check({ fullName: 'A'.repeat(121) })).failed).toContain('fullName');
    });

    it('accepts a grade level of one character and rejects an empty one', async () => {
      expect((await check({ gradeLevel: '5' })).errors).toHaveLength(0);
      expect((await check({ gradeLevel: '   ' })).failed).toContain('gradeLevel');
    });
  });

  describe('email', () => {
    it('lowercases and trims the email', async () => {
      const { instance, errors } = await check({ email: '  ADA.Okoye@Example.ORG ' });
      expect(errors).toHaveLength(0);
      expect(instance.email).toBe('ada.okoye@example.org');
    });

    it('rejects something that is not an email', async () => {
      const { failed } = await check({ email: 'not-an-email' });
      expect(failed).toContain('email');
    });

    it('rejects an email longer than 254 characters', async () => {
      const { failed } = await check({ email: `${'a'.repeat(250)}@example.org` });
      expect(failed).toContain('email');
    });
  });

  describe('phone number', () => {
    it.each(['08012345678', '+234 801 234 5678', '0801 (234) 5678', '0801-234-5678'])('accepts %s', async (phone) => {
      expect((await check({ phone })).errors).toHaveLength(0);
    });

    it.each(['12', 'abcdefghij', '+', '0801-CALL-NOW', ''])('rejects "%s"', async (phone) => {
      expect((await check({ phone })).failed).toContain('phone');
    });
  });

  describe('date of birth', () => {
    it('accepts a real YYYY-MM-DD date', async () => {
      expect((await check({ dateOfBirth: '2008-02-29' })).errors).toHaveLength(0);
    });

    it.each(['2009-02-29', '2008-02-30', '2008-13-01', '24/10/2008', '2008-10-24T00:00:00Z', 'yesterday', ''])(
      'rejects "%s"',
      async (dateOfBirth) => {
        expect((await check({ dateOfBirth })).failed).toContain('dateOfBirth');
      },
    );

    it('rejects a date of birth that is not text', async () => {
      expect((await check({ dateOfBirth: 20081024 })).failed).toContain('dateOfBirth');
    });
  });

  describe('preferred track', () => {
    it('rejects an id that is not a UUID', async () => {
      expect((await check({ preferredTrackId: 'ai-robotics' })).failed).toContain('preferredTrackId');
    });
  });

  describe('application questions', () => {
    it('needs at least 10 characters for "why join"', async () => {
      expect((await check({ whyJoin: 'too short' })).failed).toContain('whyJoin'); // 9 characters
      expect((await check({ whyJoin: 'long enough' })).errors).toHaveLength(0);
    });

    it('needs at least 10 characters for "hope to learn"', async () => {
      expect((await check({ hopeToLearn: 'too short' })).failed).toContain('hopeToLearn');
    });

    it('rejects an answer longer than 2000 characters', async () => {
      expect((await check({ whyJoin: 'x'.repeat(2001) })).failed).toContain('whyJoin');
      expect((await check({ whyJoin: 'x'.repeat(2000) })).errors).toHaveLength(0);
    });

    it('treats STEM experience as optional', async () => {
      expect((await check({ stemExperience: undefined })).errors).toHaveLength(0);
      expect((await check({ stemExperience: '   ' })).errors).toHaveLength(0);
    });

    it('rejects STEM experience longer than 2000 characters', async () => {
      expect((await check({ stemExperience: 'x'.repeat(2001) })).failed).toContain('stemExperience');
    });
  });

  describe('guardian details (shape only)', () => {
    it('accepts complete, well-formed guardian details', async () => {
      const { errors } = await check({
        guardianName: 'Mrs Okoye',
        guardianEmail: 'MRS.OKOYE@example.org',
        guardianPhone: '08098765432',
        guardianConsent: true,
      });
      expect(errors).toHaveLength(0);
    });

    it('lowercases the guardian email', async () => {
      const { instance } = await check({ guardianEmail: ' MRS.OKOYE@Example.ORG ' });
      expect(instance.guardianEmail).toBe('mrs.okoye@example.org');
    });

    it('rejects a malformed guardian email', async () => {
      expect((await check({ guardianEmail: 'mum-at-home' })).failed).toContain('guardianEmail');
    });

    it('rejects a malformed guardian phone number', async () => {
      expect((await check({ guardianPhone: 'call me' })).failed).toContain('guardianPhone');
    });

    it('rejects a one-letter guardian name', async () => {
      expect((await check({ guardianName: 'M' })).failed).toContain('guardianName');
    });

    it('rejects a guardianConsent that is not true or false', async () => {
      expect((await check({ guardianConsent: 'yes' })).failed).toContain('guardianConsent');
    });
  });

  describe('password fields', () => {
    it('rejects an empty password', async () => {
      expect((await check({ password: '' })).failed).toContain('password');
    });

    it('allows a 128-character password and rejects 129', async () => {
      expect((await check({ password: 'a'.repeat(128), confirmPassword: 'a'.repeat(128) })).errors).toHaveLength(0);
      expect((await check({ password: 'a'.repeat(129) })).failed).toContain('password');
      expect((await check({ confirmPassword: 'a'.repeat(129) })).failed).toContain('confirmPassword');
    });

    it('rejects a password that is not text', async () => {
      expect((await check({ password: 12345678 })).failed).toContain('password');
    });
  });

  describe('consent', () => {
    it('rejects signup unless the terms are accepted, with a clear message', async () => {
      const { errors } = await check({ acceptTerms: false });
      const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
      expect(messages).toContain('You must accept the terms to apply.');
    });

    it('rejects signup unless the privacy notice is accepted, with a clear message', async () => {
      const { errors } = await check({ acceptPrivacy: false });
      const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
      expect(messages).toContain('You must accept the privacy notice to apply.');
    });

    it('does not treat the text "true" as acceptance', async () => {
      expect((await check({ acceptTerms: 'true' })).failed).toContain('acceptTerms');
    });
  });

  describe('bot trap', () => {
    it('lets the hidden field through validation (the service decides what to do with it)', async () => {
      expect((await check({ website: 'http://spam.example' })).errors).toHaveLength(0);
    });

    it('rejects an enormous value in the hidden field', async () => {
      expect((await check({ website: 'x'.repeat(201) })).failed).toContain('website');
    });
  });

  describe('fields a visitor must never be able to set', () => {
    it.each(['role', 'status', 'emailVerifiedAt', 'id', 'isAdmin'])('rejects an extra "%s" field', async (field) => {
      const { failed } = await check({ [field]: 'ADMIN' });
      expect(failed).toContain(field);
    });
  });
});