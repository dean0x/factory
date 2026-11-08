import { execFile, spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect } from 'vitest';
import { DIST, makeSandbox, removeOpenSandboxes, tmuxSocketOf, type RunResult, type Sandbox } from './harness.js';

/**
 * The setup that the files of `shutdown`, `restart`, `reboot` and `status` share: a throw-away node, a separate tmux server, a fake program
 * for `claude`, and a node with a session, two workers and a session line for each of them.
 */

const tmuxVersion = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).stdout ?? '';
const [tmuxMajor = 0] = (/(\d+)\./.exec(tmuxVersion)?.slice(1) ?? []).map(Number);
export const hasTmux = tmuxMajor >= 3;

const POLL_STEP_MS = 100;
const POLL_STEPS = 100;
const STOP_STEPS = 30;
/** A fake value for the one setting of the user that the launch keeps among the variables that start with CLAUDE. */
const FAKE_CONFIG_DIR = '/fake/claude-config';
/** A proxy in the environment of the tmux server. A launch must remove it, so that the program never sees it. */
const LAB_PROXY_URL = 'http://127.0.0.1:9';

/**
 * The time limit of a case: the setup makes two workers (about ten seconds), a stop waits up to 30 seconds for the end of a process
 * (`stopPoll`), and a launch waits up to 10 seconds for its new session (`launchConfirm`). The limit of the suite (30 seconds) can
 * not cover the bounded waits of one case.
 */
export const LIFECYCLE_CASE_MS = 240_000;

export const SESSIONS = {
  alpha: '5d8e2c1a-7f3b-4a96-8c4d-0e1f2a3b4c5d',
  beta: '7a1b9c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  demo: '0b6c1f9e-2d3a-4b5c-8d7e-9f0a1b2c3d4e',
} as const;

export type Marker = keyof typeof SESSIONS;

/**
 * The rule of every launch, new or resumed: the program starts in auto mode, no flag skips the permission checks, and the proxy
 * variable of the tmux server did not reach it (`proxy` is the text of its `proxy-<marker>` file). The flag of the mode comes once,
 * in the form with a separate value, so a later flag can not change the mode. A path is not a flag, so a word that starts with a
 * slash is not read for a skip word.
 */
export const expectLaunchRule = (argv: readonly string[], proxy: string): void => {
  expect(argv.filter((word) => word === '--permission-mode' || word.startsWith('--permission-mode='))).toHaveLength(1);
  const mode = argv.indexOf('--permission-mode');
  expect(mode).toBeGreaterThanOrEqual(0);
  expect(argv[mode + 1]).toBe('auto');
  expect(argv.filter((word) => !word.startsWith('/') && /dangerously|bypass|skip/i.test(word))).toEqual([]);
  expect(proxy).toBe('no');
};

/**
 * A fake claude. The names of its files end with the session marker: `proxy-<marker>` says `yes` when the environment of the last launch
 * holds the proxy variable and `no` when it does not, `argv-<marker>` holds the arguments of the last launch, and
 * `launches-<marker>` has one line for each launch that ran on. A launch with `--resume <id>` acts like the program: the hook of the
 * new session writes its last-seen line. A launch whose marker has a file `record-term-<marker>` in the folder records the signal TERM in
 * `termed-<marker>` and ends with the code 143. A hang-up ends it too, but records nothing. The file `proxy-<marker>` comes first, so a
 * wait for any other file of the launch also covers it.
 */
const fakeClaude = (dir: string): string =>
  [
    '#!/bin/sh',
    `dir='${dir}'`,
    'if [ -n "${ANTHROPIC_BASE_URL+x}" ]; then echo yes > "$dir/proxy-$FACTORY_SESSION"; else echo no > "$dir/proxy-$FACTORY_SESSION"; fi',
    'printf \'%s\\n\' "$@" > "$dir/argv-$FACTORY_SESSION"',
    'resume=""',
    'prev=""',
    'for arg in "$@"; do',
    '  if [ "$prev" = "--resume" ]; then resume="$arg"; fi',
    '  prev="$arg"',
    'done',
    'if [ -n "$resume" ]; then',
    `  printf '{"session_id":"%s","hook_event_name":"SessionStart"}' "$resume" | '${process.execPath}' '${DIST}' hook SessionStart`,
    'fi',
    'if [ -e "$dir/record-term-$FACTORY_SESSION" ]; then',
    `  trap 'echo termed >> "$dir/termed-$FACTORY_SESSION"; kill "$child"; exit 143' TERM`,
    '  sleep 300 &',
    '  child=$!',
    '  echo launched >> "$dir/launches-$FACTORY_SESSION"',
    '  wait "$child"',
    '  exit 0',
    'fi',
    'echo launched >> "$dir/launches-$FACTORY_SESSION"',
    'exec sleep 300',
    '',
  ].join('\n');

