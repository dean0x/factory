import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import type { Deps } from '../../src/core/deps.js';
import { ok } from '../../src/core/result.js';
import { deniedMatchOf, readDeniedList } from '../../src/workers/denied.js';
import { createFakeDeps, type FakeDeps, type FakeOptions } from '../helpers/fake-deps.js';

const HOME = '/factory';
const STATE = `${HOME}/.factory`;
const FILE = `${STATE}/denied.json`;
const VALID = { schema: 1, denied: ['first decoy', 'second decoy', 'Denied   Phrase', 'phrase'] };
const TEXT = JSON.stringify(VALID);
const FULL = TEXT.padEnd(65536, ' ');
const REMEDY = 'Check .factory/denied.json. Use a plain file with the required format.';

const setup = (options?: FakeOptions): FakeDeps => {
  const deps = createFakeDeps(options);
  deps.seed(FILE, TEXT);
  return deps;
};

const refused = (message: string) => ({ ok: false, error: { kind: 'safety', message, hint: REMEDY } });

describe('the denied list reader', () => {
  it('reads the entries in file order', async () => {
    expect(await readDeniedList(setup(), HOME)).toEqual(ok(VALID.denied));
  });

  it('returns no entries when the file is absent', async () => {
    const deps = setup();
    deps.files.delete(FILE);
    expect(await readDeniedList(deps, HOME)).toEqual(ok([]));
  });

  it('accepts an empty denied array', async () => {
    const deps = setup();
    deps.seed(FILE, JSON.stringify({ ...VALID, denied: [] }));
    expect(await readDeniedList(deps, HOME)).toEqual(ok([]));
  });

  it('accepts 200 entries of 300 printable signs', async () => {
    const deps = setup();
    const entries = Array.from({ length: 200 }, () => ' ~'.repeat(150));
    deps.seed(FILE, JSON.stringify({ ...VALID, denied: entries }));
    expect(await readDeniedList(deps, HOME)).toEqual(ok(entries));
  });

  it('accepts a file at the byte limit', async () => {
    const deps = setup();
    deps.seed(FILE, FULL);
    expect(await readDeniedList(deps, HOME)).toEqual(ok(VALID.denied));
  });

  it.each([FILE, STATE])('refuses a link at %s', async (path) => {
    const deps = setup({ links: { [path]: '/other' } });
    deps.seed(path === FILE ? '/other' : '/other/denied.json', TEXT);
    expect(await readDeniedList(deps, HOME)).toEqual(refused('the denied list path cannot be used'));
  });

  it('refuses a fault in the path check', async () => {
    const deps = setup();
    const fs = { ...deps.fs, lstat: async () => failure('cannot check path') };
    expect(await readDeniedList({ ...deps, fs }, HOME)).toEqual(refused('the denied list path cannot be used'));
  });

  it.each<[string, (deps: FakeDeps) => void]>([
    ['another owner', (deps) => { deps.owners.set(FILE, 2000); }],
    ['a group write bit', (deps) => { deps.modes.set(FILE, 0o620); }],
    ['bad UTF-8', (deps) => { deps.invalidUtf8.add(FILE); }],
    ['a file over the byte limit', (deps) => { deps.seed(FILE, FULL + ' '); }],
  ])('refuses %s without file data in the error', async (_case, change) => {
    const deps = setup();
    change(deps);
    expect(await readDeniedList(deps, HOME)).toEqual(refused('the denied list cannot be read'));
  });

  it('refuses a link reported by the checked open', async () => {
    const deps = setup();
    const fs = { ...deps.fs, openChecked: async () => ok({ state: 'link' } as const) };
    expect(await readDeniedList({ ...deps, fs }, HOME)).toEqual(refused('the denied list cannot be read'));
  });

  it('refuses a fault from the checked open', async () => {
    const deps = setup();
    const fs = { ...deps.fs, openChecked: async () => failure('cannot open file') };
    expect(await readDeniedList({ ...deps, fs }, HOME)).toEqual(refused('the denied list cannot be read'));
  });

  it('refuses an open file that gives no text', async () => {
    const deps = setup();
    const fs: Deps['fs'] = {
      ...deps.fs,
      openChecked: async (path, request) => {
        const found = await deps.fs.openChecked(path, request);
        return found.ok && found.value.state === 'opened' ? ok({ ...found.value, text: null }) : found;
      },
    };
    expect(await readDeniedList({ ...deps, fs }, HOME)).toEqual(refused('the denied list cannot be read'));
  });

  it('refuses invalid JSON without file data in the error', async () => {
    const deps = setup();
    deps.seed(FILE, TEXT.slice(0, -1));
    expect(await readDeniedList(deps, HOME)).toEqual(refused('the denied list is not valid JSON'));
  });

  it.each([
    ['an unknown key', { ...VALID, extra: 'extra value' }],
    ['an unknown schema version', { ...VALID, schema: 2 }],
    ['a denied value that is not an array', { ...VALID, denied: 'Denied Phrase' }],
    ['201 entries', { ...VALID, denied: Array.from({ length: 201 }, () => 'x') }],
    ['an entry of 301 signs', { ...VALID, denied: ['x'.repeat(301)] }],
    ['an empty entry', { ...VALID, denied: [''] }],
    ['a non-string entry', { ...VALID, denied: [3] }],
    ['a non-ASCII entry', { ...VALID, denied: ['déjà vu'] }],
    ['a control sign at the end of an entry', { ...VALID, denied: ['Denied Phrase\n'] }],
  ])('refuses %s without file data in the error', async (_case, data) => {
    const deps = setup();
    deps.seed(FILE, JSON.stringify(data));
    expect(await readDeniedList(deps, HOME)).toEqual(refused('the denied list does not have the required format'));
  });
});

describe('the denied match', () => {
  const TITLE = 'Title of the request';
  const QUESTION = 'What is the answer?';
  const OPTION = 'Choose this answer';
  const MATCH = 'A DENIED\t \nphrase in the text';

  it.each<[string, readonly [string, string, string]]>([
    ['title', [MATCH, QUESTION, OPTION]],
    ['question', [TITLE, MATCH, OPTION]],
    ['chosen option text', [TITLE, QUESTION, MATCH]],
  ])('returns the first matching entry number after case and space fold in the %s', (_field, texts) => {
    expect(deniedMatchOf(VALID.denied, texts)).toBe(3);
  });

  it('returns no entry when a match would need parts from two texts', () => {
    const entries = ['first decoy', 'second decoy', 'denied phrase'];
    expect(deniedMatchOf(entries, ['Case: denied', 'Phrase to check', OPTION])).toBeNull();
  });
});
