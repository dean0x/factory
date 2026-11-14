import { describe, expect, it } from 'vitest';
import {
  agentVersionOf,
  isAgentNewEnough,
  isTmuxNewEnough,
  onPath,
  parseAgentVersion,
  parseTmuxVersion,
  tmuxVersionOf,
  toolNames,
} from '../../src/core/tools.js';
import { createFakeDeps, exited } from '../helpers/fake-deps.js';

describe('the programs that factory starts', () => {
  it('names git, tmux, gh, claude and ps, each by its program name', () => {
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

describe('agent version', () => {
  it.each([
    ['2.1.224', { major: 2, minor: 1, patch: 224 }],
    ['2.1.224 (Claude Code)', { major: 2, minor: 1, patch: 224 }],
    ['2.1.224 (Claude Code)\n', { major: 2, minor: 1, patch: 224 }],
    ['  2.2.0\n', { major: 2, minor: 2, patch: 0 }],
    ['10.20.3000', { major: 10, minor: 20, patch: 3000 }],
  ])('reads %j', (text, version) => {
    expect(parseAgentVersion(text)).toEqual(version);
  });

  it.each([
    [''],
    ['claude'],
    ['2.1'],
    ['v2.1.224'],
    ['2.1.224.1'],
    ['2.1.x'],
    ['2.1.224-beta'],
    ['Claude Code 2.1.224'],
    ['2.1.224 (Claude Code) and more'],
    ['2.1.224 (Claude\nCode)'],
    ['2.1.224\nsecond line'],
    ['2.1.224 (Claude Code'],
    [`2.1.224${' '.repeat(300)}text`],
    [`2.1.224 (${'x'.repeat(300)})`],
    [`2.1.224${' '.repeat(300)}`],
  ])('gives null for %j', (text) => {
    expect(parseAgentVersion(text)).toBeNull();
  });

  it('accepts 2.1.224 and newer only', () => {
    expect(isAgentNewEnough({ major: 2, minor: 1, patch: 224 })).toBe(true);
    expect(isAgentNewEnough({ major: 2, minor: 1, patch: 225 })).toBe(true);
    expect(isAgentNewEnough({ major: 2, minor: 2, patch: 0 })).toBe(true);
    expect(isAgentNewEnough({ major: 3, minor: 0, patch: 0 })).toBe(true);
    expect(isAgentNewEnough({ major: 2, minor: 1, patch: 223 })).toBe(false);
    expect(isAgentNewEnough({ major: 2, minor: 0, patch: 999 })).toBe(false);
    expect(isAgentNewEnough({ major: 1, minor: 99, patch: 999 })).toBe(false);
  });

  it('runs the program of the caller with --version and a time limit, and reads its version', async () => {
    const deps = createFakeDeps({ run: () => exited(0, '2.1.224 (Claude Code)\n') });
    expect(await agentVersionOf(deps, 'my-agent')).toEqual({ major: 2, minor: 1, patch: 224 });
    expect(deps.calls).toMatchObject([{ command: 'my-agent', args: ['--version'], timeoutMs: 5000 }]);
  });

  it('gives null when the program fails, prints no version or does not run', async () => {
    expect(await agentVersionOf(createFakeDeps({ run: () => exited(1, '2.1.224', 'error') }), 'claude')).toBeNull();
    expect(await agentVersionOf(createFakeDeps({ run: () => exited(0, 'unknown') }), 'claude')).toBeNull();
    expect(await agentVersionOf(createFakeDeps({ run: () => exited(0, '') }), 'claude')).toBeNull();
    expect(await agentVersionOf(createFakeDeps(), 'claude')).toBeNull();
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
