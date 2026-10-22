/**
 * calendar-date.decorator.ts
 * ---------------------------------------------------------------------------
 * @IsCalendarDate() - the field must be a REAL calendar date written as
 * YYYY-MM-DD, such as "2026-11-03". It rejects impossible dates ("2026-02-30"),
 * dates with a time attached, and other formats.
 */
import { registerDecorator, ValidationOptions } from 'class-validator';

import { isCalendarDate } from '../../catalog/catalog.util';

export function IsCalendarDate(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isCalendarDate',
      target: target.constructor,
      propertyName: propertyName as string,
      options: {
        message: `${String(propertyName)} must be a real date written as YYYY-MM-DD`,
        ...options,
      },
      validator: {
        validate: (value: unknown) => typeof value === 'string' && isCalendarDate(value),
      },
    });
  };
}