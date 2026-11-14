import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeOf } from '../../src/cli/errors.js';
import { runCli } from '../../src/cli/run.js';
import { ensureHookSettings, ownSettingsEntries } from '../../src/core/claude-settings.js';
import type { Deps } from '../../src/core/deps.js';
import { ok } from '../../src/core/result.js';
import { workerLaunchMarks } from '../../src/launch/argv.js';
import { commandLines, hookSessions, roleText } from '../../src/names.js';
import { layoutOf } from '../../src/state/layout.js';
import { launchWorker } from '../../src/workers/launch.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { createFakeDeps, registerRoot, type FakeDeps } from '../helpers/fake-deps.js';
import { OWN_SETTINGS_TEXT, seedAcceptedSetup, seedUnacceptedSetup, settingsFileOf, STATE_ENV } from '../helpers/role-delivery.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { captureSink } from '../helpers/sink.js';
import { tmuxHandler, type TmuxLog } from '../helpers/tmux-fake.js';
import { startsSession, withProgram } from '../helpers/worker-program.js';

/**
 * The whole path from a launch to the role text, with the builders of the program and no stand-in for any of them: the settings file
 * that `worker new` writes, the launch of the worker, and the hook command that the settings file names, run through the router with
 * the variables of the launch. A launch that has no path to the role text must fail here, and a launch that is refused must make no pane.
 */

const HOME = '/h/node';
const WORKER = 'alpha';
const COPY = `${HOME}/work-copies/web/${WORKER}`;
const SESSION = '00000000-0000-4000-8000-000000000001';
const SETUP_LINE = 'Write tests first.';
const SETTINGS_FILE = settingsFileOf(COPY);
const SETUP_FILE = layoutOf(HOME).setupWorkerFile;
const NODE_ID = sampleConfig().core.node.id;

const FIXTURE = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'claude', 'payloads.json'), 'utf8')) as {
  readonly hooks: { readonly SessionStart: Readonly<Record<string, unknown>> };
};

/** How the setup file of the worker is on disk, and what the owner accepted. */
type Setup = 'accepted' | 'unaccepted' | 'accepted-then-removed';

interface World {
  readonly setup?: Setup;
  /** The text of the setup file. Default: one known line. */
  readonly text?: string;
  /** The settings file of the work copy. Default: the settings that `worker new` writes. */
  readonly settings?: string;
  readonly links?: Readonly<Record<string, string>>;
}

interface Made {
  readonly deps: FakeDeps;
  readonly tmux: TmuxLog;
}

/** A node with a worker that has a record and a work copy, the setup file of the world, and the settings of its work copy. */
const make = async (world: World = {}): Promise<Made> => {
  const { handler, log } = tmuxHandler({ sessions: { [NODE_ID]: HOME } });
  const deps = createFakeDeps({
    env: { PATH: '/bin', ...STATE_ENV },
    run: (call) => handler(call),
    ...(world.links === undefined ? {} : { links: world.links }),
  });
  seedConfig(deps, HOME);
  registerRoot(deps, HOME, NODE_ID);
  deps.seedDir(COPY);
  const written = await writeWorkerRecord(deps, HOME, { id: WORKER, project: 'web', workCopy: COPY, branch: `worker/${WORKER}` });
  expect(written.ok).toBe(true);
  const { setup = 'accepted', text = `${SETUP_LINE}\n` } = world;
  if (setup === 'accepted' || setup === 'accepted-then-removed') seedAcceptedSetup(deps, HOME, text);
  if (setup === 'accepted-then-removed') deps.files.delete(SETUP_FILE);
  if (setup === 'unaccepted') seedUnacceptedSetup(deps, HOME, text);
  if (world.settings === undefined) {
    const hooks = await ensureHookSettings(deps, {
      folder: COPY,
      session: hookSessions.workCopy,
      yes: true,
      dryRun: false,
      command: commandLines.workerNew,
    });
    expect(hooks.ok && hooks.value.kind).toBe('written');
  } else {
    deps.seed(SETTINGS_FILE, world.settings);
  }
  return { deps: withProgram(deps, log, startsSession(HOME, WORKER)), tmux: log };
};

