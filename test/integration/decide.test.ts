import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { files, program, stateGuard } from '../../src/names.js';
import { stateRel } from '../../src/state/layout.js';
import { runInTerminal, scriptGate, type Exchange } from './fake-terminal.js';
import { DIST, makeSandbox, removeOpenSandboxes, type RunResult, type Sandbox } from './harness.js';

/**
 * `factory decide` with the built program and real git, in a scratch folder with its own HOME and git identity. The node is made by
 * `init`, so the state repo, its delete guard and its board files are the ones that a user gets. The owner answers in a fake terminal:
 * the command needs a terminal window for input and for output, and it asks one question.
 */

const gate = scriptGate();
if (gate === 'skip') console.warn('decide.test.ts is skipped: the program script is not installed.');

let box: Sandbox;

/** The bounds of a run in the fake terminal: the wait for one prompt, the whole run, and the time limit of a case. */
const PROMPT_MS = 15_000;
const TOTAL_MS = 90_000;
const CASE_MS = 120_000;

const BOARD_BLOCK = ['board:', '  states: [open, doing, done]', '  in_progress: doing', '  closed: done', ''].join('\n');

const BOARD_FILES = [files.board, files.waiting, files.decisionLog];

/** The question of decide for the request that the cases ask. */
const QUESTION = /Record the answer a for D-1\? \[y\/N\] $/;

const stateDir = (): string => join(box.node, '.factory');

const stateGit = (args: readonly string[]): Promise<RunResult> => box.git(stateDir(), args);

const commitCount = async (): Promise<number> => Number((await stateGit(['rev-list', '--count', 'HEAD'])).stdout.trim());

const textOf = (file: string): Promise<string> => readFile(join(stateDir(), file), 'utf8');

/** The file of the owner decisions: in the state folder of the user, outside the factory folder. */
const decisionFile = (): string => join(box.env['HOME'] ?? '', '.local', 'state', program, files.ownerDecisions);

const decisionsFolder = (): string => join(stateDir(), stateRel.profileDecisions);

const profileLog = (): string => join(stateDir(), stateRel.profileLog);

/** What a refused decide must leave as it is: the board files, the commits, the decisions folder, the log of the profile and the owner file. */
const stateNow = async (): Promise<unknown> => ({
  board: await Promise.all(BOARD_FILES.map(textOf)),
  commits: await commitCount(),
  decisionsFolder: existsSync(decisionsFolder()),
  profileLog: existsSync(profileLog()),
  ownerFile: existsSync(decisionFile()),
});

const decideWords = (): readonly string[] => [process.execPath, DIST, 'decide', 'D-1', 'a', '--home', box.node];

const answerYes: readonly Exchange[] = [{ prompt: QUESTION, answer: 'y' }];

interface OwnerRecord {
  readonly node: string;
  readonly root: string;
  readonly id: string;
  readonly option: string;
  readonly hash: string;
  readonly at: string;
}

const ownerRecords = async (): Promise<readonly OwnerRecord[]> =>
  (JSON.parse(await readFile(decisionFile(), 'utf8')) as { records: OwnerRecord[] }).records;

beforeEach(async () => {
  box = await makeSandbox();
  const project = await box.makeProject('web');
  expect((await box.git(project, ['commit', '--allow-empty', '-q', '-m', 'first'])).code).toBe(0);
  const made = await box.run(['init', '--yes', '--home', box.node, '--name', 'demo', '--owner-name', 'Test Owner', '--project', project]);
  expect(made.code, made.stderr).toBe(0);
  const config = join(box.node, files.config);
  const text = await readFile(config, 'utf8');
  await writeFile(config, `${text}${text.endsWith('\n') ? '' : '\n'}${BOARD_BLOCK}`);
  const asked = await box.run(['request', 'add', '--title', 'Pick', '--question', 'Which?', '--option', 'a=Yes', '--option', 'b=No', '--home', box.node]);
  expect(asked.code, asked.stderr).toBe(0);
}, CASE_MS);

afterEach(async () => {
  await box.remove();
});

afterAll(removeOpenSandboxes);

