/**
 * age.ts
 * ---------------------------------------------------------------------------
 * Works out an age in whole years from a date of birth, as of a given day.
 * Both are plain calendar dates ("YYYY-MM-DD"), so there is no timezone
 * confusion: the birthday counts on the day itself.
 */
export function ageOnDate(dateOfBirth: string, today: string): number {
  const [birthYear, birthMonth, birthDay] = dateOfBirth.split('-').map(Number);
  const [year, month, day] = today.split('-').map(Number);

  let age = year - birthYear;
  const hadBirthdayThisYear = month > birthMonth || (month === birthMonth && day >= birthDay);
  if (!hadBirthdayThisYear) age -= 1;
  return age;
}