/**
 * normalized-email.decorator.ts
 * ---------------------------------------------------------------------------
 * One decorator that says "this field must be a valid email, and clean it
 * first": trim spaces, lowercase, and cap the length. Use it on every DTO
 * (the shape of incoming data) that carries an email address.
 */
import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

export function NormalizedEmail(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value)),
    IsEmail({}, { message: 'Please enter a valid email address.' }),
    MaxLength(254),
  );
}