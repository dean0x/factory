import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSandbox, removeOpenSandboxes, type Sandbox } from './harness.js';

let box: Sandbox;
let stateHome: string;
let realRoot: string;

beforeEach(async () => {
  box = await makeSandbox();
  stateHome = join(box.root, 'state');
  realRoot = await realpath(box.root);
});

afterEach(async () => {
  await box.remove();
});

afterAll(removeOpenSandboxes);

const indexFile = (): string => join(stateHome, 'factory', 'homes.json');
const withState = (): { env: Record<string, string> } => ({ env: { XDG_STATE_HOME: stateHome } });
const owner = ['--owner-name', 'Test Owner'];

/** The repo `web` with a source folder, and a node made in it by `init --yes`. */
const initWeb = async (): Promise<string> => {
  const web = await box.makeProject('web', 'https://github.com/acme/web.git');
  await mkdir(join(web, 'src', 'deep'), { recursive: true });
  const result = await box.run(['init', '--yes', ...owner], { cwd: web, ...withState() });
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  return web;
};

describe('the home index (built binary, temp HOME and temp XDG_STATE_HOME)', () => {
  it('keeps the index under XDG_STATE_HOME, readable by the user only, with the real paths', async () => {
    const web = await initWeb();
    expect(JSON.parse(await box.read(indexFile()))).toEqual({
      schema: 1,
      homes: [{ home: join(realRoot, 'web-factory'), id: 'web-factory', projects: [await realpath(web)] }],
    });
    expect((await stat(indexFile())).mode & 0o777).toBe(0o600);
    expect((await stat(join(stateHome, 'factory'))).mode & 0o777).toBe(0o700);
  });

  it('puts the index below the folder .local/state of HOME when XDG_STATE_HOME is not set', async () => {
    const web = await box.makeProject('web');
    const result = await box.run(['init', '--yes', ...owner], { cwd: web });
    expect(result.code).toBe(0);
    const fallback = join(box.env['HOME'] ?? '', '.local', 'state', 'factory', 'homes.json');
    expect(JSON.parse(await box.read(fallback))).toMatchObject({ schema: 1 });
    expect(fallback.includes(`${join(box.env['HOME'] ?? '', '.claude')}/`)).toBe(false);
  });

  it('lets doctor and start --dry-run find web-factory from web/ and from web/src', async () => {
    const web = await initWeb();
    const config = join(realRoot, 'web-factory', 'factory.yaml');
    for (const cwd of [web, join(web, 'src'), join(web, 'src', 'deep')]) {
      const doctor = await box.run(['doctor'], { cwd, ...withState() });
      expect({ cwd, code: doctor.code }).toEqual({ cwd, code: 0 });
      expect(doctor.stdout).toContain(config);
      expect(doctor.stdout).toContain('1 entry in the home index, all present');

      const dry = await box.run(['start', '--dry-run'], { cwd, ...withState() });
      expect({ cwd, code: dry.code, stderr: dry.stderr }).toEqual({ cwd, code: 0, stderr: '' });
      expect(dry.stdout).toContain('Dry run');
    }
  });

  it('exits 2 with the hint from a folder that is in no entry', async () => {
    await initWeb();
    const other = join(box.root, 'elsewhere');
    await mkdir(other, { recursive: true });
    for (const args of [['doctor'], ['start', '--dry-run']]) {
      const result = await box.run(args, { cwd: other, ...withState() });
      expect({ args, code: result.code }).toEqual({ args, code: 2 });
      expect(result.stderr).toContain('Run "factory init" here, or use --home DIR');
    }
  });

  it('exits 2 and names both homes when two homes list the same project', async () => {
    const web = await initWeb();
    const second = join(box.root, 'second-home');
    const init = await box.run(['init', '--home', second, '--name', 'second', ...owner, '--project', web], withState());
    expect(init.code).toBe(0);

    const result = await box.run(['start', '--dry-run'], { cwd: join(web, 'src'), ...withState() });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(join(realRoot, 'web-factory'));
    expect(result.stderr).toContain(join(realRoot, 'second-home'));
  });

  it('ignores a home that no longer exists', async () => {
    const web = await initWeb();
    await rm(join(box.root, 'web-factory'), { recursive: true, force: true });
    const result = await box.run(['start', '--dry-run'], { cwd: web, ...withState() });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--home DIR');
  });

  it('finds the home that is there when the other home of the same project is gone', async () => {
    const web = await initWeb();
    const second = join(box.root, 'second-home');
    expect((await box.run(['init', '--home', second, '--name', 'second', ...owner, '--project', web], withState())).code).toBe(0);
    await rm(join(box.root, 'web-factory'), { recursive: true, force: true });
    const result = await box.run(['doctor'], { cwd: web, ...withState() });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(join(realRoot, 'second-home', 'factory.yaml'));
    expect(result.stdout).toContain('with no factory.yaml');
  });

  it('exits 2 and names the file when the index cannot be read, and exits 4 for a home that the flag names', async () => {
    const web = await initWeb();
    await writeFile(indexFile(), '{ broken');
    const result = await box.run(['start', '--dry-run'], { cwd: web, ...withState() });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(indexFile());

    const doctor = await box.run(['doctor', '--home', join(box.root, 'web-factory')], withState());
    expect(doctor.code).toBe(4);
    expect(doctor.stderr).toContain(`the factory list ${indexFile()} cannot be used`);
    expect(doctor.stderr).toContain(`Fix or remove ${indexFile()}, then run "factory init"`);
  });

  it('refuses with exit 4 an index under the folder of Claude Code, and creates nothing', async () => {
    const web = await box.makeProject('web');
    const claudeState = join(box.env['HOME'] ?? '', '.claude', 'state');
    const result = await box.run(['init', '--yes', ...owner], { cwd: web, env: { XDG_STATE_HOME: claudeState } });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('inside');
    await expect(stat(join(box.root, 'web-factory'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(claudeState)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
