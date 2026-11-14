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

/** The repo `web`, and a root made beside it by `init --yes`. The result is the old folder of the repo. */
const initWeb = async (): Promise<string> => {
  const web = await box.makeProject('web', 'https://github.com/acme/web.git');
  const result = await box.run(['init', '--yes', ...owner], { cwd: web, ...withState() });
  expect({ code: result.code }).toEqual({ code: 0 });
  expect(result.stderr).toContain('keeps the work that is not pushed');
  return web;
};

/** The folder of the clone of `web` in the root that `initWeb` made. */
const cloneOfWeb = (): string => join(box.root, 'web-factory', 'web');

/** The index as a person edits it: the entries of the homes by id get the project folders. */
const listProjects = async (projectsById: Readonly<Record<string, readonly string[]>>): Promise<void> => {
  const index = JSON.parse(await box.read(indexFile())) as { homes: { id: string; projects: string[] }[] };
  const homes = index.homes.map((entry) => ({ ...entry, projects: [...(projectsById[entry.id] ?? entry.projects)] }));
  await writeFile(indexFile(), `${JSON.stringify({ ...index, homes }, null, 2)}\n`);
};

describe('the home index (built binary, temp HOME and temp XDG_STATE_HOME)', () => {
  it('keeps the index under XDG_STATE_HOME, readable by the user only, with the real paths of the clones', async () => {
    await initWeb();
    expect(JSON.parse(await box.read(indexFile()))).toEqual({
      schema: 1,
      homes: [
        {
          home: join(realRoot, 'web-factory'),
          id: 'web-factory',
          projects: [join(realRoot, 'web-factory', 'web')],
          origin: 'own',
        },
      ],
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

  // About 10 process launches take 16 s alone and a launch is 2 to 4.6 times slower under load, so this case needs more than the 30 s global limit.
  it('lets doctor and start --dry-run find web-factory from the root, the coordinator folder and the clone', { timeout: 120_000 }, async () => {
    await initWeb();
    const clone = cloneOfWeb();
    await mkdir(join(clone, 'src', 'deep'), { recursive: true });
    const config = join(realRoot, 'web-factory', 'factory.yaml');
    const folders = [
      join(box.root, 'web-factory'),
      join(box.root, 'web-factory', 'coordinator'),
      clone,
      join(clone, 'src'),
      join(clone, 'src', 'deep'),
    ];
    for (const cwd of folders) {
      const doctor = await box.run(['doctor'], { cwd, ...withState() });
      expect({ cwd, code: doctor.code }).toEqual({ cwd, code: 0 });
      expect(doctor.stdout).toContain(config);
      expect(doctor.stdout).toContain('1 entry in the factory list, all present');

      const dry = await box.run(['start', '--dry-run'], { cwd, ...withState() });
      expect({ cwd, code: dry.code, stderr: dry.stderr }).toEqual({ cwd, code: 0, stderr: '' });
      expect(dry.stdout).toContain('Dry run');
    }
  });

  // About 11 process launches take 16 s alone and a launch is 2 to 4.6 times slower under load, so this case needs more than the 30 s global limit.
  it('lets doctor and start --dry-run find each of two roots of one HOME from its own folder, and never the other root', { timeout: 120_000 }, async () => {
    await initWeb();
    const second = join(box.root, 'second-home');
    expect((await box.run(['init', '--yes', '--home', second, '--name', 'second', ...owner], withState())).code).toBe(0);
    const roots = [
      { id: 'web-factory', home: join(realRoot, 'web-factory'), other: join(realRoot, 'second-home') },
      { id: 'second', home: join(realRoot, 'second-home'), other: join(realRoot, 'web-factory') },
    ];
    for (const { id, home, other } of roots) {
      for (const cwd of [home, join(home, 'coordinator')]) {
        const doctor = await box.run(['doctor'], { cwd, ...withState() });
        expect({ id, cwd, code: doctor.code }).toEqual({ id, cwd, code: 0 });
        expect(doctor.stdout).toContain(join(home, 'factory.yaml'));
        expect(doctor.stdout).not.toContain(join(other, 'factory.yaml'));
        expect(doctor.stdout).toContain('2 entries in the factory list, all present');

        const dry = await box.run(['start', '--dry-run', '--json'], { cwd, ...withState() });
        expect({ id, cwd, code: dry.code, stderr: dry.stderr }).toEqual({ id, cwd, code: 0, stderr: '' });
        const report = JSON.parse(dry.stdout) as { session: string; calls: string[] };
        expect(report.session).toBe(id);
        expect(report.calls.join('\n')).toContain(`FACTORY_HOME=${home}`);
        expect(report.calls.join('\n')).not.toContain(other);
      }
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

  it('exits 2 and names both homes when two homes list the same project folder', async () => {
    const web = await initWeb();
    const second = join(box.root, 'second-home');
    const init = await box.run(['init', '--yes', '--home', second, '--name', 'second', ...owner], withState());
    expect(init.code).toBe(0);
    const folder = join(await realpath(web), 'src');
    await mkdir(folder, { recursive: true });
    await listProjects({ 'web-factory': [await realpath(web)], second: [await realpath(web)] });

    const result = await box.run(['start', '--dry-run'], { cwd: folder, ...withState() });
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

  it('finds the home that is there when the other home of the same project folder is gone', async () => {
    const web = await initWeb();
    const second = join(box.root, 'second-home');
    expect((await box.run(['init', '--yes', '--home', second, '--name', 'second', ...owner], withState())).code).toBe(0);
    await listProjects({ 'web-factory': [await realpath(web)], second: [await realpath(web)] });
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
