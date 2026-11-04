import { softwareWordList } from '../../src/recipes/software/words.js';

const EDGE_BEFORE = '(?<![A-Za-z0-9_])';
const EDGE_AFTER = '(?![A-Za-z0-9_])';

/** An abbreviation counts only in capital letters. The other words count in any case. */
const isAbbreviation = (word: string): boolean => /^[A-Z]+$/.test(word);

/** A word with its plural, its past form and its -ing form. Only the last word of a phrase takes an ending. */
const formsOf = (word: string): string => {
  const parts = word.toLowerCase().split(' ');
  const last = parts.pop() ?? '';
  const ending = last.endsWith('e') ? `${last.slice(0, -1)}(?:e[sd]?|ing)` : `${last}(?:s|ed|ing)?`;
  return [...parts, ending].join('\\s+');
};

const PHRASES = new RegExp(
  `${EDGE_BEFORE}(?:${softwareWordList.filter((word) => !isAbbreviation(word)).map(formsOf).join('|')})${EDGE_AFTER}`,
  'gi',
);
const ABBREVIATIONS = new RegExp(
  `${EDGE_BEFORE}(?:${softwareWordList.filter(isAbbreviation).map((word) => `${word}s?`).join('|')})${EDGE_AFTER}`,
  'g',
);

/** The words of the software list that a text holds. */
export const softwareWordsIn = (text: string): string[] => [...(text.match(PHRASES) ?? []), ...(text.match(ABBREVIATIONS) ?? [])];
