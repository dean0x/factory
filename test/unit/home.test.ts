import { describe, expect, it } from 'vitest';
import { locateHome, locateHomeFolder, resolveHome } from '../../src/core/home.js';
import { createFakeDeps, type FakeDeps } from '../helpers/fake-deps.js';

const HOME = '/w/node';

const nodeAt = (cwd: string, env: Record<string, string | undefined> = {}): FakeDeps => {
  const deps = createFakeDeps({ cwd, env });
  deps.seed(`${HOME}/factory.yaml`, 'schema: 2\n');
  deps.seedDir(cwd);
  return deps;
};

const located = async (deps: FakeDeps, homeFlag?: string) => {
  const result = await locateHome(deps, homeFlag);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe('home: the order', () => {
  it('takes the home flag first, also when the environment and the current folder name a home', async () => {
    const deps = nodeAt(HOME, { FACTORY_HOME: '/other' });
    expect(await located(deps, '/flag')).toEqual({ home: '/flag', source: 'flag' });
  });

  it('takes FACTORY_HOME second, before the folders above the current folder', async () => {
    const deps = nodeAt(`${HOME}/deep`, { FACTORY_HOME: '/elsewhere' });
    expect(await located(deps)).toEqual({ home: '/elsewhere', source: 'env' });
  });

  it('resolves a relative FACTORY_HOME against the current folder', async () => {
    const deps = nodeAt('/w', { FACTORY_HOME: 'node' });
    expect(await located(deps)).toEqual({ home: HOME, source: 'env' });
  });

  it('counts a FACTORY_HOME that is the current folder as the current folder', async () => {
    const deps = nodeAt(HOME, { FACTORY_HOME: HOME });
    expect(await located(deps)).toEqual({ home: HOME, source: 'cwd' });
  });

  it('ignores an empty FACTORY_HOME and walks up from the current folder', async () => {
    const deps = nodeAt(`${HOME}/deep`, { FACTORY_HOME: '' });
    expect(await located(deps)).toEqual({ home: HOME, source: 'ancestor' });
  });

  it('finds the home in the current folder when the environment names none', async () => {
    expect(await located(nodeAt(HOME))).toEqual({ home: HOME, source: 'cwd' });
  });

  it('fails with a hint when no source names a home', async () => {
    const result = await locateHome(createFakeDeps({ cwd: '/empty' }), undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('no factory.yaml found');
      expect(result.error.hint).toContain('--home DIR');
    }
  });

  it('gives the same home to resolveHome', async () => {
    const deps = nodeAt('/w', { FACTORY_HOME: HOME });
    expect(await resolveHome(deps, undefined)).toEqual({ ok: true, value: HOME });
  });
});

describe('home: a folder', () => {
  it('gives the located home when it is a folder', async () => {
    const result = await locateHomeFolder(nodeAt(HOME), undefined);
    expect(result).toEqual({ ok: true, value: { home: HOME, source: 'cwd' } });
  });

  it('fails for a home that is a file or does not exist', async () => {
    const deps = nodeAt(HOME);
    deps.seed('/w/file', 'x');
    expect(await locateHomeFolder(deps, '/w/file')).toMatchObject({ ok: false, error: { message: '/w/file is not a folder' } });
    expect(await locateHomeFolder(deps, '/w/none')).toMatchObject({ ok: false, error: { message: '/w/none is not a folder' } });
  });

  it('passes on the failure of locateHome', async () => {
    const result = await locateHomeFolder(createFakeDeps({ cwd: '/empty' }), undefined);
    expect(result.ok).toBe(false);
  });
});
