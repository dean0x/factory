import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env, files, lockWords } from '../../src/names.js';
import { killKeptGroups, readyPid } from '../helpers/own-group.js';
import { DIST, makeSandbox, removeOpenSandboxes, type Sandbox } from './harness.js';

/**
 * `lock run` with the built program (`dist/factory.js`) and real child processes. The state folder is in the HOME of the sandbox.
 * Every child ends by itself within 8 s, and each test stops at 15 s, so a run that goes wrong never holds the worker. The wait
 * between two tries is the real 5 s of the policy, so a test that waits for a lock takes a little more than 5 s.
 */
const TEST_TIMEOUT_MS = 15_000;

let box: Sandbox;
const processes: ChildProcess[] = [];
const childGroups: number[] = [];

beforeAll(async () => {
  box = await makeSandbox();
}, 30_000);

afterAll(removeOpenSandboxes);

const stateDir = (): string => join(box.root, 'home', '.local', 'state', 'factory');
const lockFile = (): string => join(stateDir(), files.heavyLock);
const path = (name: string): string => join(box.root, name);

beforeEach(() => rm(stateDir(), { recursive: true, force: true }));

afterEach(() => {
  for (const child of processes.splice(0)) child.kill('SIGKILL');
  // `readyPid` keeps only a pid that a held child wrote, and `killKeptGroups` signals only a pid that passes the same check.
  killKeptGroups(childGroups);
});

interface Running {
  readonly child: ChildProcess;
  readonly done: Promise<{ code: number | null; stdout: string; stderr: string }>;
  stderr(): string;
}

