import { describe, expect, it } from 'vitest';
import { exitCodeOf, type CliError, type CliResult } from '../../src/cli/errors.js';
import { launchArgv, workerLaunchArgv } from '../../src/launch/argv.js';
import { layoutOf } from '../../src/state/layout.js';
import { readCoordinatorPane, requireCoordinatorCaller } from '../../src/workers/panes.js';
import { createFakeDeps, exited, type RunHandler } from '../helpers/fake-deps.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { tmuxHandler, type TmuxFixture } from '../helpers/tmux-fake.js';

const HOME = '/w/node';
const NODE = 'demo';
/** The coordinator pane of a session of the fixture: the first pane of the view window. */
const COORDINATOR_PANE = '%0';
const SLOT_PANE = '%1';
/** The command that the caller runs again, without the program name. */
const AGAIN = 'worker reset alpha --clear';

const session = { effort: 'high', model: 'default', proxyBaseUrl: null, path: '/bin', agent: 'claude' } as const;

/** The argument list of the launch of the coordinator of the node, with the changes of a test. */
const launchWords = (more: { home?: string; sessionId?: string; stateDir?: string } = {}): readonly string[] => {
  const home = more.home ?? HOME;
  const argv = launchArgv({
    ...session,
    home,
    coordinatorDir: `${home}/coordinator`,
    stateDir: more.stateDir ?? layoutOf(home).stateDir,
    sessionId: more.sessionId ?? NODE,
    projects: [],
  });
  if (!argv.ok) throw new Error(argv.error);
  return argv.value;
};

/** Answers some calls itself and passes the others to the fake tmux. */
type Wrap = (handler: RunHandler) => RunHandler;

interface Setup {
  readonly fixture?: TmuxFixture;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly wrap?: Wrap;
}

const setup = (more: Setup = {}) => {
  const { handler, log } = tmuxHandler({
    sessions: { [NODE]: HOME },
    coordinatorCommands: { [NODE]: launchWords() },
    ...more.fixture,
  });
  const deps = createFakeDeps({
    run: more.wrap === undefined ? handler : more.wrap(handler),
    env: { TMUX_PANE: COORDINATOR_PANE, FACTORY_SESSION: NODE, ...more.env },
  });
  const check = (home = HOME) => requireCoordinatorCaller(deps, home, sampleConfig(), AGAIN);
  return { deps, log, check };
};

const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('expected a refusal, but the caller passed');
  return result.error;
};

const codeOf = <T>(result: CliResult<T>): number => exitCodeOf[errorOf(result).kind];

/** The read of the coordinator pane gets this answer from tmux, and every other call goes to the fake. */
const coordinatorReadAnswers =
  (answer: ReturnType<typeof exited>): Wrap =>
  (handler) =>
  (call) =>
    call.args[0] === 'display-message' && call.args.some((arg) => arg.includes('{left}')) ? answer : handler(call);

describe('TP-18: the caller rule lets the coordinator pane pass', () => {
  it('TP-18: gives the coordinator pane with its pid for a caller in that pane', async () => {
    const { check, log } = setup();
    const result = await check();
    expect(result).toMatchObject({ ok: true, value: { paneId: COORDINATOR_PANE, node: true, dead: false } });
    expect(log.typed()).toEqual([]);
  });
});

describe('TP-18: the env part of the caller rule makes no tmux call', () => {
  it.each([
    ['no TMUX_PANE', { TMUX_PANE: undefined }],
    ['an empty TMUX_PANE', { TMUX_PANE: '' }],
    ['a TMUX_PANE that is not a pane id', { TMUX_PANE: 'coordinator' }],
    ['a TMUX_PANE with a second command in it', { TMUX_PANE: '%0;' }],
  ])('TP-18: a caller with %s exits 2', async (_name, env) => {
    const { check, deps } = setup({ env });
    expect(codeOf(await check())).toBe(2);
    expect(deps.calls).toEqual([]);
  });

  it.each([
    ['the id of a worker', { FACTORY_SESSION: 'alpha' }],
    ['no FACTORY_SESSION', { FACTORY_SESSION: undefined }],
    ['an empty FACTORY_SESSION', { FACTORY_SESSION: '' }],
  ])('TP-18: a caller with %s as its session exits 2', async (_name, env) => {
    const { check, deps } = setup({ env });
    expect(codeOf(await check())).toBe(2);
    expect(deps.calls).toEqual([]);
  });

  it('TP-18: the env part comes first: a caller in a worker pane exits 2 also when no session runs', async () => {
    const { check, deps } = setup({ fixture: { sessions: {} }, env: { FACTORY_SESSION: 'alpha', TMUX_PANE: '%5' } });
    expect(codeOf(await check())).toBe(2);
    expect(deps.calls).toEqual([]);
  });

  it('TP-18: the refusal names the coordinator pane as the place to run the command again', async () => {
    const { check } = setup({ env: { FACTORY_SESSION: 'alpha' } });
    const error = errorOf(await check());
    expect(error.message).toContain('coordinator');
    expect(error.hint).toContain(`factory ${AGAIN}`);
  });

  it('TP-18: the remedy of every refusal names the command to run again', async () => {
    for (const change of [{ env: { TMUX_PANE: SLOT_PANE } }, { fixture: { sessions: {} } }, { fixture: { endedCoordinators: [NODE] } }]) {
      const error = errorOf(await setup(change).check());
      expect(error.hint).toContain(`factory ${AGAIN}`);
    }
  });
});