export interface PaneFact {
  readonly pane: string;
  readonly pid: number;
  readonly dead: boolean;
  readonly worker: string;
}

export interface NodeOptions {
  /** The markers that get a SessionStart line, as the hook of the program writes it. Default: every marker. */
  readonly sessions?: readonly Marker[];
}

export interface Lab {
  readonly box: Sandbox;
  readonly outDir: string;
  tmux(args: readonly string[]): Promise<RunResult>;
  /** Runs `factory <command> --home <node> <rest>` with the environment of the tmux server. */
  factory(command: string, rest?: readonly string[], env?: Readonly<Record<string, string>>): Promise<RunResult>;
  /** Makes the node: the config, the clone of one project and the settings of the coordinator. It starts nothing. */
  init(): Promise<void>;
  /** Makes the node, starts its session and makes the workers alpha and beta. Each marker of `sessions` gets its session line. */
  node(options?: NodeOptions): Promise<void>;
  /** Writes the SessionStart line of a session, as the hook of the program does. */
  sessionStarted(marker: Marker): Promise<RunResult>;
  /** One hook event of a session, as Claude Code sends it. `UserPromptSubmit` makes the session busy. */
  event(marker: Marker, name: string): Promise<RunResult>;
  waitForFile(name: string): Promise<string>;
  argvOf(marker: Marker): Promise<readonly string[]>;
  /** `yes` or `no`: whether the environment of the last launch with this session marker held the proxy variable. */
  proxyOf(marker: Marker): Promise<string>;
  /** How many times the program ran with this session marker. */
  launchCount(marker: Marker): Promise<number>;
  /** The panes that carry a worker mark in the window workers. */
  workerPanes(): Promise<readonly PaneFact[]>;
  livePaneOf(id: string): Promise<PaneFact | undefined>;
  /** The id of the pane of the coordinator. */
  coordinatorPane(): Promise<string>;
  /** A session of another tmux user on the same server, with the fake program in its pane. The value is its pane pid. */
  bystander(): Promise<number>;
  hasSession(name: string): Promise<boolean>;
  /** The state repo of the node. */
  stateOf(): string;
  pointerOf(id: string): string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True while the process runs. The rule is the rule of the product (`isRunning`): `kill -0` must pass, and `ps` must not show
 * the state Z. A `ps` that fails or prints an unclear state counts as alive, so the check never passes a live process.
 */
export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 });
  return !(ps.status === 0 && /^Z/.test(ps.stdout.trim()));
};

/** Waits until a process ends. The wait has an upper bound. */
export const waitUntilEnded = async (pid: number): Promise<boolean> => {
  for (let step = 0; step < STOP_STEPS && isAlive(pid); step += 1) await sleep(POLL_STEP_MS);
  return !isAlive(pid);
};

const factFrom = (line: string): PaneFact => {
  const [pane = '', pid = '', dead = '', worker = ''] = line.split(' ');
  return { pane, pid: Number(pid), dead: dead === '1', worker };
};

/**
 * Registers the hooks of one file of tests: a new sandbox and a new tmux server for each test, and the removal of both after it.
 * The file calls it once, at the top level.
 */
