import { execFile, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { files, program } from '../../src/names.js';
import { stateRel } from '../../src/state/layout.js';
import { runInTerminal, scriptForm } from './fake-terminal.js';
import { DIST, makeSandbox, removeOpenSandboxes, type RunResult, type Sandbox } from './harness.js';

/**
 * No command needs python3, jq or glow (AC-21). The built program runs with a PATH of one folder. The folder holds links to
 * node, git, sh, grep, script and tmux, and to nothing else. `init`, `item`, `track`, `request`, `queue` and `status` must work,
 * and so must `decide` in a fake terminal, and a manual commit that the delete guard reads.
 */

/** The programs that the PATH of the test holds. */
const TOOLS = ['node', 'git', 'sh', 'grep', 'script', 'tmux'] as const;

/** Programs that the PATH of the test must not hold. */
const ABSENT_TOOLS = ['python3', 'python', 'jq', 'glow'] as const;

/** The time that a case may take: `init`, a run of the program for each command, and the git commands. */
const CASE_MS = 120_000;
const PROBE_MS = 20_000;
/** The bounds of a run in the fake terminal: the wait for one prompt and the whole run. */
const PROMPT_MS = 15_000;
const TOTAL_MS = 90_000;

/** The path of a program on the PATH of this process, or null. The node of this process is the node of the test. */
const findTool = (name: string): string | null => {
  if (name === 'node') return process.execPath;
  for (const folder of (process.env['PATH'] ?? '').split(delimiter)) {
    if (folder === '') continue;
    const candidate = join(folder, name);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // The program is not in this folder.
    }
  }
  return null;
};

const located = TOOLS.map((name) => [name, findTool(name)] as const);
const missing = located.filter(([, path]) => path === null).map(([name]) => name);
const tmuxVersion = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).stdout ?? '';
const [major = 0] = (/(\d+)\./.exec(tmuxVersion)?.slice(1) ?? []).map(Number);
const hasTools = missing.length === 0 && major >= 3;
if (!hasTools) {
  console.warn(
    `no-python.test.ts is skipped: ${missing.length > 0 ? `${missing.join(', ')} not installed` : 'tmux 3.0 or newer is not installed'}.`,
  );
}

const BOARD_BLOCK = ['board:', '  states: [open, doing, done]', '  in_progress: doing', '  closed: done', ''].join('\n');

let box: Sandbox;
/** The one folder that the PATH of the test names. */
let bin: string;

const restricted = (): Record<string, string> => ({ ...box.env, PATH: bin });

/** A command of the program with the restricted PATH, for the home of the test. */
const factory = (args: readonly string[]): Promise<RunResult> => box.run([...args, '--home', box.node], { env: { PATH: bin } });

/** A run that must exit 0. */
const mustRun = async (args: readonly string[]): Promise<RunResult> => {
  const result = await factory(args);
  expect(result.code, `${args.join(' ')}: ${result.stderr}`).toBe(0);
  return result;
};

/** The git of the restricted folder, with the restricted PATH. A hook that git starts gets the same PATH. */
const restrictedGit = (cwd: string, args: readonly string[]): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(join(bin, 'git'), [...args], { cwd, env: restricted(), encoding: 'utf8', timeout: PROBE_MS * 3 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr });
    });
  });

const stateDir = (): string => join(box.node, '.factory');

const commitCount = async (): Promise<number> => Number((await restrictedGit(stateDir(), ['rev-list', '--count', 'HEAD'])).stdout.trim());

const headId = async (): Promise<string> => (await restrictedGit(stateDir(), ['rev-parse', 'HEAD'])).stdout.trim();

/** A node made by `init` with the restricted PATH, and a `board` block that declares the item states. */
const makeNode = async (): Promise<void> => {
  const project = await box.makeProject('web');
  expect((await box.git(project, ['commit', '--allow-empty', '-q', '-m', 'first'])).code).toBe(0);
  const made = await factory(['init', '--yes', '--name', 'demo', '--owner-name', 'Test Owner', '--project', project]);
  expect(made.code, made.stderr).toBe(0);
  const config = join(box.node, files.config);
  const text = await readFile(config, 'utf8');
  await writeFile(config, `${text}${text.endsWith('\n') ? '' : '\n'}${BOARD_BLOCK}`);
};

/** The error code of a start of a program with the restricted PATH: ENOENT when the PATH holds no such program. */
const startCode = (name: string): Promise<string | number | null> =>
  new Promise((resolve) => {
    execFile(name, ['--version'], { env: { PATH: bin }, timeout: PROBE_MS }, (error) => {
      resolve(error === null ? 0 : (error.code ?? null));
    });
  });

afterAll(removeOpenSandboxes);