const launch = (made: Made) =>
  launchWorker(made.deps, { home: HOME, config: sampleConfig(), workerId: WORKER, workCopy: COPY, retry: commandLines.workerNew });

const panesMade = (made: Made): readonly string[] => made.tmux.commands().filter((command) => command.startsWith('split-window'));

/** The variables that the launch gives the pane: the words `NAME=value` of its start command. */
const paneEnvOf = (made: Made): Readonly<Record<string, string>> => {
  const split = made.tmux.calls.find((call) => call.args[0] === 'split-window');
  const words = split?.args.slice(split.args.indexOf('--') + 1) ?? [];
  const variables = workerLaunchMarks(HOME, WORKER).variables;
  for (const variable of variables) expect(words).toContain(variable);
  return Object.fromEntries(variables.map((variable) => [variable.slice(0, variable.indexOf('=')), variable.slice(variable.indexOf('=') + 1)]));
};

/** The command that the settings file names for the start of a session, run through the router as the program of the pane runs it. */
const runStartHook = async (made: Made, source: string) => {
  const settings = JSON.parse(made.deps.files.get(SETTINGS_FILE) ?? '{}') as {
    hooks?: { SessionStart?: { hooks: { command: string }[] }[] };
  };
  const command = settings.hooks?.SessionStart?.[0]?.hooks[0]?.command ?? '';
  const [, ...argv] = command.split(' ');
  const stdin = JSON.stringify({ ...FIXTURE.hooks.SessionStart, session_id: SESSION, source });
  const hookDeps: Deps = { ...made.deps, cwd: COPY, env: { ...STATE_ENV, ...paneEnvOf(made) }, readStdin: async () => ok(stdin) };
  const sink = captureSink();
  const code = await runCli(argv, hookDeps, sink);
  return { code, out: sink.out.join(''), err: sink.errors.join('') };
};

const withoutHook = (event: string): string =>
  JSON.stringify({ hooks: Object.fromEntries(Object.entries(ownSettingsEntries.hooks).filter(([name]) => name !== event)) });

const startupOnly = JSON.stringify({
  hooks: { ...ownSettingsEntries.hooks, SessionStart: [{ matcher: 'startup', hooks: ownSettingsEntries.hooks['SessionStart']?.[0]?.hooks ?? [] }] },
});

describe('a worker that launches gets its role text', () => {
  it('has the settings of worker new in its work copy', async () => {
    const made = await make();
    expect(made.deps.files.get(SETTINGS_FILE)).toBe(OWN_SETTINGS_TEXT);
  });

  it.each(['startup', 'resume', 'clear', 'compact'])('prints the known setup line at the session start with the source %s', async (source) => {
    const made = await make();
    expect((await launch(made)).ok).toBe(true);
    expect(panesMade(made)).toHaveLength(1);
    const ran = await runStartHook(made, source);
    expect({ code: ran.code, err: ran.err }).toEqual({ code: 0, err: '' });
    const printed = JSON.parse(ran.out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(printed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const lines = printed.hookSpecificOutput.additionalContext.split('\n');
    expect(lines[0]).toBe(roleText.sourceLine);
    expect(lines).toContain(SETUP_LINE);
  });
});

describe('a worker that would get no role text is refused before any pane starts', () => {
  const refusals: ReadonlyArray<readonly [string, World, number]> = [
    ['no SessionStart entry in the settings of the work copy', { settings: withoutHook('SessionStart') }, 3],
    ['a SessionStart entry under the startup matcher only', { settings: startupOnly }, 3],
    ['an accepted setup file that is absent', { setup: 'accepted-then-removed' }, 4],
    ['a link as the setup file', { links: { [SETUP_FILE]: '/elsewhere/worker.md' } }, 4],
    ['a text above the cap', { text: `${'x'.repeat(roleText.maxChars - 500)}\n` }, 1],
    ['a setup text that the owner did not accept', { setup: 'unaccepted' }, 4],
  ];

  it.each(refusals)('refuses a launch with %s, and makes no pane', async (_name, world, code) => {
    const made = await make(world);
    const result = await launch(made);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(exitCodeOf[result.error.kind]).toBe(code);
    expect(panesMade(made)).toEqual([]);
  });
});
