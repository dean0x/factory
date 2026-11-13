import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeIssues } from '../../src/core/zod.js';
import { maxFileBytes } from '../../src/names.js';
import {
  ignoresLine,
  INBOX_GITIGNORE_LINE,
  initialBoardText,
  initialDecisionLogText,
  initialWaitingText,
  jsonText,
  locateShareList,
  SHARE_LIST_BEGIN,
  SHARE_LIST_END,
  SHARE_LIST_PART,
  sharedRootPaths,
  withShareList,
} from '../../src/state/files.js';
import { layoutOf, stagingDirOf } from '../../src/state/layout.js';
import { inspectState, loadState, parseJsonText } from '../../src/state/load.js';
import { nodeStateSchema, STATE_SCHEMA_VERSION } from '../../src/state/schema.js';
import { createFakeDeps } from '../helpers/fake-deps.js';
import { FAKE_GITHUB_TOKEN } from '../helpers/fake-secret.js';

const valid = { schema_version: STATE_SCHEMA_VERSION, created_with: '0.1.0', blocks: { coordinator: 1, safety: 1, worker: 1 } };

const issues = (value: unknown): string | null => {
  const parsed = nodeStateSchema.safeParse(value);
  return parsed.success ? null : describeIssues(parsed.error);
};

describe('state schema', () => {
  it('accepts a valid node.json', () => {
    expect(issues(valid)).toBeNull();
  });

  it('is strict', () => {
    expect(issues({ ...valid, owner: 'x' })).toContain('owner: unknown key');
  });

  it('rejects a bad version, a missing key and a bad block entry', () => {
    expect(issues({ ...valid, schema_version: STATE_SCHEMA_VERSION + 1 })).toContain('schema_version:');
    expect(issues({ schema_version: STATE_SCHEMA_VERSION, blocks: {} })).toContain('created_with:');
    expect(issues({ ...valid, blocks: { 'Bad Name': 1 } })).toContain('blocks.Bad Name');
    expect(issues({ ...valid, blocks: { coordinator: 0 } })).toContain('blocks.coordinator:');
    expect(issues({ ...valid, blocks: { coordinator: 1.5 } })).toContain('blocks.coordinator:');
  });
});

describe('inspectState and loadState', () => {
  const HOME = '/node';
  const withState = (text: string | null) => {
    const deps = createFakeDeps();
    deps.seedDir(`${HOME}/.factory`);
    if (text !== null) deps.seed(`${HOME}/.factory/node.json`, text);
    return deps;
  };

  it('loads a valid file', async () => {
    const loaded = await loadState(withState(jsonText(valid)), HOME);
    expect(loaded).toEqual({ ok: true, value: valid });
  });

  it('reports a missing file with its label', async () => {
    expect(await inspectState(withState(null), HOME)).toEqual({ kind: 'missing' });
    expect(await loadState(withState(null), HOME)).toMatchObject({
      ok: false,
      error: { message: '.factory/node.json not found' },
    });
  });

  it('reports text that is not JSON without repeating it', async () => {
    const state = await inspectState(withState('{ secret-value'), HOME);
    expect(state).toEqual({ kind: 'unparsable', message: 'the text is not valid JSON' });
  });

  it('reports a newer schema_version', async () => {
    const newer = STATE_SCHEMA_VERSION + 1;
    const state = await inspectState(withState(jsonText({ ...valid, schema_version: newer })), HOME);
    expect(state).toMatchObject({ kind: 'newer', version: newer });
  });

  it('reports the schema_version of a FAC-M1 node as older and says to run upgrade', async () => {
    const text = jsonText({ schema_version: 1, created_with: '0.1.0', blocks: { coordinator: 1, safety: 1, protocol: 1 } });
    const state = await inspectState(withState(text), HOME);
    expect(state).toMatchObject({ kind: 'older', version: 1 });
    expect(await loadState(withState(text), HOME)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('Run "factory upgrade".') },
    });
  });

  it('reports an invalid document', async () => {
    const state = await inspectState(withState(jsonText({ ...valid, extra: true })), HOME);
    expect(state).toMatchObject({ kind: 'invalid' });
  });

  it('hides a key that looks like a token in the error', async () => {
    const state = await inspectState(withState(jsonText({ ...valid, [FAKE_GITHUB_TOKEN]: true })), HOME);
    expect(state).toMatchObject({ kind: 'invalid', message: '<key>: unknown key' });
    const blocks = await inspectState(
      withState(jsonText({ ...valid, blocks: { ...valid.blocks, [FAKE_GITHUB_TOKEN]: 1 } })),
      HOME,
    );
    expect(blocks.kind).toBe('invalid');
    if (blocks.kind === 'invalid') expect(blocks.message).not.toContain(FAKE_GITHUB_TOKEN);
  });
});

