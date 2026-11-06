import { describe, expect, it } from 'vitest';
import { isTmuxNewEnough, onPath, parseTmuxVersion, tmuxVersionOf, toolNames } from '../../src/core/tools.js';
import { createFakeDeps, exited } from '../helpers/fake-deps.js';

describe('the programs that factory starts', () => {
  it('TP-20: names git, tmux, gh, claude and ps, each by its program name', () => {
    expect(toolNames).toEqual({ git: 'git', tmux: 'tmux', gh: 'gh', claude: 'claude', ps: 'ps' });
  });
});

describe('tmux version', () => {
  it.each([
    ['tmux 3.4', { major: 3, minor: 4 }],
    ['tmux 3.5a\n', { major: 3, minor: 5 }],
    ['tmux next-3.7', { major: 3, minor: 7 }],
    ['tmux 2.9a', { major: 2, minor: 9 }],
    ['tmux 10.0', { major: 10, minor: 0 }],
  ])('reads %j', (text, version) => {
    expect(parseTmuxVersion(text)).toEqual(version);
  });

  it.each([[''], ['tmux master'], ['3.4'], ['screen 4.09.01'], ['tmux openbsd-7.4']])('gives null for %j', (text) => {
    expect(parseTmuxVersion(text)).toBeNull();
  });

  it('accepts 3.0 and newer only', () => {
    expect(isTmuxNewEnough({ major: 3, minor: 0 })).toBe(true);
    expect(isTmuxNewEnough({ major: 3, minor: 6 })).toBe(true);
    expect(isTmuxNewEnough({ major: 4, minor: 0 })).toBe(true);
    expect(isTmuxNewEnough({ major: 2, minor: 99 })).toBe(false);
  });

  it('reads the version from the program, and gives null when it fails', async () => {
    const good = createFakeDeps({ run: () => exited(0, 'tmux 3.4\n') });
    expect(await tmuxVersionOf(good)).toEqual({ major: 3, minor: 4 });
    const failed = createFakeDeps({ run: () => exited(1, '', 'error') });
    expect(await tmuxVersionOf(failed)).toBeNull();
    expect(await tmuxVersionOf(createFakeDeps())).toBeNull();
  });
});

describe('program on PATH', () => {
  it('finds a file in a folder of PATH, and not a folder or a missing name', async () => {
    const deps = createFakeDeps({ env: { PATH: '/nowhere:/bin' } });
    deps.seed('/bin/tmux', '');
    deps.seedDir('/bin/folder');
    expect(await onPath(deps, 'tmux')).toBe(true);
    expect(await onPath(deps, 'folder')).toBe(false);
    expect(await onPath(deps, 'claude')).toBe(false);
  });
});
