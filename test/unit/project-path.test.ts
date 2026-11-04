import { describe, expect, it } from 'vitest';
import { describeProjectPathIssue, projectFolderKey, projectPathIssue } from '../../src/core/project-path.js';
import { dirs, files, reservedRootNames } from '../../src/names.js';

describe('the project path rule (design 4.3, TP-28)', () => {
  it('accepts one folder name', () => {
    for (const name of ['web', 'web-app', 'web_app', 'web.app', 'Web2', 'a', 'odd;', 'we b']) {
      expect({ name, issue: projectPathIssue(name) }).toEqual({ name, issue: null });
    }
  });

  it.each(['', 'a/b', '/abs', '../web', './web', 'web/', 'a\\b', '..\\web', 'we\u0000b', 'we\u001bb', 'we\nb', 'we\u007fb'])(
    'refuses %j as a path that is not one folder name',
    (name) => {
      expect(projectPathIssue(name)).toBe('not-one-name');
    },
  );

  it.each(['.', '..', '.git', '.factory', '.gitignore', '.claude', '.factory.tmp-77', '.hidden'])(
    'refuses %s, which starts with a dot',
    (name) => {
      expect(projectPathIssue(name)).toBe('leading-dot');
    },
  );

  it('keeps the names of the root for itself: the folders, the config files and the instruction files', () => {
    expect(reservedRootNames).toEqual(
      expect.arrayContaining([dirs.coordinator, dirs.workCopies, dirs.setup, files.config, files.localConfig, files.claudeMd]),
    );
    for (const name of reservedRootNames) expect({ name, issue: projectPathIssue(name) }).toEqual({ name, issue: 'reserved' });
  });

  it('keeps the reserved names in any letter case', () => {
    for (const name of reservedRootNames) {
      for (const changed of [name.toUpperCase(), name.toLowerCase(), `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`]) {
        expect({ changed, issue: projectPathIssue(changed) }).toEqual({ changed, issue: 'reserved' });
      }
    }
  });

  it('keeps a reserved name when a compatible form of a letter stands in for the letter', () => {
    // U+017F (long s) and U+FF43 (full-width c) fold to s and c.
    expect(projectPathIssue('ſetup')).toBe('reserved');
    expect(projectPathIssue('ｃoordinator')).toBe('reserved');
    expect(projectPathIssue('WORK-COPIES')).toBe('reserved');
  });

  it('accepts a name that only looks like a reserved name', () => {
    for (const name of ['coordinator2', 'my-setup', 'setup.d', 'work-copies-old', 'CLAUDE', 'AGENTS', 'factory', 'factory.yaml.bak']) {
      expect({ name, issue: projectPathIssue(name) }).toEqual({ name, issue: null });
    }
  });

  it('gives a reason for each kind of refusal, with no name in it', () => {
    expect(describeProjectPathIssue('not-one-name')).toContain('one folder name');
    expect(describeProjectPathIssue('leading-dot')).toContain('dot');
    expect(describeProjectPathIssue('reserved')).toContain('keeps for itself');
  });

  it('gives one key to two spellings of one folder', () => {
    expect(projectFolderKey('Web')).toBe(projectFolderKey('web'));
    expect(projectFolderKey('ſetup')).toBe(projectFolderKey('setup'));
    expect(projectFolderKey('web')).not.toBe(projectFolderKey('api'));
  });
});
