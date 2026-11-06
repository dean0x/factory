import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DIST = join(__dirname, '..', '..', 'dist', 'factory.js');

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Sandbox {
  /** The throw-away root. It holds the home of the test, the node and the projects. */
  readonly root: string;
  readonly node: string;
  readonly env: Readonly<Record<string, string>>;
  /** `input` is the text on the standard input of the program, and then the input ends. Without it, the input stays open. */
  run(
    args: readonly string[],
    options?: { cwd?: string; env?: Readonly<Record<string, string>>; input?: string },
  ): Promise<RunResult>;
  git(cwd: string, args: readonly string[]): Promise<RunResult>;
  /**
   * Make a git work tree at `<root>/<name>`. With an origin, the work tree gets that remote, and a clone of the origin
   * (with or without the user part of the URL) works offline: it reads a bare repo of the sandbox.
   */
  makeProject(name: string, origin?: string): Promise<string>;
  read(path: string): Promise<string>;
  remove(): Promise<void>;
}

const exec = (
  command: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
  input?: string,
): Promise<RunResult> =>
  new Promise((resolve) => {
    const child = execFile(command, [...args], { cwd, env, encoding: 'utf8', timeout: 60_000 }, (error, stdout, stderr) => {
      // A spawn error, a timeout or a signal has no numeric exit code. -1 is a value that no test expects.
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
      resolve({ code, stdout, stderr });
    });
    if (input !== undefined) {
      // A program that ends before it reads its input closes the pipe, and the write then fails. That is no fault of the test.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input);
    }
  });

/** A step of the setup. The sandbox fails closed: a step that does not exit with 0 stops the setup of the test. */
const must = async (step: Promise<RunResult>, what: string): Promise<RunResult> => {
  const result = await step;
  if (result.code !== 0) throw new Error(`sandbox: ${what} failed (${result.code}): ${result.stderr}`);
  return result;
};

/** The variable that tells a program it runs inside tmux. A command of the sandbox never gets it. */
const TMUX_VARIABLE = 'TMUX';

const withoutTmux = (values: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(values).filter(([name]) => name !== TMUX_VARIABLE));

/**
 * The folder that holds the tmux socket of a sandbox. It is short, because a socket path has at most 103 bytes on macOS.
 * Every command of the sandbox gets it as TMUX_TMPDIR, so no command reaches the tmux server of the user.
 */
const tmuxDirOf = (root: string): string => join(root, 'tmux');

/** The socket of the tmux server of a sandbox. A tmux that gets TMUX_TMPDIR puts its socket below `tmux-<uid>`. */
export const tmuxSocketOf = (root: string): string => join(tmuxDirOf(root), `tmux-${process.getuid?.() ?? 0}`, 'default');

/** What the fake agent prints for `--version` in every sandbox: the oldest version that has the messages between sessions. */
export const FAKE_AGENT_VERSION = '2.1.224 (Claude Code)';

/**
 * Write a program `claude` that prints `version` and ends, in a new folder `name` of the sandbox, and return the folder. A
 * test puts the folder at the start of PATH to run `--version` against another version. No test runs the real program.
 */
export const writeFakeAgent = async (root: string, name: string, version: string): Promise<string> => {
  const folder = join(root, name);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'claude'), `#!/bin/sh\necho '${version}'\n`);
  await chmod(join(folder, 'claude'), 0o755);
  return folder;
};

/** The notice that the yes flag prints: the change of the hook settings, with its target. */
const HOOK_NOTICE = /warning: This changes the settings of Claude Code in [^\n]*:\n(?: {2}[^\n]*\n)+/;

/** The text of stderr without the notice of the hook change. */
export const withoutHookNotice = (stderr: string): string => stderr.replace(HOOK_NOTICE, '');

/** The roots of the sandboxes that are not removed yet. */
const openRoots = new Set<string>();

// A program that stops late can still write a file while the folder is removed, so the removal tries again.
const removeRoot = async (root: string): Promise<void> => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  openRoots.delete(root);
};

/**
 * Removes every sandbox that is still open, for example after a hook failed before its test could remove the sandbox.
 * Each file of integration tests calls it in `afterAll`, so a failed run leaves no folder behind.
 */
