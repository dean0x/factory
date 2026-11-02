import { glossary } from '../glossary.js';
import { commandText, helpTopics, schemaIds } from '../names.js';
import type { CommandOutput } from './output.js';

/** The output of `factory help words`: the heading, then one line for each term with its plain description. */
export const wordsOutput = (): CommandOutput => ({
  lines: [
    { level: 'heading', text: commandText(helpTopics.words) },
    ...glossary.map((word) => ({ level: 'text' as const, text: `${word.term}: ${word.text}` })),
  ],
  json: { schema: schemaIds.words, words: glossary },
  warnings: [],
  failed: false,
});
