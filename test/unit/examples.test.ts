import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderConfig } from '../../src/config/render.js';
import { oldWordsIn } from '../helpers/old-words.js';
import { parseConfigTexts } from '../helpers/package-registry.js';
import { jargonIn } from '../helpers/plain-words.js';
import { sampleConfig } from '../helpers/sample-config.js';

/**
 * The sample setup in `examples/`: a `factory.yaml` with a `board` block. It must load through the real config schema, so a
 * change of the schema that the sample breaks shows in this test.
 */

const ROOT = join(__dirname, '..', '..');

const readExample = (name: string): string => readFileSync(join(ROOT, 'examples', name), 'utf8');

/** The local file of the sample config. The sample setup is a shared file, so a load needs a local file next to it. */
const LOCAL_TEXT = renderConfig(sampleConfig()).local;

describe('the sample setup in examples/', () => {
  it('loads through the real config schema', () => {
    const loaded = parseConfigTexts(readExample('factory.board.yaml'), LOCAL_TEXT);
    expect(loaded.ok, loaded.ok ? '' : loaded.error.message).toBe(true);
  });

  it('names a worker field that the sample declares with the target item', () => {
    const loaded = parseConfigTexts(readExample('factory.board.yaml'), LOCAL_TEXT);
    const board = loaded.ok ? loaded.value.core.board : undefined;
    const workerField = board?.worker_field;
    expect(workerField).toBeDefined();
    expect(board?.fields?.find((field) => field.name === workerField)).toMatchObject({ target: 'item' });
  });

  it('declares a release field with the target row', () => {
    const loaded = parseConfigTexts(readExample('factory.board.yaml'), LOCAL_TEXT);
    const fields = loaded.ok ? (loaded.value.core.board?.fields ?? []) : [];
    expect(fields.find((field) => field.name === 'release')).toMatchObject({ target: 'row', kind: 'flag' });
  });
});

describe('the README of the sample setup', () => {
  it('is short, names the sample file, and holds no old word and no jargon word', () => {
    const text = readExample('README.md');
    expect(text.split('\n').length).toBeLessThanOrEqual(40);
    expect(text).toContain('factory.board.yaml');
    expect(oldWordsIn(text)).toEqual([]);
    expect(jargonIn(text)).toEqual([]);
  });
});

describe('the package files', () => {
  it('ships the examples folder, so that the sample setup that the messages name is in an installed package', () => {
    const manifest: unknown = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({ files: expect.arrayContaining(['examples']) });
  });
});