export const useLab = (): Lab => {
  let box: Sandbox | undefined;
  let tmuxEnv: Record<string, string> = {};
  let outDir = '';

  const sandbox = (): Sandbox => {
    if (box === undefined) throw new Error('the lab has no sandbox outside a test');
    return box;
  };

  const tmux = (args: readonly string[]): Promise<RunResult> =>
    new Promise((resolve) => {
      execFile('tmux', [...args], { env: tmuxEnv, encoding: 'utf8', timeout: 20_000 }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr });
      });
    });

  const stopServer = async (): Promise<void> => {
    const socket = tmuxSocketOf(sandbox().root);
    await tmux(['-S', socket, 'kill-server']);
    for (let step = 0; step < STOP_STEPS; step += 1) {
      if ((await tmux(['-S', socket, 'list-sessions'])).code !== 0) return;
      await sleep(POLL_STEP_MS);
    }
  };

  beforeEach(async () => {
    const made = await makeSandbox();
    box = made;
    outDir = join(made.root, 'out');
    const bin = join(made.root, 'bin');
    await mkdir(outDir, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'claude'), fakeClaude(outDir));
    await chmod(join(bin, 'claude'), 0o755);
    // A separate tmux server: the harness sets TMUX_TMPDIR to a folder of the sandbox and gives no TMUX.
    tmuxEnv = {
      ...made.env,
      SHELL: '/bin/sh',
      PATH: `${bin}:${made.env['PATH'] ?? ''}`,
      ANTHROPIC_BASE_URL: LAB_PROXY_URL,
      CLAUDE_FAKE_PARENT: '1',
      CLAUDECODE: '1',
      CLAUDE_CONFIG_DIR: FAKE_CONFIG_DIR,
    };
  });

  afterEach(async () => {
    try {
      // Stop the server of this test only: both the folder and the socket name this server.
      if (hasTmux && box !== undefined && tmuxEnv['TMUX_TMPDIR']?.startsWith(box.root) === true) await stopServer();
    } finally {
      await box?.remove();
    }
  });

  afterAll(removeOpenSandboxes);

  const waitForFile = async (name: string): Promise<string> => {
    for (let step = 0; step < POLL_STEPS; step += 1) {
      const text = await readFile(join(outDir, name), 'utf8').catch(() => '');
      if (text !== '') return text;
      await sleep(POLL_STEP_MS);
    }
    throw new Error(`the file ${name} did not appear`);
  };

  const factory = (command: string, rest: readonly string[] = [], env: Readonly<Record<string, string>> = {}): Promise<RunResult> =>
    sandbox().run([command, '--home', sandbox().node, ...rest], { env: { ...tmuxEnv, ...env } });

  const init = async (): Promise<void> => {
    const current = sandbox();
    const source = await current.makeProject('web');
    expect((await current.git(source, ['commit', '--allow-empty', '-q', '-m', 'first'])).code).toBe(0);
    const made = await current.run(
      ['init', '--yes', '--home', current.node, '--name', 'demo', '--owner-name', 'Test Owner', '--project', source],
      { env: tmuxEnv },
    );
    expect(made.code, made.stderr).toBe(0);
  };

  const event = (marker: Marker, name: string): Promise<RunResult> =>
    sandbox().run(['hook', name], {
      cwd: sandbox().node,
      env: { FACTORY_HOME: sandbox().node, FACTORY_SESSION: marker },
      input: JSON.stringify({ session_id: SESSIONS[marker], hook_event_name: name }),
    });

  const sessionStarted = (marker: Marker): Promise<RunResult> => event(marker, 'SessionStart');

  const node = async (options: NodeOptions = {}): Promise<void> => {
    await init();
    const started = await factory('start');
    expect(started.code, started.stderr).toBe(0);
    await waitForFile('launches-demo');
    for (const id of ['alpha', 'beta']) {
      const made = await sandbox().run(['worker', 'new', '--home', sandbox().node, id, '--project', 'web', '--yes'], { env: tmuxEnv });
      expect(made.code, made.stderr).toBe(0);
      await waitForFile(`launches-${id}`);
    }
    for (const marker of options.sessions ?? (['alpha', 'beta', 'demo'] as const)) {
      expect((await sessionStarted(marker)).code).toBe(0);
    }
  };

  const workerPanes = async (): Promise<readonly PaneFact[]> =>
    (await tmux(['list-panes', '-t', '=demo:workers', '-F', '#{pane_id} #{pane_pid} #{pane_dead} #{@worker}'])).stdout
      .split('\n')
      .filter((line) => line !== '')
      .map(factFrom)
      .filter((fact) => fact.worker !== '');

  return {
    get box() {
      return sandbox();
    },
    get outDir() {
      return outDir;
    },
    tmux,
    factory,
    init,
    node,
    sessionStarted,
    event,
    waitForFile,
    argvOf: async (marker) => (await readFile(join(outDir, `argv-${marker}`), 'utf8')).trim().split('\n'),
    proxyOf: async (marker) => (await waitForFile(`proxy-${marker}`)).trim(),
    launchCount: async (marker) =>
      (await readFile(join(outDir, `launches-${marker}`), 'utf8').catch(() => '')).split('\n').filter((line) => line !== '').length,
    workerPanes,
    livePaneOf: async (id) => (await workerPanes()).find((fact) => fact.worker === id && !fact.dead),
    coordinatorPane: async () => {
      const lines = (await tmux(['list-panes', '-t', '=demo:view', '-F', '#{pane_id} #{@slot}'])).stdout.split('\n');
      return lines.find((line) => line !== '' && !line.endsWith(' board'))?.split(' ')[0] ?? '';
    },
    bystander: async () => {
      const made = await tmux(['new-session', '-d', '-s', 'bystander', '-P', '-F', '#{pane_pid}', join(sandbox().root, 'bin', 'claude')]);
      expect(made.code, made.stderr).toBe(0);
      return Number(made.stdout.trim());
    },
    hasSession: async (name) => (await tmux(['has-session', '-t', `=${name}`])).code === 0,
    stateOf: () => join(sandbox().node, '.factory'),
    pointerOf: (id) => join(sandbox().node, '.factory', 'workers', id, 'last-session'),
  };
};
