import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deps } from '../../src/core/deps.js';
import { requireStateConfigSafe, requireStateRepoReady } from '../../src/core/git.js';
import { createNodeDeps } from '../../src/core/node-deps.js';
import { commands } from '../../src/names.js';
import { makeSandbox, removeOpenSandboxes, type RunResult, type Sandbox } from './harness.js';

/**
 * The checks that run before a step changes the state repo, with real git in a scratch folder with its own HOME and git identity:
 * the git config check (a program that the config names must not start) and the ready check (the index holds no staged change).
 * The calls run in the test process, with the git of the scratch HOME.
 */

let box: Sandbox;
let stateDir: string;
let deps: Deps;

/** The time that the start of a test may take: the sandbox, the state repo and the first commit. */
const SETUP_TIMEOUT_MS = 30_000;

/** The names of the environment that make git read the scratch HOME and nothing else. The in-process calls need them. */
const GIT_ENV_NAMES = ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT'] as const;

const BOARD = 'board.json';

const git = (args: readonly string[]): Promise<RunResult> => box.git(stateDir, args);

const mustGit = async (args: readonly string[]): Promise<RunResult> => {
  const result = await git(args);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr}`);
  return result;
};

beforeEach(async () => {
  box = await makeSandbox();
  for (const name of GIT_ENV_NAMES) vi.stubEnv(name, box.env[name]);
  stateDir = join(box.root, 'node', '.factory');
  await mkdir(stateDir, { recursive: true });
  await mustGit(['init', '-q', '-b', 'main']);
  await writeFile(join(stateDir, BOARD), '{}\n');
  await mustGit(['add', '-A']);
  await mustGit(['commit', '-q', '-m', 'first']);
  deps = { ...createNodeDeps(), cwd: stateDir };
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  vi.unstubAllEnvs();
  await box.remove();
});

afterAll(removeOpenSandboxes);

describe('the ready check of the state repo with a staged submodule pointer (TP-9)', () => {
  const stageGitlink = async (): Promise<void> => {
    const head = (await mustGit(['rev-parse', 'HEAD'])).stdout.trim();
    await mustGit(['update-index', '--add', '--cacheinfo', `160000,${head},sub`]);
  };

  it('stops, and names the staged path, when the index holds a submodule pointer that the owner staged', async () => {
    await stageGitlink();
    const ready = await requireStateRepoReady(deps, stateDir, [BOARD], 'the upgrade', commands.upgrade);
    expect(ready).toMatchObject({ ok: false, error: { kind: 'failure', message: expect.stringContaining('has staged changes: sub') } });
  });

  it('passes when the index holds no staged change', async () => {
    expect(await requireStateRepoReady(deps, stateDir, [BOARD], 'the upgrade', commands.upgrade)).toEqual({ ok: true, value: undefined });
  });
});

describe('the git config check of a state repo whose config names a program (TP-16)', () => {
  const FILTER_FILE = 'attributes-filter.cfg';

  /** A program that git runs for a filter or a hook: it writes the marker file and passes its input on. */
  const writeProgram = async (name: string): Promise<{ readonly program: string; readonly marker: string }> => {
    const program = join(box.root, `${name}.sh`);
    const marker = join(box.root, `${name}.marker`);
    await writeFile(program, `#!/bin/sh\n: > '${marker}'\ncat\n`);
    await chmod(program, 0o755);
    return { program, marker };
  };

  const appendToLocalConfig = (text: string): Promise<void> => appendFile(join(stateDir, '.git', 'config'), text);

  it('stops with exit 4, names the key, and starts no program, for a filter in a file that the local config includes', async () => {
    const { program, marker } = await writeProgram('filter');
    const included = join(box.root, FILTER_FILE);
    await writeFile(included, `[filter "x"]\n\tclean = ${program}\n`);
    await appendToLocalConfig(`[include]\n\tpath = ${included}\n`);

    const checked = await requireStateConfigSafe(deps, stateDir, commands.upgrade);

    expect(checked).toMatchObject({ ok: false, error: { kind: 'safety', message: expect.stringContaining('filter.x.clean') } });
    expect(existsSync(marker), 'the filter program ran').toBe(false);

    // Control: git itself starts that program when a file matches the filter, so the marker proves the check kept it from running.
    await writeFile(join(stateDir, '.gitattributes'), '* filter=x\n');
    await writeFile(join(stateDir, 'notes.txt'), 'one\n');
    await mustGit(['add', 'notes.txt']);
    expect(existsSync(marker), 'the control did not start the filter program').toBe(true);
  });

  it('stops requireStateRepoReady with exit 4 before it reads the status, for a filter in an included file', async () => {
    const { program, marker } = await writeProgram('filter-ready');
    const included = join(box.root, FILTER_FILE);
    await writeFile(included, `[filter "x"]\n\tsmudge = ${program}\n`);
    await appendToLocalConfig(`[include]\n\tpath = ${included}\n`);
    await writeFile(join(stateDir, '.gitattributes'), '* filter=x\n');
    await writeFile(join(stateDir, 'notes.txt'), 'one\n');

    const ready = await requireStateRepoReady(deps, stateDir, [BOARD], 'the upgrade', commands.upgrade);

    expect(ready).toMatchObject({ ok: false, error: { kind: 'safety', message: expect.stringContaining('filter.x.smudge') } });
    expect(existsSync(marker), 'the filter program ran').toBe(false);
  });

  it('stops with exit 4, names the key, and starts no program, for a config hook in the local config', async () => {
    const { program, marker } = await writeProgram('hook');
    await appendToLocalConfig(`[hook "x"]\n\tevent = pre-commit\n\tcommand = ${program}\n`);

    const checked = await requireStateConfigSafe(deps, stateDir, commands.upgrade);

    expect(checked).toMatchObject({ ok: false, error: { kind: 'safety', message: expect.stringContaining('hook.x.command') } });
    expect(existsSync(marker), 'the hook program ran').toBe(false);
  });
});