describe('parseJsonText and initial files', () => {
  it('parses JSON', () => {
    expect(parseJsonText('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonText('{').ok).toBe(false);
  });

  it('writes the initial files with the shapes of the plan', () => {
    expect(JSON.parse(initialBoardText('queue'))).toEqual({ queue: [], items: [], tracks: [] });
    expect(JSON.parse(initialWaitingText())).toEqual({ intro: '', groups: [], items: [] });
    expect(JSON.parse(initialDecisionLogText())).toEqual({ rows: [] });
    expect(initialBoardText('queue').endsWith('\n')).toBe(true);
  });

  it('M5-1b TP-29 writes the queue key that the caller gives, then the items and the tracks', () => {
    expect(initialBoardText('line')).toBe('{\n  "line": [],\n  "items": [],\n  "tracks": []\n}\n');
  });

  it('M5-1b TP-70 seeds the tracks as an empty list', () => {
    expect(JSON.parse(initialBoardText('line'))).toHaveProperty('tracks', []);
  });
});

describe('layout', () => {
  it('builds every path from the home', () => {
    const layout = layoutOf('/h/node');
    expect(layout).toEqual({
      home: '/h/node',
      configFile: '/h/node/factory.yaml',
      localConfigFile: '/h/node/factory.local.yaml',
      gitignoreFile: '/h/node/.gitignore',
      coordinatorDir: '/h/node/coordinator',
      claudeMd: '/h/node/coordinator/CLAUDE.md',
      setupDir: '/h/node/setup',
      setupCoordinatorFile: '/h/node/setup/coordinator.md',
      setupRolesDir: '/h/node/setup/roles',
      setupWorkerFile: '/h/node/setup/roles/worker.md',
      workCopiesDir: '/h/node/work-copies',
      stateDir: '/h/node/.factory',
      nodeJson: '/h/node/.factory/node.json',
      stateGitignoreFile: '/h/node/.factory/.gitignore',
      workerMd: '/h/node/.factory/roles/worker.md',
      backupsDir: '/h/node/.factory/backups',
      workersDir: '/h/node/.factory/workers',
      inboxDir: '/h/node/.factory/inbox',
      outboxDir: '/h/node/.factory/outbox',
      reportFile: '/h/node/.factory/outbox/report.json',
      runtimeDir: '/h/node/.factory/state',
      heartbeatDir: '/h/node/.factory/state/heartbeat',
      coordinatorLastSessionFile: '/h/node/.factory/state/coordinator-last-session',
      machineIdFile: '/h/node/.factory/state/machine-id',
      activeMachineFile: '/h/node/.factory/active-machine.json',
      locksDir: '/h/node/.factory/locks',
    });
  });

  it('puts the staging folder next to the state folder, named by the pid', () => {
    expect(stagingDirOf('/h/node', 77)).toBe('/h/node/.factory.tmp-77');
  });

  it('holds no instruction file at the top of the root: CLAUDE.md is in the coordinator folder', () => {
    const layout = layoutOf('/h/node');
    expect(dirname(layout.claudeMd)).toBe(layout.coordinatorDir);
    expect(Object.values(layout).filter((path) => path === '/h/node/CLAUDE.md')).toEqual([]);
  });
});

describe('the share list in the root .gitignore (TP-69)', () => {
  const lines = (text: string): string[] => text.split('\n');

  it('ignores everything, and allows .gitignore, factory.yaml and the setup folder', () => {
    expect(lines(SHARE_LIST_PART)).toEqual([
      '# factory:begin share list',
      '/*',
      '!/.gitignore',
      '!/factory.yaml',
      '!/setup/',
      '# factory:end share list',
      '',
    ]);
    expect(sharedRootPaths).toEqual(['.gitignore', 'factory.yaml', 'setup']);
  });

  it('allows no path that is private or one machine only', () => {
    const allowed = lines(SHARE_LIST_PART).filter((line) => line.startsWith('!'));
    for (const name of ['factory.local.yaml', '.factory', 'coordinator', 'work-copies']) {
      expect(allowed.filter((line) => line.includes(name))).toEqual([]);
    }
  });

  it('is the whole file when the root has no .gitignore, or an empty one', () => {
    expect(withShareList(null)).toEqual({ ok: true, value: SHARE_LIST_PART });
    expect(withShareList(' \n')).toEqual({ ok: true, value: SHARE_LIST_PART });
  });

  it('goes first, so the lines of a person after it can allow more paths', () => {
    const result = withShareList('!/notes.md\n');
    expect(result).toEqual({ ok: true, value: `${SHARE_LIST_PART}\n!/notes.md\n` });
    expect(result.ok && result.value.indexOf(SHARE_LIST_BEGIN)).toBe(0);
  });

  it('replaces a changed part in its place, and keeps the lines before and after it', () => {
    const old = `# mine\n${SHARE_LIST_BEGIN}\n/old\n${SHARE_LIST_END}\n# after\n!/notes.md\n`;
    expect(withShareList(old)).toEqual({ ok: true, value: `# mine\n${SHARE_LIST_PART.trimEnd()}\n# after\n!/notes.md\n` });
  });

  it('gives the same text when it runs again', () => {
    const once = withShareList('!/notes.md\n');
    expect(once.ok && withShareList(once.value)).toEqual(once);
  });

  it.each([
    ['a first marker line with no pair', `${SHARE_LIST_BEGIN}\n/*\n`],
    ['a second marker line with no pair', `/*\n${SHARE_LIST_END}\n`],
    ['two parts', `${SHARE_LIST_PART}${SHARE_LIST_PART}`],
    ['the second marker line before the first', `${SHARE_LIST_END}\n${SHARE_LIST_BEGIN}\n`],
  ])('refuses %s, because the end of the part is not known', (_name, text) => {
    expect(withShareList(text)).toEqual({
      ok: false,
      error: '.gitignore holds a marker line of the share list that has no pair',
    });
    expect(locateShareList(text).kind).toBe('broken');
  });

  it('tells a part that is the current one from a part that was changed', () => {
    expect(locateShareList(SHARE_LIST_PART)).toMatchObject({ kind: 'found', current: true });
    expect(locateShareList(`${SHARE_LIST_BEGIN}\n${SHARE_LIST_END}\n`)).toMatchObject({ kind: 'found', current: false });
    expect(locateShareList('!/notes.md\n')).toEqual({ kind: 'absent' });
  });
});

describe('ignoresLine: when git ignores the inbox by the state .gitignore', () => {
  it('counts the line, also with trailing spaces, a CR, or no line break', () => {
    expect(ignoresLine('inbox/\n', INBOX_GITIGNORE_LINE)).toBe(true);
    expect(ignoresLine('inbox/ \n', INBOX_GITIGNORE_LINE)).toBe(true);
    expect(ignoresLine('inbox/   \n', INBOX_GITIGNORE_LINE)).toBe(true);
    expect(ignoresLine('state/\r\ninbox/\r\n', INBOX_GITIGNORE_LINE)).toBe(true);
    expect(ignoresLine('inbox/ \r\n', INBOX_GITIGNORE_LINE)).toBe(true);
    expect(ignoresLine('state/\ninbox/', INBOX_GITIGNORE_LINE)).toBe(true);
  });

  it.each([
    ['a tab', 'inbox/\t\n'],
    ['a no-break space', 'inbox/ \n'],
    ['an escaped space', 'inbox/\\ \n'],
    ['a tab before the CR of a CRLF line end', 'inbox/\t\r\n'],
  ])('does not count a line that ends in %s, because git keeps that character in the pattern', (_name, text) => {
    expect(ignoresLine(text, INBOX_GITIGNORE_LINE)).toBe(false);
  });

  it.each(['!inbox/', '!inbox', '!/inbox/', '!inbox/**', '!**/inbox', '!*', '!in*', '!?nbox/', '![i]nbox/'])(
    'does not count the line when the later line %s can take the folder back into the repo',
    (negation) => {
      expect(ignoresLine(`inbox/\n${negation}\n`, INBOX_GITIGNORE_LINE)).toBe(false);
      expect(ignoresLine(`inbox/\r\n${negation}\r\n`, INBOX_GITIGNORE_LINE)).toBe(false);
      expect(ignoresLine(`inbox/\n${negation}`, INBOX_GITIGNORE_LINE)).toBe(false);
    },
  );

  it('counts the line again when it comes after the negation', () => {
    expect(ignoresLine('inbox/\n!*\ninbox/\n', INBOX_GITIGNORE_LINE)).toBe(true);
    expect(ignoresLine('!inbox\ninbox/\n', INBOX_GITIGNORE_LINE)).toBe(true);
  });

  it('reads a very long run of spaces in one pass', () => {
    const blanks = ' '.repeat(maxFileBytes - 16);
    expect(ignoresLine(`inbox/${blanks}x\ninbox/${blanks}\n`, INBOX_GITIGNORE_LINE)).toBe(true);
    expect(ignoresLine(`inbox/${blanks}x\n`, INBOX_GITIGNORE_LINE)).toBe(false);
  });

  it('counts the line when a later negation is for a name that cannot be the inbox', () => {
    expect(ignoresLine('inbox/\n!keep-me.md\n!/setup/\n', INBOX_GITIGNORE_LINE)).toBe(true);
  });

  it.each([
    ['a comment', '# inbox/\n'],
    ['a longer name', 'my-inbox/\n'],
    ['a name with a path before it', 'a/inbox/\n'],
    ['a line that starts with a blank', ' inbox/\n'],
    ['no text', ''],
  ])('does not count %s', (_name, text) => {
    expect(ignoresLine(text, INBOX_GITIGNORE_LINE)).toBe(false);
  });
});