describe.skipIf(!hasTools)('the commands with a PATH of node, git, sh, grep, script and tmux only (built binary, AC-21)', () => {
  beforeEach(async () => {
    box = await makeSandbox();
    bin = join(box.root, 'restricted-bin');
    await mkdir(bin, { recursive: true });
    for (const [name, path] of located) {
      if (path !== null) await symlink(path, join(bin, name));
    }
  }, CASE_MS);

  afterEach(async () => {
    await box.remove();
  });

  it(
    'M5-1b TP-49 holds the six programs in the folder of the PATH, and finds none of python3, jq and glow',
    async () => {
      expect((await readdir(bin)).sort()).toEqual([...TOOLS].sort());
      for (const name of ABSENT_TOOLS) expect(await startCode(name), name).toBe('ENOENT');
    },
    CASE_MS,
  );

  it(
    'M5-1b TP-49 runs init, track, item, request, queue and status, and each write makes one state commit',
    async () => {
      await makeNode();
      const before = await commitCount();

      await mustRun(['track', 'add', 'core', '--name', 'Core']);
      await mustRun(['item', 'add', '--title', 'First item', '--track', 'core']);
      await mustRun(['request', 'add', '--title', 'Pick', '--question', 'Which?', '--option', 'a=Yes']);
      await mustRun(['queue', 'set', 'Docs', '--item', 'B-1']);
      expect(await commitCount()).toBe(before + 4);

      expect((await mustRun(['track', 'list'])).stdout).toContain('Core');
      expect((await mustRun(['item', 'list'])).stdout).toContain('First item');
      expect((await mustRun(['request', 'list'])).stdout).toContain('Pick');
      expect((await mustRun(['queue', 'show'])).stdout).toContain('Docs');
      const status = JSON.parse((await mustRun(['status', '--json'])).stdout) as { schema: string; running: boolean; workers: unknown[] };
      expect(status).toMatchObject({ schema: 'factory.status/v1', running: false, workers: [] });
    },
    CASE_MS,
  );

  it.skipIf(scriptForm() === null)(
    'M5-1b TP-162 records the answer of decide in a fake terminal, with the PATH of the six programs only',
    async () => {
      await makeNode();
      await mustRun(['request', 'add', '--title', 'Pick', '--question', 'Which?', '--option', 'a=Yes', '--option', 'b=No']);
      const before = await commitCount();

      const result = await runInTerminal(box, [process.execPath, DIST, 'decide', 'D-1', 'a', '--home', box.node], {
        env: { PATH: bin },
        exchanges: [{ prompt: /Record the answer a for D-1\? \[y\/N\] $/, answer: 'y' }],
        promptMs: PROMPT_MS,
        totalMs: TOTAL_MS,
      });

      expect(result.code, result.screen).toBe(0);
      expect(result.screen).toContain('Recorded the answer a for D-1: Pick');
      expect(await commitCount()).toBe(before + 1);
      const decisions = await readdir(join(stateDir(), stateRel.profileDecisions));
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatch(/^\d{4}-\d{2}-\d{2}-d-1-pick\.md$/);
      expect(existsSync(join(box.env['HOME'] ?? '', '.local', 'state', program, files.ownerDecisions))).toBe(true);
    },
    CASE_MS,
  );

  it(
    'M5-1b TP-49 passes a manual commit that keeps every item id, and stops a manual commit that removes an item id',
    async () => {
      await makeNode();
      await mustRun(['item', 'add', '--title', 'One']);
      await mustRun(['item', 'add', '--title', 'Two']);
      const board = join(stateDir(), files.board);
      const parsed = JSON.parse(await readFile(board, 'utf8')) as { items: { id: string; title: string }[] };
      expect(parsed.items.map((item) => item.id)).toEqual(['B-1', 'B-2']);

      const before = await commitCount();
      const renamed = { ...parsed, items: parsed.items.map((item) => ({ ...item, title: `${item.title} by hand` })) };
      await writeFile(board, `${JSON.stringify(renamed, null, 2)}\n`);
      expect((await restrictedGit(stateDir(), ['add', files.board])).code).toBe(0);
      const kept = await restrictedGit(stateDir(), ['commit', '-q', '-m', 'manual: keep the ids']);
      expect(kept.code, kept.stderr).toBe(0);
      expect(await commitCount()).toBe(before + 1);

      const head = await headId();
      await writeFile(board, `${JSON.stringify({ ...parsed, items: parsed.items.slice(0, 1) }, null, 2)}\n`);
      expect((await restrictedGit(stateDir(), ['add', files.board])).code).toBe(0);
      const lost = await restrictedGit(stateDir(), ['commit', '-q', '-m', 'manual: drop an id']);
      expect(lost.code).not.toBe(0);
      expect(lost.stderr).toContain('B-2');
      expect(lost.stderr).toContain('Mark an item closed, never remove it.');
      expect(await headId()).toBe(head);
    },
    CASE_MS,
  );
});
