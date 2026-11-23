import { describe, expect, it } from 'vitest';
import { runVersion } from '../../src/commands/version.js';
import { buildInfoOf, FACTORY_BUILD, FACTORY_VERSION } from '../../src/version.js';

const COMMIT = '4dcf6d41a5a63c61a02df8d6eced7c757f7b1f70';

const textOf = (output: ReturnType<typeof runVersion>): string[] => output.lines.map((line) => line.text);

describe('buildInfoOf', () => {
  it('keeps a commit of 40 lower-case hex characters and its modified flag', () => {
    expect(buildInfoOf('1.2.3', COMMIT, false)).toEqual({ version: '1.2.3', commit: COMMIT, modified: false });
    expect(buildInfoOf('1.2.3', COMMIT, true)).toEqual({ version: '1.2.3', commit: COMMIT, modified: true });
  });

  it.each([
    ['null', null],
    ['a short id', COMMIT.slice(0, 7)],
    ['upper-case hex', COMMIT.toUpperCase()],
    ['a line break at the end', `${COMMIT}\n`],
    ['a number', 42],
  ])('counts %s as no known commit, and drops the modified flag', (_name, commit) => {
    expect(buildInfoOf('1.2.3', commit, true)).toEqual({ version: '1.2.3', commit: null, modified: null });
  });

  it('gives null for a modified flag that is not true or false', () => {
    expect(buildInfoOf('1.2.3', COMMIT, 'yes')).toEqual({ version: '1.2.3', commit: COMMIT, modified: null });
  });

  it('has no commit in a test build, which reads no git', () => {
    expect(FACTORY_BUILD).toEqual({ version: FACTORY_VERSION, commit: null, modified: null });
  });
});

describe('runVersion', () => {
  it('prints the version on line 1 and the commit on line 2', () => {
    const output = runVersion({ version: '1.2.3', commit: COMMIT, modified: false });
    expect(textOf(output)).toEqual(['1.2.3', `commit ${COMMIT}`]);
    expect(output.json).toEqual({ schema: 'factory.version/v1', version: '1.2.3', commit: COMMIT, modified: false });
    expect(output.failed).toBe(false);
  });

  it('notes a build with changes that were not committed', () => {
    const output = runVersion({ version: '1.2.3', commit: COMMIT, modified: true });
    expect(textOf(output)).toEqual(['1.2.3', `commit ${COMMIT} (with changes that were not committed)`]);
    expect(output.json).toMatchObject({ commit: COMMIT, modified: true });
  });

  it('prints "commit unknown" when the build has no commit', () => {
    const output = runVersion({ version: '1.2.3', commit: null, modified: null });
    expect(textOf(output)).toEqual(['1.2.3', 'commit unknown']);
    expect(output.json).toMatchObject({ commit: null, modified: null });
  });
});

describe('runVersion with a commit and no known change state', () => {
  it('notes that the changes are not known', () => {
    const output = runVersion({ version: '1.2.3', commit: COMMIT, modified: null });
    expect(textOf(output)).toEqual(['1.2.3', `commit ${COMMIT} (changes not known)`]);
    expect(output.json).toMatchObject({ commit: COMMIT, modified: null });
  });
});
