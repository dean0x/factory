/**
 * The rules for the text of a board write. A title, a text, a question and the text of an option are one line each.
 */

/** A control character, or a separator of lines or of paragraphs: a line break, a tab and the other characters that a line of text can not hold. */
const BREAK = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** True when the text holds a line break or another control character. */
export const holdsBreak = (text: string): boolean => BREAK.test(text);

/**
 * Why a text can not be one line of at most `max` characters, as a phrase for a message ("the title ..."), or null when it can. The
 * count is the count of the text without the space at its ends, which a write removes. The phrase never repeats the text.
 */
export const lineIssue = (text: string, max: number): string | null => {
  const line = text.trim();
  if (line === '') return 'is empty';
  if (holdsBreak(line)) return 'is not one line: it holds a line break or a control character';
  return line.length > max ? `is longer than ${max} characters` : null;
};
