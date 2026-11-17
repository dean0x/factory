import { guardStorePathOf, requireGuardChannel } from '../../src/core/guard-records.js';
import { describe, expect, it } from 'vitest';
import { userStatePathOf } from '../../src/core/private-file.js';
import { commandLines, env, files, guardRecordWords } from '../../src/names.js';
import { createFakeDeps } from '../helpers/fake-deps.js';

const root = '/work/node';
const userHome = '/users/test';
const stateHome = '/state';

describe('the guard record channel', () => {
  it.each([commandLines.guardSet, commandLines.guardConfirm])('checks the channel in order for %s', (command) => {
    const cases = [
      [{ [env.session]: 'node', [env.claudeCode]: '1' }, false, false, guardRecordWords.sessionRefused],
      [{ [env.claudeCode]: '1' }, false, false, guardRecordWords.claudeRefused],
      [{}, false, false, guardRecordWords.inputRequired],
      [{}, true, false, guardRecordWords.outputRequired],
    ] as const;
    for (const [environment, stdinIsTTY, stdoutIsTTY, message] of cases) {
      const deps = createFakeDeps({ env: environment, stdinIsTTY, stdoutIsTTY });
      const result = requireGuardChannel(deps, command);
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(JSON.stringify(result)).toContain(message);
      expect(JSON.stringify(result)).toContain(guardRecordWords.channelRemedy);
      expect(deps.files.size).toBe(0);
    }
  });

  it('accepts terminal input and output outside both session types', () => {
    expect(requireGuardChannel(createFakeDeps({ env: { [env.session]: '', [env.claudeCode]: '' }, stdinIsTTY: true, stdoutIsTTY: true }), commandLines.guardSet))
      .toEqual({ ok: true, value: undefined });
  });
});

describe('the pure guard store place', () => {
  it.each([
    [{ [env.userHome]: userHome, [env.stateHome]: stateHome }, '/state/factory/' + files.guardRecords],
    [{ [env.userHome]: userHome, [env.stateHome]: 'relative' }, '/users/test/.local/state/factory/' + files.guardRecords],
    [{ [env.stateHome]: stateHome }, '/state/factory/' + files.guardRecords],
    [{ [env.userHome]: 'relative' }, null],
    [{}, null],
  ])('finds the place without file access for %j', (environment, path) => {
    const deps = createFakeDeps({ env: environment });
    const noFs = { ...deps, fs: new Proxy(deps.fs, { get: () => { throw new Error('place must not read files'); } }) };
    expect(guardStorePathOf(noFs, root)).toEqual({ path, inside: false });
  });

  it.each([
    [root, 'linux'],
    [`${userHome}/.claude/state`, 'linux'],
    ['/WORK/NODE', 'darwin'],
    ['/USERS/TEST/.CLAUDE/state', 'darwin'],
  ])('marks a store inside a protected folder at %s', (state, os) => {
    const deps = createFakeDeps({ env: { [env.userHome]: userHome, [env.stateHome]: state }, os });
    expect(guardStorePathOf(deps, root)).toMatchObject({ inside: true });
  });

  it('does not treat a sibling with the same prefix as inside', () => {
    const deps = createFakeDeps({ env: { [env.userHome]: userHome, [env.stateHome]: '/work/node-other' } });
    expect(guardStorePathOf(deps, root)).toMatchObject({ inside: false });
  });

  it('keeps the existing user-state caller refusal and default path', async () => {
    expect(await userStatePathOf(createFakeDeps({ env: { [env.userHome]: userHome } }), files.guardRecords))
      .toEqual({ ok: true, value: `${userHome}/.local/state/factory/${files.guardRecords}` });
    expect(await userStatePathOf(createFakeDeps({ env: { [env.userHome]: userHome, [env.stateHome]: `${userHome}/.claude` } }), files.guardRecords))
      .toMatchObject({ ok: false, error: { kind: 'safety' } });
  });
});
