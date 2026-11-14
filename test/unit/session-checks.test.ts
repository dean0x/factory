import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeOf, failure, type CliError, type CliResult } from '../../src/cli/errors.js';
import { ownSettingsEntries } from '../../src/core/claude-settings.js';
import { dirs, hookNames, localSettingsFile, maxFileBytes, roleText } from '../../src/names.js';
import {
  paneProcessStart,
  requireLineAfterStart,
  requireOwnHooks,
  requireResumeFile,
  requireRoleDelivery,
  requireSettingsOlderThan,
} from '../../src/workers/session-checks.js';
import { createFakeDeps, exited, type FakeDeps, type RunHandler } from '../helpers/fake-deps.js';
import {
  OWN_SETTINGS_TEXT,
  seedAcceptedSetup,
  seedOwnHooks,
  seedUnacceptedSetup,
  settingsFileOf,
  SETUP_WORKER,
  STATE_ENV,
} from '../helpers/role-delivery.js';
import { sampleConfig } from '../helpers/sample-config.js';

const NOW = new Date('2030-01-02T03:04:05.678Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const AGAIN = 'worker reset alpha --clear';

const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('expected a refusal, but the check passed');
  return result.error;
};

const codeOf = <T>(result: CliResult<T>): number => exitCodeOf[errorOf(result).kind];

const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`the check failed: ${result.error.message}`);
  return result.value;
};

