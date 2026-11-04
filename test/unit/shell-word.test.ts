import { describe, expect, it } from 'vitest';
import { shellWord } from '../../src/core/shell-word.js';

describe('shellWord', () => {
  it.each([['/w/node/web'], ['worker/alpha'], ['a_b-c.d'], ['%7'], ['a=b:c+d@e']])('keeps the plain word %s as it is', (word) => {
    expect(shellWord(word)).toBe(word);
  });

  it.each([['/x/{a,b}'], ['a{b'], ['a}b'], ['a,b']])('quotes %s, so that bash and zsh do not expand it', (word) => {
    expect(shellWord(word)).toBe(`'${word}'`);
  });

  it('quotes a word with a space or a quote, and closes the quote around a quote', () => {
    expect(shellWord('a b')).toBe("'a b'");
    expect(shellWord("it's")).toBe("'it'\\''s'");
  });
});