/** Start `factory` with the arguments and the extra variables. The text of the two output streams is kept apart. */
const factory = (args: readonly string[], extra: Readonly<Record<string, string>> = {}): Running => {
  const child = spawn('node', [DIST, ...args], { cwd: box.root, env: { ...box.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => void (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => void (stderr += chunk.toString()));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done, stderr: () => stderr };
};

/** The command line of a held child: `lock run -- node -e BODY ARG...`. */
const lockRun = (body: string, ...args: readonly string[]): string[] => ['lock', 'run', '--', 'node', '-e', body, ...args];

/** Wait at most 6 s for the check to hold. */
const until = async (check: () => boolean | Promise<boolean>): Promise<void> => {
  for (let tries = 0; tries < 300; tries += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the condition did not hold within 6 s');
};

const textOf = (file: string): Promise<string> => readFile(file, 'utf8').catch(() => '');

const exists = (file: string): Promise<boolean> =>
  lstat(file).then(
    () => true,
    () => false,
  );

/** A child that writes its pid, holds until a TERM (it writes the marker and exits with 42) or 8 s, and ends alone then. */
const HOLD = `
const fs = require("node:fs"); const [ready, marker] = process.argv.slice(1);
setTimeout(() => process.exit(9), 8000);
process.on("SIGTERM", () => { fs.writeFileSync(marker, "term"); process.exit(42); });
fs.writeFileSync(ready, String(process.pid));
setInterval(() => {}, 1000);`;

/** A child that prints on both streams, reports its environment and the lock file in a file, and exits with a code. */
const REPORT = `
const fs = require("node:fs"); const [out, lock, code] = process.argv.slice(1);
console.log("out-line"); console.error("err-line");
fs.writeFileSync(out, JSON.stringify({ token: process.env.${env.heavyLockToken}, caller: process.env.MY_VAR, lock: fs.readFileSync(lock, "utf8") }));
process.exit(Number(code));`;

/** A child that writes the time of its start, waits, and writes the time of its end. */
const STAMP = `
const fs = require("node:fs"); const [file, ms] = process.argv.slice(1);
fs.appendFileSync(file, "start " + Date.now() + "\\n");
setTimeout(() => { fs.appendFileSync(file, "end " + Date.now() + "\\n"); process.exit(0); }, Number(ms));`;

/** A child that runs the lock command again with a marker file as its child: the run is inside the lock. */
const OUTER = `
const { spawnSync } = require("node:child_process"); const [dist, marker] = process.argv.slice(1);
const inner = "require('node:fs').writeFileSync(process.argv[1], 'inner')";
const run = spawnSync(process.execPath, [dist, "lock", "run", "--", process.execPath, "-e", inner, marker], { stdio: "inherit" });
process.exit(run.status ?? 9);`;

describe('lock run with real processes', { timeout: TEST_TIMEOUT_MS }, () => {
  it('passes the output and the exit code of the child through, and gives it the token and the caller environment (TP-17, TP-18, TP-26)', async () => {
    const out = path('report.json');
    const run = await factory(lockRun(REPORT, out, lockFile(), '7'), { MY_VAR: 'kept' }).done;
    expect(run).toEqual({ code: 7, stdout: 'out-line\n', stderr: 'err-line\n' });
    const report = JSON.parse(await textOf(out)) as { token: string; caller: string; lock: string };
    expect(report.token).toMatch(/^\d+-\d+-[0-9a-f]{16}$/);
    expect(report.lock).toBe(`${report.token}\n`);
    expect(report.caller).toBe('kept');
    expect(await exists(lockFile())).toBe(false);
  });

  it.each([
    ['a program that is not found', ['lock', 'run', '--', 'factory-no-such-program'], 1, lockWords.notFound],
    ['the program itself', ['lock', 'run', '--', 'factory', 'version'], 4, lockWords.refused],
    ['the node program with the script of this program', ['lock', 'run', '--', process.execPath, DIST, 'version'], 4, lockWords.refused],
    ['no double dash', ['lock', 'run'], 2, lockWords.usage],
  ])('writes one line that starts with the program and the fixed word for %s, and nothing on stdout (TP-26)', async (_name, argv, code, word) => {
    const run = await factory(argv).done;
    expect(run.code).toBe(code);
    expect(run.stdout).toBe('');
    expect(run.stderr.split('\n')[0]).toMatch(new RegExp(`^error: factory lock run: ${word}\\. `));
  });

  it('refuses a link at the lock path, follows it nowhere and starts no child (TP-5)', async () => {
    await mkdir(stateDir(), { recursive: true, mode: 0o700 });
    await chmod(stateDir(), 0o700);
    await writeFile(path('target'), 'keep');
    await symlink(path('target'), lockFile());
    const out = path('never.json');
    const run = await factory(lockRun(REPORT, out, lockFile(), '0')).done;
    expect(run.code).toBe(4);
    expect(run.stderr.split('\n')[0]).toMatch(/^error: factory lock run: REFUSED\. /);
    expect(await textOf(path('target'))).toBe('keep');
    expect(await exists(out)).toBe(false);
  });

  it('starts the second child only after the first child has ended (TP-25)', async () => {
    const stamps = path('stamps.txt');
    const first = factory(lockRun(STAMP, stamps, '1200'));
    await until(async () => (await textOf(stamps)).includes('start'));
    const second = factory(lockRun(STAMP, stamps, '10'));
    const results = await Promise.all([first.done, second.done]);
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(second.stderr()).toMatch(/^warning: factory lock run: WAITING\. /);
    const marks = (await textOf(stamps)).trim().split('\n').map((line) => line.split(' '));
    expect(marks.map(([word]) => word)).toEqual(['start', 'end', 'start', 'end']);
    expect(Number(marks[2]?.[1])).toBeGreaterThanOrEqual(Number(marks[1]?.[1]));
  });

  it('runs a lock run inside a lock run at once, with no second wait (TP-33)', async () => {
    const marker = path('inner.txt');
    const begun = Date.now();
    const run = await factory(lockRun(OUTER, DIST, marker)).done;
    expect(run.code).toBe(0);
    expect(await textOf(marker)).toBe('inner');
    expect(Date.now() - begun).toBeLessThan(4_000);
  });

  it('forwards TERM to the child and frees the lock after the child has ended (TP-21)', async () => {
    const [ready, marker] = [path('hold-ready'), path('hold-marker')];
    const run = factory(lockRun(HOLD, ready, marker));
    await until(async () => (await textOf(ready)) !== '');
    await readyPid(childGroups, ready);
    expect(await exists(lockFile())).toBe(true);
    run.child.kill('SIGTERM');
    const result = await run.done;
    expect(result.code).toBe(42);
    expect(await textOf(marker)).toBe('term');
    expect(await exists(lockFile())).toBe(false);
  });

  it('ends the wait on TERM, starts no child, leaves the lock of the other run and exits 143 (TP-23)', async () => {
    const [ready, marker, out] = [path('wait-ready'), path('wait-marker'), path('waiter.json')];
    factory(lockRun(HOLD, ready, marker));
    await until(async () => (await textOf(ready)) !== '');
    await readyPid(childGroups, ready);
    const held = await textOf(lockFile());
    const waiter = factory(lockRun(REPORT, out, lockFile(), '0'));
    await until(() => waiter.stderr().includes(lockWords.waiting));
    waiter.child.kill('SIGTERM');
    const result = await waiter.done;
    expect(result.code).toBe(143);
    expect(result.stdout).toBe('');
    const lines = result.stderr.split('\n');
    expect(lines[0]).toMatch(/^warning: factory lock run: WAITING\. /);
    expect(lines[1]).toMatch(/^error: factory lock run: STOPPED\. /);
    expect(await exists(out)).toBe(false);
    expect(await textOf(lockFile())).toBe(held);
  });
});
