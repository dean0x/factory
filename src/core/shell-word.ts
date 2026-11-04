/** One word of a command line that a person types: a plain word as it is, any other word in single quotes. */
export const shellWord = (word: string): string =>
  /^[A-Za-z0-9_@%+=:,./{}-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
