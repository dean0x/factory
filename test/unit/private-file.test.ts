import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import { preparePrivateFolder, readPrivateFile, readPrivateText } from '../../src/core/private-file.js';
import { createFakeDeps, type FakeDeps } from '../helpers/fake-deps.js';

const FOLDER = '/s/factory';
const FILE = `${FOLDER}/x.json`;

const withFile = (): FakeDeps => {
  const deps = createFakeDeps();
  deps.seed(FILE, 'text\n');
  return deps;
};

describe('private file: the typed reason of a refusal', () => {
  it('reads the text with the time of the last change, and gives null for a file that is not there', async () => {
    const deps = withFile();
    deps.mtimes.set(FILE, 1_234);
    expect(await readPrivateFile(deps, FILE, 100)).toEqual({ ok: true, value: { text: 'text\n', mtimeMs: 1_234 } });
    expect(await readPrivateFile(deps, `${FOLDER}/none`, 100)).toEqual({ ok: true, value: null });
  });

  it.each([
    ['a folder of another user', (deps: FakeDeps) => deps.owners.set(FOLDER, 0), 'other-user'],
    ['a file of another user', (deps: FakeDeps) => deps.owners.set(FILE, 0), 'other-user'],
    ['a folder that a group can write', (deps: FakeDeps) => deps.modes.set(FOLDER, 0o770), 'writable'],
    ['a file that others can write', (deps: FakeDeps) => deps.modes.set(FILE, 0o602), 'writable'],
  ])('gives the reason of the refusal for %s, and the text version gives the message', async (_name, damage, reason) => {
    const deps = withFile();
    damage(deps);
    const read = await readPrivateFile(deps, FILE, 100);
    expect(read).toMatchObject({ ok: false, error: { reason } });
    const text = await readPrivateText(deps, FILE, 100);
    expect(text).toMatchObject({ ok: false, error: read.ok ? '' : read.error.message });
  });

  it('gives the io reason for a file over the limit and for a folder in place of the file', async () => {
    const deps = withFile();
    deps.seedDir(`${FOLDER}/dir`);
    expect(await readPrivateFile(deps, FILE, 3)).toMatchObject({ ok: false, error: { reason: 'io' } });
    expect(await readPrivateFile(deps, `${FOLDER}/dir`, 100)).toMatchObject({ ok: false, error: { reason: 'io' } });
  });

  it('makes the folder with mode 0700, and refuses a folder that another user owns or a group can write', async () => {
    const deps = createFakeDeps();
    expect(await preparePrivateFolder(deps, FILE)).toEqual({ ok: true, value: undefined });
    expect(deps.modes.get(FOLDER)).toBe(0o700);
    deps.owners.set(FOLDER, 0);
    expect(await preparePrivateFolder(deps, FILE)).toMatchObject({ ok: false, error: { reason: 'other-user' } });
    deps.owners.delete(FOLDER);
    deps.modes.set(FOLDER, 0o720);
    expect(await preparePrivateFolder(deps, FILE)).toMatchObject({ ok: false, error: { reason: 'writable' } });
  });

  it('gives the io reason for a folder that cannot be made, whatever the words of the message', async () => {
    const deps = createFakeDeps();
    const blocked: FakeDeps = { ...deps, fs: { ...deps.fs, mkdir: async () => failure('belongs to another user and can be written by a group') } };
    expect(await preparePrivateFolder(blocked, FILE)).toMatchObject({ ok: false, error: { reason: 'io' } });
  });
});