export const removeOpenSandboxes = async (): Promise<void> => {
  await Promise.all([...openRoots].map(removeRoot));
};

/** A throw-away folder tree with its own HOME and git identity. The real HOME is never used. */
export const makeSandbox = async (): Promise<Sandbox> => {
  if (!existsSync(DIST)) throw new Error('dist/factory.js is missing: run "npm run build" first');
  const root = await mkdtemp(join(tmpdir(), 'factory-it-'));
  openRoots.add(root);
  try {
    return await buildSandbox(root);
  } catch (cause) {
    await removeRoot(root);
    throw cause;
  }
};

/** The URL of a repo without the user part: `https://user:token@host/path` is `https://host/path`. */
const withoutUser = (url: string): string => url.replace(/^([a-z+]+:\/\/)[^@/]*@/, '$1');

/**
 * Serve the origin of a project from the disk. A bare repo with one commit takes the place of the host, and git
 * reads it for the URL of the origin and for the same URL without its user part. No test needs a network.
 */
const serveOrigin = async (
  root: string,
  env: Readonly<Record<string, string>>,
  name: string,
  origin: string,
): Promise<void> => {
  const flat = name.replace(/[^A-Za-z0-9_.-]/g, '-');
  const bare = join(root, 'origins', `${flat}.git`);
  const seed = join(root, 'origin-seeds', flat);
  await mkdir(bare, { recursive: true });
  await mkdir(seed, { recursive: true });
  await must(exec('git', ['init', '-q', '--bare', '-b', 'main'], bare, env), 'git init --bare');
  await must(exec('git', ['init', '-q', '-b', 'main'], seed, env), 'git init (origin seed)');
  await must(exec('git', ['commit', '--allow-empty', '-q', '-m', 'first'], seed, env), 'git commit (origin seed)');
  await must(exec('git', ['push', '-q', bare, 'main'], seed, env), 'git push (origin seed)');
  for (const url of new Set([origin, withoutUser(origin)])) {
    await must(exec('git', ['config', '--global', '--add', `url.${bare}.insteadOf`, url], root, env), 'git config insteadOf');
  }
};

const buildSandbox = async (root: string): Promise<Sandbox> => {
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  await mkdir(tmuxDirOf(root), { recursive: true });
  await writeFile(
    join(home, '.gitconfig'),
    '[user]\n\tname = Test Owner\n\temail = test.owner@example.com\n[init]\n\tdefaultBranch = main\n',
  );
  const agentFolder = await writeFakeAgent(root, 'agent-bin', FAKE_AGENT_VERSION);
  const env: Record<string, string> = {
    PATH: `${agentFolder}:${process.env['PATH'] ?? ''}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GH_CONFIG_DIR: join(home, 'gh'),
    LANG: 'C',
    NO_COLOR: '1',
    npm_config_cache: join(home, 'npm-cache'),
    TMUX_TMPDIR: tmuxDirOf(root),
    // Git reads a local path only. A served origin is a local path after its insteadOf rewrite, which runs before this check.
    GIT_ALLOW_PROTOCOL: 'file',
    // Even when the protocol check is off, git starts no ssh, because ssh reads the keys of the real home folder.
    GIT_SSH_COMMAND: 'false',
    GIT_TERMINAL_PROMPT: '0',
  };
  return {
    root,
    node: join(root, 'node'),
    env,
    run: (args, options) =>
      exec('node', [DIST, ...args], options?.cwd ?? root, withoutTmux({ ...env, ...options?.env }), options?.input),
    git: (cwd, args) => exec('git', args, cwd, env),
    makeProject: async (name, origin) => {
      const path = join(root, name);
      await mkdir(path, { recursive: true });
      await must(exec('git', ['init', '-q', '-b', 'main'], path, env), 'git init');
      if (origin !== undefined) {
        await must(exec('git', ['remote', 'add', 'origin', origin], path, env), 'git remote add');
        await serveOrigin(root, env, name, origin);
      }
      return path;
    },
    read: (path) => readFile(path, 'utf8'),
    remove: () => removeRoot(root),
  };
};
