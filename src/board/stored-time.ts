/** The length of an exact time in UTC, as `toISOString` writes it for a year of four digits: `2030-01-02T10:11:12.345Z`. */
const STORED_TIME_CHARS = 24;

/**
 * The text of a stored time, or null. A stored time is an exact `toISOString` time in UTC: the text has 24 characters, it parses to
 * a real time, and the time written back is the same text. A value of any other type or form is null, so that a hand edit or a
 * value of an older version never reaches a reader as a time. The function never throws.
 */
export const storedTimeOf = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length !== STORED_TIME_CHARS) return null;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === value ? value : null;
};