describe.skipIf(gate !== 'run')('decide in a fake terminal (built binary)', () => {
  it(
    'records the first answer after init: one decisions folder, a first log.md, one owner record and one state commit',
    async () => {
      expect(existsSync(decisionsFolder())).toBe(false);
      expect(existsSync(profileLog())).toBe(false);
      expect(existsSync(decisionFile())).toBe(false);
      const before = await commitCount();

      const result = await runInTerminal(box, decideWords(), { exchanges: answerYes, promptMs: PROMPT_MS, totalMs: TOTAL_MS });

      expect(result.code, result.screen).toBe(0);
      expect(result.screen).toContain('Decision D-1');
      expect(result.screen).toContain('Recorded the answer a for D-1: Pick');
      const [record, ...others] = await ownerRecords();
      expect(others).toEqual([]);
      expect(record).toEqual({
        node: 'demo',
        root: await realpath(box.node),
        id: 'D-1',
        option: 'a',
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      });
      expect((await stat(decisionFile())).mode & 0o077).toBe(0);

      const date = record?.at.slice(0, 10) ?? '';
      const stem = `${date}-d-1-pick`;
      expect(await readdir(decisionsFolder())).toEqual([`${stem}.md`]);
      const text = await readFile(join(decisionsFolder(), `${stem}.md`), 'utf8');
      expect(text).toContain(`time: ${record?.at}\n`);
      expect(text).toContain('context: demo\n');
      expect(text).toContain('decided_by: owner\n');
      expect(text).toContain('Option: a\n');
      expect(await readFile(profileLog(), 'utf8')).toBe(`# Decision log\n\n- ${date} D-1: a ([[${stem}]])\n`);

      expect(await commitCount()).toBe(before + 1);
      const committed = (await stateGit(['show', '--name-only', '--format=', 'HEAD'])).stdout.split('\n').filter((line) => line !== '');
      expect(committed).toEqual(expect.arrayContaining([join(stateRel.profileDecisions, `${stem}.md`), stateRel.profileLog, files.waiting, files.decisionLog]));
      expect((await stateGit(['status', '--porcelain'])).stdout).toBe('');

      const waiting = JSON.parse(await textOf(files.waiting)) as unknown;
      expect(JSON.stringify(waiting)).not.toContain('D-1');
      const log = JSON.parse(await textOf(files.decisionLog)) as { rows: { item: string; decision: string; by: string; request: string }[] };
      const [row] = log.rows;
      expect(row).toMatchObject({ decision: 'a', by: 'owner' });
      expect(row?.item).toContain('D-1');
      expect(createHash('sha256').update(row?.request ?? '', 'utf8').digest('hex')).toBe(record?.hash);
    },
    CASE_MS,
  );

  it(
    'exits 4 with the delete guard off, before the question, and writes nothing',
    async () => {
      expect((await stateGit(['config', stateGuard.hooksPathKey, '/somewhere/else'])).code).toBe(0);
      const before = await stateNow();

      const result = await runInTerminal(box, decideWords(), { promptMs: PROMPT_MS, totalMs: TOTAL_MS });

      expect(result.code, result.screen).toBe(4);
      expect(result.screen).not.toContain('Decision D-1');
      expect(result.screen).not.toContain('[y/N]');
      expect(await stateNow()).toEqual(before);
    },
    CASE_MS,
  );

  it.each([
    ['FACTORY_SESSION', 'demo'],
    ['CLAUDECODE', '1'],
  ])(
    'exits 4 with %s set, before the question, and writes nothing',
    async (name, value) => {
      const before = await stateNow();

      const result = await runInTerminal(box, decideWords(), { env: { [name]: value }, promptMs: PROMPT_MS, totalMs: TOTAL_MS });

      expect(result.code, result.screen).toBe(4);
      expect(result.screen).not.toContain('Decision D-1');
      expect(result.screen).not.toContain('[y/N]');
      expect(await stateNow()).toEqual(before);
    },
    CASE_MS,
  );
});

describe('decide with no terminal window (built binary)', () => {
  it(
    'exits 4 when input and output are pipes, even with a yes on the input, and writes nothing',
    async () => {
      const before = await stateNow();

      const result = await box.run(['decide', 'D-1', 'a', '--home', box.node], { input: 'y\n' });

      expect(result.code, result.stderr).toBe(4);
      expect(result.stdout).not.toContain('Decision D-1');
      expect(await stateNow()).toEqual(before);
    },
    CASE_MS,
  );
});

it.runIf(gate === 'fail')('needs the program script, because the variable CI is set', () => {
  throw new Error('the program script is not installed, and the tests run with CI set');
});
