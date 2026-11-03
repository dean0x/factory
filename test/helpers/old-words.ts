/**
 * The eight words that D-59 replaced. The scan of the source, the help text, the templates, the glossary and the files
 * that init writes uses this list. `scripts/exit-check.sh` holds the same list and the same endings, and
 * `OLD_WORD_LIST` of `test/helpers/plain-words.ts` holds the same list for the scan of the docs. A unit test keeps the
 * three equal.
 */
export const OLD_WORD_LIST = ['lane', 'pack', 'brief', 'cell', 'andon', 'staging', 'inspect', 'ship'] as const;

/** The endings that keep the old word: a plural, a past form and an -ing form (shipped, shipping, packed, briefing). */
export const OLD_WORD_ENDINGS = ['s', 'es', 'ed', 'ing', 'ped', 'ping'] as const;

/** An old word as a whole word, in any case. A longer word such as package or relationship is not an old word. */
export const OLD_WORDS = new RegExp(`\\b(?:${OLD_WORD_LIST.join('|')})(?:${OLD_WORD_ENDINGS.join('|')})?\\b`, 'i');

export const oldWordsIn = (text: string): string[] => text.match(new RegExp(OLD_WORDS, 'gi')) ?? [];
