import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderConfig } from '../../src/config/render.js';
import { oldWordsIn } from '../helpers/old-words.js';
import { parseConfigTexts } from '../helpers/package-registry.js';
import { jargonIn } from '../helpers/plain-words.js';
import { sampleBoard, sampleConfig } from '../helpers/sample-config.js';

/**
 * The sample setup in `examples/`: a `factory.yaml` with a `board` block. It must load through the real config schema, so a
 * change of the schema that the sample breaks shows in this test.
 */

const ROOT = join(__dirname, '..', '..');

const readExample = (name: string): string => readFileSync(join(ROOT, 'examples', name), 'utf8');

/** The local file of the sample config. The sample setup is a shared file, so a load needs a local file next to it. */
const LOCAL_TEXT = renderConfig(sampleConfig()).local;

describe('the sample setup in examples/ (M5-1b TP-50)', () => {
  it('M5-1b TP-50 loads through the real config schema', () => {
    const loaded = parseConfigTexts(readExample('factory.board.yaml'), LOCAL_TEXT);
    expect(loaded.ok, loaded.ok ? '' : loaded.error.message).toBe(true);
  });

  it('M5-1b TP-50 holds the sample board block: states, a worker field and owner fields', () => {
    const loaded = parseConfigTexts(readExample('factory.board.yaml'), LOCAL_TEXT);
    expect(loaded.ok && loaded.value.core.board).toEqual(sampleBoard());
  });

  it('M5-1b TP-50 declares a release field with the target row', () => {
    const loaded = parseConfigTexts(readExample('factory.board.yaml'), LOCAL_TEXT);
    const fields = loaded.ok ? (loaded.value.core.board?.fields ?? []) : [];
    expect(fields.find((field) => field.name === 'release')).toMatchObject({ target: 'row', kind: 'flag' });
  });
});

describe('the README of the sample setup (M5-1b TP-50)', () => {
  it('M5-1b TP-50 is short, names the sample file, and holds no old word and no jargon word', () => {
    const text = readExample('README.md');
    expect(text.split('\n').length).toBeLessThanOrEqual(40);
    expect(text).toContain('factory.board.yaml');
    expect(oldWordsIn(text)).toEqual([]);
    expect(jargonIn(text)).toEqual([]);
  });
});

describe('the package files (M5-1b TP-50)', () => {
  it('M5-1b TP-50 ships the examples folder, so that the sample setup that the messages name is in an installed package', () => {
    const manifest: unknown = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({ files: expect.arrayContaining(['examples']) });
  });
});
