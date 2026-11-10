/**
 * The rules for the text of a board write. A title, a text, a question and the text of an option are one line each.
 */

/**
 * A control character, a separator of lines or of paragraphs, or a mark of text direction (U+202A to U+202E and U+2066 to U+2069):
 * a line break, a tab and the other characters that a line of text can not hold. A mark of direction lets stored text show in
 * another order in another reader. The other format characters stay valid: U+200D joins the parts of an emoji.
 */
const BREAK = /[\p{Cc}\p{Zl}\p{Zp}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u;

/** True when the text holds a line break, a control character or a mark of text direction. */
export const holdsBreak = (text: string): boolean => BREAK.test(text);

/**
 * Why a text can not be one line of at most `max` characters, as a phrase for a message ("the title ..."), or null when it can. The
 * count is the count of the text without the space at its ends, which a write removes. The phrase never repeats the text.
 */
export const lineIssue = (text: string, max: number): string | null => {
  const line = text.trim();
  if (line === '') return 'is empty';
  if (holdsBreak(line)) return 'is not one line: it holds a line break, a control character or a mark of text direction';
  return line.length > max ? `is longer than ${max} characters` : null;
};