describe('the start time of the process of a pane', () => {
  const PID = 4321;
  const depsAnswering = (answer: RunHandler) => createFakeDeps({ now: NOW, run: answer });
  const startOf = async (deps: FakeDeps, pid = PID): Promise<CliResult<number>> => paneProcessStart(deps, pid, AGAIN);

  it('runs ps once for the pid, with a limit of 5 seconds and the default environment', async () => {
    const deps = depsAnswering(() => exited(0, '01:00\n'));
    await startOf(deps);
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0]).toMatchObject({ command: 'ps', args: ['-o', 'etime=', '-p', String(PID)], timeoutMs: 5000 });
    expect(deps.calls[0]?.inheritEnv).not.toBe(true);
  });

  it.each([
    ['minutes and seconds', '01:30', MINUTE + 30 * SECOND],
    ['the shortest time', '00:00', 0],
    ['the longest minutes and seconds', '59:59', 59 * MINUTE + 59 * SECOND],
    ['hours, minutes and seconds', '12:34:56', 12 * HOUR + 34 * MINUTE + 56 * SECOND],
    ['the longest hours', '23:59:59', 23 * HOUR + 59 * MINUTE + 59 * SECOND],
    ['days with a zero in front, as macOS prints them', '08-14:04:43', 8 * DAY + 14 * HOUR + 4 * MINUTE + 43 * SECOND],
    ['days with no zero in front', '3-00:00:01', 3 * DAY + SECOND],
    ['many days', '12345-23:59:59', 12345 * DAY + 23 * HOUR + 59 * MINUTE + 59 * SECOND],
    ['spaces before the time', '   05:03', 5 * MINUTE + 3 * SECOND],
    ['spaces and a new line at the ends', '  1-02:03:04  \n', DAY + 2 * HOUR + 3 * MINUTE + 4 * SECOND],
  ])('parses %s (%j)', async (_name, text, elapsedMs) => {
    const deps = depsAnswering(() => exited(0, text));
    expect(valueOf(await startOf(deps))).toBe(NOW.getTime() - elapsedMs);
  });

  it('reads the clock after ps returns, so a slow ps makes the start later and the line check stricter', async () => {
    const slow: FakeDeps = createFakeDeps({
      now: NOW,
      run: () => {
        slow.advance(3 * SECOND);
        return exited(0, '01:00\n');
      },
    });
    expect(valueOf(await startOf(slow))).toBe(NOW.getTime() + 3 * SECOND - MINUTE);
  });

  it.each([
    ['no text', ''],
    ['a new line only', '\n'],
    ['spaces only', '   '],
    ['a word', 'abc'],
    ['minutes with one digit', '5:03'],
    ['seconds with one digit', '05:3'],
    ['seconds above 59', '00:60'],
    ['minutes above 59', '60:00'],
    ['minutes above 59 with hours', '01:60:00'],
    ['hours above 23', '24:00:00'],
    ['days with no hours', '1-05:03'],
    ['four parts', '1:02:03:04'],
    ['a dash in front', '-1:00'],
    ['a plus sign in front', '+1:00'],
    ['a decimal', '01:00.5'],
    ['more than 5 digits of days', '123456-00:00:00'],
    ['text after the time', '12:34 junk'],
    ['two lines', '12:34\n56:78\n'],
    ['an empty second line', '12:34\n\n'],
    ['a tab in front', '\t12:34'],
    ['digits that are not ASCII', '١٢:٣٤'],
    ['a time in a sentence', 'elapsed 12:34'],
  ])('refuses %s (%j) with exit 3', async (_name, text) => {
    const result = await startOf(depsAnswering(() => exited(0, text)));
    expect(codeOf(result)).toBe(3);
  });

  it('a ps that fails is exit 3, also when its output looks like a time', async () => {
    expect(codeOf(await startOf(depsAnswering(() => exited(1, '01:00\n'))))).toBe(3);
    expect(codeOf(await startOf(depsAnswering(() => exited(1, '', 'no such process\n'))))).toBe(3);
  });

  it('empty output with exit 0 (the pid is gone) is exit 3', async () => {
    expect(codeOf(await startOf(depsAnswering(() => exited(0, ''))))).toBe(3);
  });

  it('a ps that does not start or that runs past the limit is exit 3', async () => {
    expect(codeOf(await startOf(depsAnswering(() => failure('cannot run ps: ENOENT'))))).toBe(3);
    expect(codeOf(await startOf(depsAnswering(() => failure('ps ran past 5000 ms'))))).toBe(3);
  });

  it('the refusal names the command to run again and repeats no text of the output', async () => {
    const error = errorOf(await startOf(depsAnswering(() => exited(0, 'SECRET-OUTPUT'))));
    expect(error.hint).toContain(`factory ${AGAIN}`);
    expect(`${error.message} ${error.hint ?? ''}`).not.toContain('SECRET-OUTPUT');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('refuses the pid %s and runs no ps', async (pid) => {
    const deps = depsAnswering(() => exited(0, '01:00\n'));
    expect(codeOf(await startOf(deps, pid))).toBe(3);
    expect(deps.calls).toEqual([]);
  });
});

describe('the line check', () => {
  const START = NOW.getTime() - MINUTE;
  const at = (ms: number): string => new Date(ms).toISOString();

  it('refuses a line 500 ms before the start of the process', () => {
    expect(codeOf(requireLineAfterStart(at(START - 500), START, AGAIN))).toBe(3);
  });

  it('refuses a line at the same time as the start: the line must be strictly later', () => {
    expect(codeOf(requireLineAfterStart(at(START), START, AGAIN))).toBe(3);
  });

  it('passes a line 1 ms after the start', () => {
    expect(requireLineAfterStart(at(START + 1), START, AGAIN).ok).toBe(true);
  });

  it.each(['', 'yesterday', '2030-13-45T00:00:00Z'])('refuses the time %j that is no time', (text) => {
    expect(codeOf(requireLineAfterStart(text, START, AGAIN))).toBe(3);
  });

  it('the refusal names the command to run again', () => {
    expect(errorOf(requireLineAfterStart(at(START), START, AGAIN)).hint).toContain(`factory ${AGAIN}`);
  });
});

