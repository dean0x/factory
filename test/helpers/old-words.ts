/** The words of FAC-M1 that v2 replaced: lane, pack and brief, also as a verb or in a plural. */
export const OLD_WORDS = /\b(?:lane|pack|brief)(?:s|ed)?\b/i;

export const oldWordsIn = (text: string): string[] => text.match(new RegExp(OLD_WORDS, 'gi')) ?? [];
