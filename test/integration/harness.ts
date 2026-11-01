import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  run(args: readonly string[], options?: { cwd?: string; env?: Readonly<Record<string, string>> }): Promise<RunResult>;
  git(cwd: string, args: readonly string[]): Promise<RunResult>;
  makeProject(name: string, origin?: string): Promise<string>;
  read(path: string): Promise<string>;
  remove(): Promise<void>;
}

const exec = (
  command: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(command, [...args], { cwd, env, encoding: 'utf8', timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code, stdout, stderr });
    });
  });

/** A throw-away folder tree with its own HOME and git identity. The real HOME is never used. */
export const makeSandbox = async (): Promise<Sandbox> => {
  if (!existsSync(DIST)) throw new Error('dist/factory.js is missing: run "npm run build" first');
  const root = await mkdtemp(join(tmpdir(), 'factory-it-'));
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, '.gitconfig'),
    '[user]\n\tname = Test Owner\n\temail = test.owner@example.com\n[init]\n\tdefaultBranch = main\n',
  );
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GH_CONFIG_DIR: join(home, 'gh'),
    LANG: 'C',
    NO_COLOR: '1',
    npm_config_cache: join(home, 'npm-cache'),
  };
  return {
    root,
    node: join(root, 'node'),
    env,
    run: (args, options) => exec('node', [DIST, ...args], options?.cwd ?? root, { ...env, ...options?.env }),
    git: (cwd, args) => exec('git', args, cwd, env),
    makeProject: async (name, origin) => {
      const path = join(root, name);
      await mkdir(path, { recursive: true });
      await exec('git', ['init', '-q', '-b', 'main'], path, env);
      if (origin !== undefined) await exec('git', ['remote', 'add', 'origin', origin], path, env);
      return path;
    },
    read: (path) => readFile(path, 'utf8'),
    remove: () => rm(root, { recursive: true, force: true }),
  };
};