describe('TP-18: the session part of the caller rule', () => {
  it('TP-18: no tmux session exits 3 and the remedy is factory start', async () => {
    const { check } = setup({ fixture: { sessions: {} } });
    const result = await check();
    expect(codeOf(result)).toBe(3);
    expect(errorOf(result).hint).toContain('factory start');
  });

  it('TP-18: a session of another factory folder exits 4', async () => {
    const { check } = setup({ fixture: { sessions: { [NODE]: '/other/node' } } });
    expect(codeOf(await check())).toBe(4);
  });
});

describe('TP-18: the pane part of the caller rule', () => {
  it('TP-18: a coordinator pane that ended exits 3 and the remedy is factory start', async () => {
    const { check } = setup({ fixture: { endedCoordinators: [NODE] } });
    const result = await check();
    expect(codeOf(result)).toBe(3);
    expect(errorOf(result).hint).toContain('factory start');
  });

  it.each([
    ['tmux has no pane at the place of the coordinator (empty fields, exit 0)', exited(0, '|||\n')],
    ['tmux fails for the place of the coordinator', exited(1, '', "can't find pane\n")],
    ['the pane at that place has no node mark', exited(0, '%0|4001|0|0|env FACTORY_SESSION=demo\n')],
  ])('TP-18: %s: exit 3 and the remedy is factory start', async (_name, answer) => {
    const { check } = setup({ wrap: coordinatorReadAnswers(answer) });
    const result = await check();
    expect(codeOf(result)).toBe(3);
    expect(errorOf(result).hint).toContain('factory start');
  });

  it('TP-18: text that is not the line of one pane is a failure (exit 1), not a pass', async () => {
    const { check } = setup({ wrap: coordinatorReadAnswers(exited(0, 'zzz-odd-output\n')) });
    expect(codeOf(await check())).toBe(1);
  });

  it.each([
    ['a pane that runs the shell', []],
    ['a program that is not the launch', ['sleep', '3000']],
    ['the launch of a coordinator of another node', launchWords({ sessionId: 'other' })],
    ['the launch of a coordinator in another factory folder', launchWords({ home: '/other/node' })],
    ['the launch of a coordinator with another state folder', launchWords({ stateDir: '/w/node/.factory/other' })],
    [
      'the launch of a worker, also when its id is the id of the node',
      (() => {
        const argv = workerLaunchArgv({ ...session, home: HOME, nodeId: NODE, workerId: NODE });
        if (!argv.ok) throw new Error(argv.error);
        return argv.value;
      })(),
    ],
  ])('TP-18: a start command that is %s exits 4 and types nothing', async (_name, words) => {
    const { check, log } = setup({ fixture: { coordinatorCommands: { [NODE]: words } } });
    const result = await check();
    expect(codeOf(result)).toBe(4);
    expect(errorOf(result).hint).toBeDefined();
    expect(log.typed()).toEqual([]);
  });

  it('TP-18: the refusal for a start command names no text of the start command', async () => {
    const secret = 'PROXY-SECRET-TEXT';
    const { check } = setup({ fixture: { coordinatorCommands: { [NODE]: ['env', `TOKEN=${secret}`, 'claude'] } } });
    const error = errorOf(await check());
    expect(`${error.message} ${error.hint ?? ''}`).not.toContain(secret);
  });

  it('TP-18: a caller in another pane of the session exits 2', async () => {
    const { check, log } = setup({ env: { TMUX_PANE: SLOT_PANE } });
    expect(codeOf(await check())).toBe(2);
    expect(log.typed()).toEqual([]);
  });

  it('TP-18: a caller in a worker pane that has its own session word exits 2 before any tmux call', async () => {
    const { check, deps } = setup({ env: { TMUX_PANE: '%2', FACTORY_SESSION: 'alpha' } });
    expect(codeOf(await check())).toBe(2);
    expect(deps.calls).toEqual([]);
  });

  it('TP-18: the checks of the coordinator pane come before the check of the caller pane: a start command that does not bind is exit 4 for a caller in another pane', async () => {
    const { check } = setup({ env: { TMUX_PANE: SLOT_PANE }, fixture: { coordinatorCommands: { [NODE]: ['sleep', '3000'] } } });
    expect(codeOf(await check())).toBe(4);
  });
});

describe('TP-19: the readers of the coordinator pane keep their behavior', () => {
  it('TP-19: reads the pane that carries the node mark, with its start command', async () => {
    const { deps } = setup();
    const result = await readCoordinatorPane(deps, NODE);
    expect(result).toMatchObject({ ok: true, value: { paneId: COORDINATOR_PANE, node: true, dead: false } });
  });

  it('TP-19: gives null for a place with no pane and for a pane with no node mark', async () => {
    const absent = setup({ wrap: coordinatorReadAnswers(exited(0, '|||\n')) });
    expect(await readCoordinatorPane(absent.deps, NODE)).toEqual({ ok: true, value: null });
    const unmarked = setup({ wrap: coordinatorReadAnswers(exited(0, '%0|4001|0|0|\n')) });
    expect(await readCoordinatorPane(unmarked.deps, NODE)).toEqual({ ok: true, value: null });
  });
});