describe('the resume file', () => {
  const FOLDER = '/h/node/.factory/resume';
  const FILE = `${FOLDER}/demo.md`;
  const request = { folders: [{ path: FOLDER, what: 'the resume folder' }], file: { path: FILE, what: 'the resume file' }, again: AGAIN };
  const make = (more: Parameters<typeof createFakeDeps>[0] = {}): FakeDeps => createFakeDeps({ now: NOW, ...more });

  it('gives the age of a file that holds text', async () => {
    const deps = make();
    deps.seed(FILE, 'what is done and what is next');
    deps.mtimes.set(FILE, NOW.getTime() - 90 * SECOND);
    expect(valueOf(await requireResumeFile(deps, request))).toEqual({ ageMs: 90 * SECOND });
  });

  it('gives an age of 0 for a file with a time in the future', async () => {
    const deps = make();
    deps.seed(FILE, 'notes');
    deps.mtimes.set(FILE, NOW.getTime() + HOUR);
    expect(valueOf(await requireResumeFile(deps, request))).toEqual({ ageMs: 0 });
  });

  it('a file with exactly the most bytes is valid', async () => {
    const deps = make();
    deps.seed(FILE, 'x'.repeat(maxFileBytes));
    expect((await requireResumeFile(deps, request)).ok).toBe(true);
  });

  it('a missing file is exit 3, and the refusal names the file', async () => {
    const deps = make();
    deps.seedDir(FOLDER);
    const error = errorOf(await requireResumeFile(deps, request));
    expect(error.kind).toBe('not-ready');
    expect(`${error.message} ${error.hint ?? ''}`).toContain(FILE);
    expect(error.hint).toContain(`factory ${AGAIN}`);
  });

  it('a missing folder is exit 3 too', async () => {
    expect(codeOf(await requireResumeFile(make(), request))).toBe(3);
  });

  it('a file that is a link is exit 4, and the refusal names the file', async () => {
    const deps = make({ links: { [FILE]: '/elsewhere/notes.md' } });
    deps.seedDir(FOLDER);
    deps.seed('/elsewhere/notes.md', 'notes');
    const error = errorOf(await requireResumeFile(deps, request));
    expect(error.kind).toBe('safety');
    expect(`${error.message} ${error.hint ?? ''}`).toContain(FILE);
  });

  it('a folder of the chain that is a link is exit 4', async () => {
    const deps = make({ links: { [FOLDER]: '/elsewhere' } });
    deps.seed(FILE, 'notes');
    expect(codeOf(await requireResumeFile(deps, request))).toBe(4);
  });

  it.each([
    ['empty', ''],
    ['only spaces and new lines', '  \n\t\n'],
  ])('a file that is %s is exit 3', async (_name, text) => {
    const deps = make();
    deps.seed(FILE, text);
    const error = errorOf(await requireResumeFile(deps, request));
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(`${error.message} ${error.hint ?? ''}`).toContain(FILE);
  });

  it('a file above 1 MiB is exit 3', async () => {
    const deps = make();
    deps.seed(FILE, 'x'.repeat(maxFileBytes + 1));
    expect(codeOf(await requireResumeFile(deps, request))).toBe(3);
  });

  it('a file that is a folder is exit 3', async () => {
    const deps = make();
    deps.seedDir(FILE);
    expect(codeOf(await requireResumeFile(deps, request))).toBe(3);
  });

  it('the refusal repeats no text of the file', async () => {
    const deps = make();
    deps.seed(FILE, '   ');
    const error = errorOf(await requireResumeFile(deps, request));
    expect(error.message).not.toContain('   ');
  });
});

