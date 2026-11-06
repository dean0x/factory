import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeOf, failure, type CliError, type CliResult } from '../../src/cli/errors.js';
import { ownSettingsEntries } from '../../src/core/claude-settings.js';
import { dirs, hookNames, localSettingsFile, maxFileBytes } from '../../src/names.js';
import {
  paneProcessStart,
  requireLineAfterStart,
  requireOwnHooks,
  requireResumeFile,
  requireSettingsOlderThan,
} from '../../src/workers/session-checks.js';
import { createFakeDeps, exited, type FakeDeps, type RunHandler } from '../helpers/fake-deps.js';

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

describe('TP-20: the start time of the process of a pane', () => {
  const PID = 4321;
  const depsAnswering = (answer: RunHandler) => createFakeDeps({ now: NOW, run: answer });
  const startOf = async (deps: FakeDeps, pid = PID): Promise<CliResult<number>> => paneProcessStart(deps, pid, AGAIN);

  it('TP-20: runs ps once for the pid, with a limit of 5 seconds and the default environment', async () => {
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
  ])('TP-20: parses %s (%j)', async (_name, text, elapsedMs) => {
    const deps = depsAnswering(() => exited(0, text));
    expect(valueOf(await startOf(deps))).toBe(NOW.getTime() - elapsedMs);
  });

  it('TP-20: reads the clock after ps returns, so a slow ps makes the start later and the line check stricter', async () => {
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
  ])('TP-20: refuses %s (%j) with exit 3', async (_name, text) => {
    const result = await startOf(depsAnswering(() => exited(0, text)));
    expect(codeOf(result)).toBe(3);
  });

  it('TP-20: a ps that fails is exit 3, also when its output looks like a time', async () => {
    expect(codeOf(await startOf(depsAnswering(() => exited(1, '01:00\n'))))).toBe(3);
    expect(codeOf(await startOf(depsAnswering(() => exited(1, '', 'no such process\n'))))).toBe(3);
  });

  it('TP-20: empty output with exit 0 (the pid is gone) is exit 3', async () => {
    expect(codeOf(await startOf(depsAnswering(() => exited(0, ''))))).toBe(3);
  });

  it('TP-20: a ps that does not start or that runs past the limit is exit 3', async () => {
    expect(codeOf(await startOf(depsAnswering(() => failure('cannot run ps: ENOENT'))))).toBe(3);
    expect(codeOf(await startOf(depsAnswering(() => failure('ps ran past 5000 ms'))))).toBe(3);
  });

  it('TP-20: the refusal names the command to run again and repeats no text of the output', async () => {
    const error = errorOf(await startOf(depsAnswering(() => exited(0, 'SECRET-OUTPUT'))));
    expect(error.hint).toContain(`factory ${AGAIN}`);
    expect(`${error.message} ${error.hint ?? ''}`).not.toContain('SECRET-OUTPUT');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('TP-20: refuses the pid %s and runs no ps', async (pid) => {
    const deps = depsAnswering(() => exited(0, '01:00\n'));
    expect(codeOf(await startOf(deps, pid))).toBe(3);
    expect(deps.calls).toEqual([]);
  });
});

describe('TP-20: the line check', () => {
  const START = NOW.getTime() - MINUTE;
  const at = (ms: number): string => new Date(ms).toISOString();

  it('TP-20: refuses a line 500 ms before the start of the process', () => {
    expect(codeOf(requireLineAfterStart(at(START - 500), START, AGAIN))).toBe(3);
  });

  it('TP-20: refuses a line at the same time as the start: the line must be strictly later', () => {
    expect(codeOf(requireLineAfterStart(at(START), START, AGAIN))).toBe(3);
  });

  it('TP-20: passes a line 1 ms after the start', () => {
    expect(requireLineAfterStart(at(START + 1), START, AGAIN).ok).toBe(true);
  });

  it.each(['', 'yesterday', '2030-13-45T00:00:00Z'])('TP-20: refuses the time %j that is no time', (text) => {
    expect(codeOf(requireLineAfterStart(text, START, AGAIN))).toBe(3);
  });

  it('TP-20: the refusal names the command to run again', () => {
    expect(errorOf(requireLineAfterStart(at(START), START, AGAIN)).hint).toContain(`factory ${AGAIN}`);
  });
});

describe('TP-21: the resume file', () => {
  const FOLDER = '/h/node/.factory/resume';
  const FILE = `${FOLDER}/demo.md`;
  const request = { folders: [{ path: FOLDER, what: 'the resume folder' }], file: { path: FILE, what: 'the resume file' }, again: AGAIN };
  const make = (more: Parameters<typeof createFakeDeps>[0] = {}): FakeDeps => createFakeDeps({ now: NOW, ...more });

  it('TP-21: gives the age of a file that holds text', async () => {
    const deps = make();
    deps.seed(FILE, 'what is done and what is next');
    deps.mtimes.set(FILE, NOW.getTime() - 90 * SECOND);
    expect(valueOf(await requireResumeFile(deps, request))).toEqual({ ageMs: 90 * SECOND });
  });

  it('TP-21: gives an age of 0 for a file with a time in the future', async () => {
    const deps = make();
    deps.seed(FILE, 'notes');
    deps.mtimes.set(FILE, NOW.getTime() + HOUR);
    expect(valueOf(await requireResumeFile(deps, request))).toEqual({ ageMs: 0 });
  });

  it('TP-21: a file with exactly the most bytes is valid', async () => {
    const deps = make();
    deps.seed(FILE, 'x'.repeat(maxFileBytes));
    expect((await requireResumeFile(deps, request)).ok).toBe(true);
  });

  it('TP-21: a missing file is exit 3, and the refusal names the file', async () => {
    const deps = make();
    deps.seedDir(FOLDER);
    const error = errorOf(await requireResumeFile(deps, request));
    expect(error.kind).toBe('not-ready');
    expect(`${error.message} ${error.hint ?? ''}`).toContain(FILE);
    expect(error.hint).toContain(`factory ${AGAIN}`);
  });

  it('TP-21: a missing folder is exit 3 too', async () => {
    expect(codeOf(await requireResumeFile(make(), request))).toBe(3);
  });

  it('TP-21: a file that is a link is exit 4, and the refusal names the file', async () => {
    const deps = make({ links: { [FILE]: '/elsewhere/notes.md' } });
    deps.seedDir(FOLDER);
    deps.seed('/elsewhere/notes.md', 'notes');
    const error = errorOf(await requireResumeFile(deps, request));
    expect(error.kind).toBe('safety');
    expect(`${error.message} ${error.hint ?? ''}`).toContain(FILE);
  });

  it('TP-21: a folder of the chain that is a link is exit 4', async () => {
    const deps = make({ links: { [FOLDER]: '/elsewhere' } });
    deps.seed(FILE, 'notes');
    expect(codeOf(await requireResumeFile(deps, request))).toBe(4);
  });

  it.each([
    ['empty', ''],
    ['only spaces and new lines', '  \n\t\n'],
  ])('TP-21: a file that is %s is exit 3', async (_name, text) => {
    const deps = make();
    deps.seed(FILE, text);
    const error = errorOf(await requireResumeFile(deps, request));
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(`${error.message} ${error.hint ?? ''}`).toContain(FILE);
  });

  it('TP-21: a file above 1 MiB is exit 3', async () => {
    const deps = make();
    deps.seed(FILE, 'x'.repeat(maxFileBytes + 1));
    expect(codeOf(await requireResumeFile(deps, request))).toBe(3);
  });

  it('TP-21: a file that is a folder is exit 3', async () => {
    const deps = make();
    deps.seedDir(FILE);
    expect(codeOf(await requireResumeFile(deps, request))).toBe(3);
  });

  it('TP-21: the refusal repeats no text of the file', async () => {
    const deps = make();
    deps.seed(FILE, '   ');
    const error = errorOf(await requireResumeFile(deps, request));
    expect(error.message).not.toContain('   ');
  });
});

describe('TP-21: the hook settings of a session folder', () => {
  const FOLDER = '/h/node/work-copies/web/alpha';
  const FILE = join(FOLDER, dirs.claude, localSettingsFile);
  const request = { folder: FOLDER, then: 'restart alpha' };
  const make = (more: Parameters<typeof createFakeDeps>[0] = {}): FakeDeps => createFakeDeps({ now: NOW, ...more });

  const withoutEvent = (event: string): string =>
    JSON.stringify({ hooks: Object.fromEntries(Object.entries(ownSettingsEntries.hooks).filter(([name]) => name !== event)) });

  it('TP-21: passes settings that hold the command of every event', async () => {
    const deps = make();
    deps.seed(FILE, JSON.stringify(ownSettingsEntries));
    expect((await requireOwnHooks(deps, request)).ok).toBe(true);
  });

  it.each(hookNames.events)('TP-21: settings without the event %s are exit 3, and the refusal names the event', async (event) => {
    const deps = make();
    deps.seed(FILE, withoutEvent(event));
    const error = errorOf(await requireOwnHooks(deps, request));
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain(event);
  });

  it('TP-21: the remedy is factory upgrade, then the command that starts the session again', async () => {
    const deps = make();
    deps.seed(FILE, withoutEvent('Notification'));
    const error = errorOf(await requireOwnHooks(deps, request));
    expect(error.hint).toContain('factory upgrade');
    expect(error.hint).toContain('factory restart alpha');
  });

  it('TP-21: a Notification group with another matcher counts as missing', async () => {
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
  ])('TP-21: %s is exit 3', async (_name, text) => {
    const deps = make();
    deps.seed(FILE, text);
    expect(codeOf(await requireOwnHooks(deps, request))).toBe(3);
  });

  it('TP-21: a missing settings file is exit 3', async () => {
    expect(codeOf(await requireOwnHooks(make(), request))).toBe(3);
  });

  it('TP-21: a settings file that is a link is exit 4', async () => {
    const deps = make({ links: { [FILE]: '/elsewhere/settings.json' } });
    deps.seedDir(join(FOLDER, dirs.claude));
    deps.seed('/elsewhere/settings.json', JSON.stringify(ownSettingsEntries));
    expect(codeOf(await requireOwnHooks(deps, request))).toBe(4);
  });

  it('TP-21: a settings file above 1 MiB is exit 3', async () => {
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

    it('TP-21: passes settings that changed before the start', async () => {
      expect((await requireSettingsOlderThan(settingsWritten(START - SECOND), olderRequest)).ok).toBe(true);
    });

    it('TP-21: refuses settings that changed at the start: they must be strictly earlier', async () => {
      expect(codeOf(await requireSettingsOlderThan(settingsWritten(START), olderRequest))).toBe(3);
    });

    it('TP-21: refuses settings that changed after the start, and the remedy starts the session again', async () => {
      const error = errorOf(await requireSettingsOlderThan(settingsWritten(START + SECOND), olderRequest));
      expect(error.kind).toBe('not-ready');
      expect(error.hint).toContain('factory restart alpha');
    });

    it('TP-21: the refusal says that a permission rule that Claude Code saved also changes the file', async () => {
      const error = errorOf(await requireSettingsOlderThan(settingsWritten(START + SECOND), olderRequest));
      expect(error.hint).toContain('permission rule');
    });

    it('TP-21: a settings file that is not there is exit 3', async () => {
      expect(codeOf(await requireSettingsOlderThan(make(), olderRequest))).toBe(3);
    });
  });
});