describe('the hook settings of a session folder', () => {
  const FOLDER = '/h/node/work-copies/web/alpha';
  const FILE = join(FOLDER, dirs.claude, localSettingsFile);
  const request = { folder: FOLDER, then: 'restart alpha' };
  const make = (more: Parameters<typeof createFakeDeps>[0] = {}): FakeDeps => createFakeDeps({ now: NOW, ...more });

  const withoutEvent = (event: string): string =>
    JSON.stringify({ hooks: Object.fromEntries(Object.entries(ownSettingsEntries.hooks).filter(([name]) => name !== event)) });

  it('passes settings that hold the command of every event', async () => {
    const deps = make();
    deps.seed(FILE, JSON.stringify(ownSettingsEntries));
    expect((await requireOwnHooks(deps, request)).ok).toBe(true);
  });

  it.each(hookNames.events)('settings without the event %s are exit 3, and the refusal names the event', async (event) => {
    const deps = make();
    deps.seed(FILE, withoutEvent(event));
    const error = errorOf(await requireOwnHooks(deps, request));
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain(event);
  });

  it('the remedy is factory upgrade, then the command that starts the session again', async () => {
    const deps = make();
    deps.seed(FILE, withoutEvent('Notification'));
    const error = errorOf(await requireOwnHooks(deps, request));
    expect(error.hint).toContain('factory upgrade');
    expect(error.hint).toContain('factory restart alpha');
  });

  it('a Notification group with another matcher counts as missing', async () => {
    const deps = make();
    const hooks = { ...ownSettingsEntries.hooks, Notification: [{ matcher: 'idle_prompt', hooks: ownSettingsEntries.hooks['Notification']?.[0]?.hooks ?? [] }] };
    deps.seed(FILE, JSON.stringify({ hooks }));
    expect(errorOf(await requireOwnHooks(deps, request)).message).toContain('Notification');
  });

  it.each([
    ['a file that is not JSON', 'not json'],
    ['a file that is a list', '[]'],
    ['an object with no hooks', '{}'],
    ['a hooks value that is a list', '{"hooks": []}'],
    ['an event whose value is not a list', '{"hooks": {"Stop": "x"}}'],
  ])('%s is exit 3', async (_name, text) => {
    const deps = make();
    deps.seed(FILE, text);
    expect(codeOf(await requireOwnHooks(deps, request))).toBe(3);
  });

  it('a missing settings file is exit 3', async () => {
    expect(codeOf(await requireOwnHooks(make(), request))).toBe(3);
  });

  it('a settings file that is a link is exit 4', async () => {
    const deps = make({ links: { [FILE]: '/elsewhere/settings.json' } });
    deps.seedDir(join(FOLDER, dirs.claude));
    deps.seed('/elsewhere/settings.json', JSON.stringify(ownSettingsEntries));
    expect(codeOf(await requireOwnHooks(deps, request))).toBe(4);
  });

  it('a settings file above 1 MiB is exit 3', async () => {
    const deps = make();
    deps.seed(FILE, ' '.repeat(maxFileBytes + 1));
    expect(codeOf(await requireOwnHooks(deps, request))).toBe(3);
  });

  describe('older than the start of the process', () => {
    const START = NOW.getTime() - MINUTE;
    const olderRequest = { ...request, start: START };
    const settingsWritten = (ms: number): FakeDeps => {
      const deps = make();
      deps.seed(FILE, JSON.stringify(ownSettingsEntries));
      deps.mtimes.set(FILE, ms);
      return deps;
    };

    it('passes settings that changed before the start', async () => {
      expect((await requireSettingsOlderThan(settingsWritten(START - SECOND), olderRequest)).ok).toBe(true);
    });

    it('refuses settings that changed at the start: they must be strictly earlier', async () => {
      expect(codeOf(await requireSettingsOlderThan(settingsWritten(START), olderRequest))).toBe(3);
    });

    it('refuses settings that changed after the start, and the remedy starts the session again', async () => {
      const error = errorOf(await requireSettingsOlderThan(settingsWritten(START + SECOND), olderRequest));
      expect(error.kind).toBe('not-ready');
      expect(error.hint).toContain('factory restart alpha');
    });

    it('the refusal says that a permission rule that Claude Code saved also changes the file', async () => {
      const error = errorOf(await requireSettingsOlderThan(settingsWritten(START + SECOND), olderRequest));
      expect(error.hint).toContain('permission rule');
    });

    it('a settings file that is not there is exit 3', async () => {
      expect(codeOf(await requireSettingsOlderThan(make(), olderRequest))).toBe(3);
    });
  });
});

describe('the delivery of the role text to a work copy', () => {
  const HOME = '/h/node';
  const FOLDER = `${HOME}/work-copies/web/alpha`;
  const AGAIN_LINE = 'worker resume alpha';
  const request = { home: HOME, config: sampleConfig(), workerId: 'alpha', workCopy: FOLDER, again: AGAIN_LINE };
  const make = (): FakeDeps => {
    const deps = createFakeDeps({ now: NOW, env: STATE_ENV });
    deps.seedDir(FOLDER);
    seedOwnHooks(deps, FOLDER);
    return deps;
  };

  it('passes for a work copy with every own hook and a node that has no setup text for the worker', async () => {
    expect((await requireRoleDelivery(make(), request)).ok).toBe(true);
  });

  it('passes for the setup text that the owner accepted', async () => {
    const deps = make();
    seedAcceptedSetup(deps, HOME, 'Write tests first.\n');
    expect((await requireRoleDelivery(deps, request)).ok).toBe(true);
  });

  describe('a work copy with no own hook entry', () => {
    it('is exit 3 for a work copy with no settings file, and names the events that lack', async () => {
      const deps = make();
      deps.files.delete(settingsFileOf(FOLDER));
      const error = errorOf(await requireRoleDelivery(deps, request));
      expect(exitCodeOf[error.kind]).toBe(3);
      expect(error.message).toContain('SessionStart');
    });

    it('puts each command of the remedy on its own line, for the fix and for a work copy that never had the hook', async () => {
      const deps = make();
      deps.files.delete(settingsFileOf(FOLDER));
      const lines = (errorOf(await requireRoleDelivery(deps, request)).hint ?? '').split('\n');
      expect(lines).toEqual(
        expect.arrayContaining([
          'factory upgrade',
          'factory worker resume alpha',
          'factory dismiss alpha',
          'factory worker new alpha --project web',
        ]),
      );
      expect(lines.at(-1)).toBe('Answer yes to the question about the hook settings.');
    });

    it('names the command of the caller as the command that starts the worker again', async () => {
      const deps = make();
      deps.files.delete(settingsFileOf(FOLDER));
      const lines = (errorOf(await requireRoleDelivery(deps, { ...request, again: 'restart alpha' })).hint ?? '').split('\n');
      expect(lines).toContain('factory restart alpha');
      expect(lines).not.toContain('factory worker resume alpha');
    });

    it('is exit 3 when only the SessionStart entry lacks', async () => {
      const deps = make();
      const { SessionStart: _start, ...others } = ownSettingsEntries.hooks;
      deps.seed(settingsFileOf(FOLDER), JSON.stringify({ hooks: others }));
      const error = errorOf(await requireRoleDelivery(deps, request));
      expect(exitCodeOf[error.kind]).toBe(3);
      expect(error.message).toContain('SessionStart');
    });

    it('is exit 4 when the settings file is a link', async () => {
      const deps = createFakeDeps({ now: NOW, env: STATE_ENV, links: { [settingsFileOf(FOLDER)]: '/elsewhere/settings.json' } });
      deps.seedDir(`${FOLDER}/.claude`);
      deps.seed('/elsewhere/settings.json', OWN_SETTINGS_TEXT);
      expect(codeOf(await requireRoleDelivery(deps, request))).toBe(4);
    });

    it('is refused before the role text is read: a fault of both gives the hook refusal', async () => {
      const deps = make();
      deps.files.delete(settingsFileOf(FOLDER));
      seedUnacceptedSetup(deps, HOME, 'Write tests first.\n');
      expect(errorOf(await requireRoleDelivery(deps, request)).message).toContain('lack the events');
    });
  });

  describe('a role text that a check refuses', () => {
    it('is exit 4 for a setup text that the owner did not accept, and names the command to run again', async () => {
      const deps = make();
      seedUnacceptedSetup(deps, HOME, 'Write tests first.\n');
      const error = errorOf(await requireRoleDelivery(deps, request));
      expect(exitCodeOf[error.kind]).toBe(4);
      expect(error.hint).toContain('"factory worker resume alpha"');
    });

    it('is exit 4 for a setup text that changed after the owner accepted it', async () => {
      const deps = make();
      seedAcceptedSetup(deps, HOME, 'Write tests first.\n');
      deps.seed(`${HOME}/${SETUP_WORKER}`, 'Write no tests.\n');
      expect(codeOf(await requireRoleDelivery(deps, request))).toBe(4);
    });

    it('is exit 1 for a text above the cap, and names its size and the cap', async () => {
      const deps = make();
      seedAcceptedSetup(deps, HOME, `${'x'.repeat(roleText.maxChars - 500)}\n`);
      const error = errorOf(await requireRoleDelivery(deps, request));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toMatch(/^the role text has \d+ characters, and the cap is 9000 characters$/);
      expect(error.hint).toContain('or fewer');
    });

    it('is exit 1 for a setup text that holds a block marker', async () => {
      const deps = make();
      seedAcceptedSetup(deps, HOME, '<!-- factory:begin worker v1 sha256=00 -->\n');
      const error = errorOf(await requireRoleDelivery(deps, request));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toBe(roleText.reasons.blockMarker);
    });

    it('is exit 4 for a setup file that is a link', async () => {
      const deps = createFakeDeps({ now: NOW, env: STATE_ENV, links: { [`${HOME}/${SETUP_WORKER}`]: '/elsewhere/worker.md' } });
      deps.seedDir(FOLDER);
      seedOwnHooks(deps, FOLDER);
      deps.seed('/elsewhere/worker.md', 'Write tests first.\n');
      expect(codeOf(await requireRoleDelivery(deps, request))).toBe(4);
    });

    it('passes the error of an acceptance store that cannot be used, and never reads it as accepted', async () => {
      const deps = createFakeDeps({ now: NOW });
      deps.seedDir(FOLDER);
      seedOwnHooks(deps, FOLDER);
      expect(errorOf(await requireRoleDelivery(deps, request)).message).toContain('no variable names a state folder');
    });

    it('never prints the text of the setup file or its path', async () => {
      const deps = make();
      seedUnacceptedSetup(deps, HOME, 'SECRET-LINE\n');
      const error = errorOf(await requireRoleDelivery(deps, request));
      expect(JSON.stringify(error)).not.toContain('SECRET-LINE');
      expect(JSON.stringify(error)).not.toContain(`${HOME}/${SETUP_WORKER}`);
    });
  });
});

describe('the remedy option of the own hook check', () => {
  const FOLDER = '/h/node/work-copies/web/alpha';
  it('replaces the default remedy for a missing event, and leaves the refusal of a link as it is', async () => {
    const deps = createFakeDeps({ now: NOW });
    const missing = errorOf(await requireOwnHooks(deps, { folder: FOLDER, then: 'restart alpha', remedy: 'Do this.' }));
    expect(missing.hint).toBe('Do this.');
    const linked = createFakeDeps({ now: NOW, links: { [`${FOLDER}/.claude/settings.local.json`]: '/elsewhere/settings.json' } });
    linked.seedDir(`${FOLDER}/.claude`);
    linked.seed('/elsewhere/settings.json', OWN_SETTINGS_TEXT);
    const link = errorOf(await requireOwnHooks(linked, { folder: FOLDER, then: 'restart alpha', remedy: 'Do this.' }));
    expect(link.hint).toContain('factory restart alpha');
    expect(link.hint).not.toBe('Do this.');
  });
});
