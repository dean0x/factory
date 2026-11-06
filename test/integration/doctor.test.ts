import { chmod, lstat, mkdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_GITHUB_TOKEN } from '../helpers/fake-secret.js';
import { makeSandbox, removeOpenSandboxes, writeFakeAgent, type Sandbox } from './harness.js';

let box: Sandbox;

beforeEach(async () => {
  box = await makeSandbox();
});

afterEach(async () => {
  await box.remove();
});

afterAll(removeOpenSandboxes);

const initNode = async (): Promise<void> => {
  const web = await box.makeProject('web', 'git@github.com:acme/web.git');
  const result = await box.run([
    'init',
    '--yes',
    '--home',
    box.node,
    '--name',
    'demo',
    '--owner-name',
    'Test Owner',
    '--project',
    web,
  ]);
  expect(result.code).toBe(0);
};

describe('factory doctor (built binary)', () => {
  it('exits 0 on a fresh node', async () => {
    await initNode();
    const result = await box.run(['doctor', '--home', box.node]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0 failures');
  });

  it('warns, and still exits 0, when a folder above the node holds an instruction file of an agent (TP-32)', async () => {
    await initNode();
    const above = join(box.root, 'AGENTS.md');
    await writeFile(above, 'x\n');
    const result = await box.run(['doctor', '--home', box.node]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`instruction-files\\s+Agent instruction files are in the factory folder or above it: .*${above}`));
    const json = JSON.parse((await box.run(['doctor', '--home', box.node, '--json'])).stdout) as {
      checks: { id: string; level: string }[];
    };
    expect(json.checks.find((check) => check.id === 'instruction-files')?.level).toBe('warn');
  });

  it('finds the node from a folder below it', async () => {
    await initNode();
    const result = await box.run(['doctor'], { cwd: join(box.node, '.factory') });
    expect(result.code).toBe(0);
  });

  it('exits 0 from the root, the coordinator folder and a project clone, with no --home (TP-14)', async () => {
    await initNode();
    for (const cwd of [box.node, join(box.node, 'coordinator'), join(box.node, 'web')]) {
      const result = await box.run(['doctor'], { cwd });
      expect({ cwd, code: result.code, stderr: result.stderr }).toEqual({ cwd, code: 0, stderr: '' });
      expect(result.stdout).toContain('0 failures');
    }
  });

  it('prints one JSON document with its schema id', async () => {
    await initNode();
    const result = await box.run(['doctor', '--home', box.node, '--json']);
    expect(result.code).toBe(0);
    const document = JSON.parse(result.stdout) as { schema: string; ok: boolean; checks: { id: string; level: string }[] };
    expect(document.schema).toBe('factory.doctor/v1');
    expect(document.ok).toBe(true);
    expect(document.checks.find((check) => check.id === 'config')?.level).toBe('ok');
    expect(document.checks.every((check) => check.level !== 'fail')).toBe(true);
    expect(document.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining(['root', 'temp-folder', 'tracker', 'children']),
    );
    expect(document.checks.map((check) => check.id)).not.toContain('home');
    for (const id of ['root', 'temp-folder', 'tracker', 'children']) {
      expect(document.checks.find((check) => check.id === id)?.level).toBe('ok');
    }
  });

  it('warns about an edited block and still exits 0', async () => {
    await initNode();
    const claude = join(box.node, 'coordinator', 'CLAUDE.md');
    const text = await box.read(claude);
    const edited = text.replace('Coordinate. Do not produce.', 'Do as you like.');
    expect(edited).not.toBe(text);
    await writeFile(claude, edited);
    const result = await box.run(['doctor', '--home', box.node]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('coordinator (edited');
  });

  it('fails for an edited safety block, exits 1 and names the command that puts it back (TP-43)', async () => {
    await initNode();
    const claude = join(box.node, 'coordinator', 'CLAUDE.md');
    const text = await box.read(claude);
    const edited = text.replace('Never skip permissions', 'Skip permissions');
    expect(edited).not.toBe(text);
    await writeFile(claude, edited);
    const result = await box.run(['doctor', '--home', box.node]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('safety (edited');
    expect(result.stdout).toContain('factory upgrade --overwrite safety');
  });

  it('exits 1 for a bad config and names the key', async () => {
    await initNode();
    const path = join(box.node, 'factory.yaml');
    const text = await box.read(path);
    const bad = text.replace(/effort: \w+/, 'effort: wild');
    expect(bad).not.toBe(text);
    await writeFile(path, bad);
    const result = await box.run(['doctor', '--home', box.node]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('session.effort');
  });

  it('exits 1 for a secret in the config, and never prints the value', async () => {
    await initNode();
    const path = join(box.node, 'factory.yaml');
    const secret = FAKE_GITHUB_TOKEN;
    await writeFile(path, `${await box.read(path)}\nnote: ${secret}\n`);
    const result = await box.run(['doctor', '--home', box.node]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('note in factory.yaml or factory.local.yaml looks like a token');
    expect(result.stdout + result.stderr).not.toContain(secret);
  });

  it('warns, and exits 0, for a temp folder of a stopped init, and removes nothing (TP-73)', async () => {
    await initNode();
    const leftover = join(box.node, '.factory.tmp-4242');
    await mkdir(leftover);
    const result = await box.run(['doctor', '--home', box.node]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`temp folder ${leftover}, left by a stopped init`);
    expect((await stat(leftover)).isDirectory()).toBe(true);
  });

  it('warns, and exits 0, when the share list of .gitignore is not intact', async () => {
    await initNode();
    await writeFile(join(box.node, '.gitignore'), 'factory.local.yaml\n.factory/\n!/notes.md\n');
    const result = await box.run(['doctor', '--home', box.node]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('.gitignore has no intact share list');
  });

  it('fails when the .gitignore of the root no longer makes git ignore the local file and the state folder (TP-61)', async () => {
    await initNode();
    await writeFile(join(box.node, '.gitignore'), '!/notes.md\n');
    const result = await box.run(['doctor', '--home', box.node]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/root-repo\s+git does not ignore factory\.local\.yaml and \.factory\//);
    expect(result.stdout).toContain('Add the lines "factory.local.yaml" and ".factory/" to .gitignore');
  });

  it('exits 2 and names init when factory.yaml has no factory.local.yaml next to it', async () => {
    await initNode();
    await rm(join(box.node, 'factory.local.yaml'));
    const result = await box.run(['doctor', '--home', box.node]);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('factory.local.yaml not found');
    expect(result.stdout).toContain('factory init');
  });

  it('warns for a local file that others can read, names the chmod command, and changes no mode', async () => {
    await initNode();
    const path = join(box.node, 'factory.local.yaml');
    await chmod(path, 0o644);
    const result = await box.run(['doctor', '--home', box.node]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('chmod 600 factory.local.yaml');
    expect((await stat(path)).mode & 0o777).toBe(0o644);
  });

  it('fails for a local file that others can write', async () => {
    await initNode();
    const path = join(box.node, 'factory.local.yaml');
    await chmod(path, 0o662);
    const result = await box.run(['doctor', '--home', box.node]);
    expect(result.code).toBe(4);
    expect(result.stdout).toContain('chmod 600 factory.local.yaml');
    expect((await stat(path)).mode & 0o777).toBe(0o662);
  });

  it('exits 4 for a local file that is a link, and names the remedy', async () => {
    await initNode();
    const path = join(box.node, 'factory.local.yaml');
    const elsewhere = join(box.root, 'elsewhere.yaml');
    await rename(path, elsewhere);
    await symlink(elsewhere, path);
    const result = await box.run(['doctor', '--home', box.node]);
    expect(result.code).toBe(4);
    expect(result.stdout).toContain('factory.local.yaml is a link, so factory does not use it');
    expect(result.stdout).toContain('factory init');
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });

  it('exits 2 when there is no config file above the folder and no entry of the home index', async () => {
    const result = await box.run(['doctor'], { cwd: box.root });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--home DIR');
  });

  it('exits 2 for an unknown flag', async () => {
    const result = await box.run(['doctor', '--bogus']);
    expect(result.code).toBe(2);
  });

  it('warns about ANTHROPIC_BASE_URL in the shell and does not print its value', async () => {
    await initNode();
    const result = await box.run(['doctor', '--home', box.node], {
      env: { ANTHROPIC_BASE_URL: 'http://user:topsecret@proxy.invalid:9' },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ANTHROPIC_BASE_URL');
    expect(result.stdout).not.toContain('topsecret');
  });
});

describe('the agent version check of factory doctor (built binary, TP-35)', () => {
  /** The `agent-version` check of a doctor run in which `version` is the output of `claude --version`. */
  const agentCheckFor = async (version: string | null): Promise<{ code: number; level: string | undefined; text: string }> => {
    await initNode();
    const env =
      version === null
        ? {}
        : { PATH: `${await writeFakeAgent(box.root, 'other-agent', version)}:${box.env['PATH'] ?? ''}` };
    const result = await box.run(['doctor', '--home', box.node, '--json'], { env });
    const document = JSON.parse(result.stdout) as { checks: { id: string; level: string; text: string }[] };
    const found = document.checks.find((item) => item.id === 'agent-version');
    return { code: result.code, level: found?.level, text: found?.text ?? '' };
  };

  it('passes for the fake agent of the sandbox, which prints a new enough version', async () => {
    expect(await agentCheckFor(null)).toMatchObject({ code: 0, level: 'ok' });
  });

  it('warns, and still exits 0, for a version below 2.1.224', async () => {
    const found = await agentCheckFor('2.1.223 (Claude Code)');
    expect(found).toMatchObject({ code: 0, level: 'warn' });
    expect(found.text).toContain('claude 2.1.223 is older than 2.1.224');
  });

  it('warns, and still exits 0, for an output that is no version', async () => {
    const found = await agentCheckFor('not a version');
    expect(found).toMatchObject({ code: 0, level: 'warn' });
    expect(found.text).toContain('cannot read the version of claude');
  });
});

describe('the root checks of factory doctor and factory start (built binary)', () => {
  const ROOT_CHECKS = ['root-repo', 'root-files', 'project-paths', 'permission-mode', 'delegations'];

  it('has the five root checks, all ok, on a fresh node with a real git repo', async () => {
    await initNode();
    const result = await box.run(['doctor', '--home', box.node, '--json']);
    const document = JSON.parse(result.stdout) as { checks: { id: string; level: string; text: string }[] };
    for (const id of ROOT_CHECKS) {
      expect({ id, level: document.checks.find((check) => check.id === id)?.level }).toEqual({ id, level: 'ok' });
    }
    expect(document.checks.find((check) => check.id === 'delegations')?.text).toContain('merge: owner');
  });

  it('fails doctor, and stops start with exit 4, when git tracks the local file (TP-20)', async () => {
    await initNode();
    expect((await box.git(box.node, ['add', '-f', 'factory.local.yaml'])).code).toBe(0);
    const doctor = await box.run(['doctor', '--home', box.node]);
    expect(doctor.code).toBe(1);
    expect(doctor.stdout).toMatch(/root-repo\s+the git repo of the factory folder tracks files that must stay on this machine: the local file factory\.local\.yaml/);
    expect(doctor.stdout).toContain('git rm --cached');
    const start = await box.run(['start', '--dry-run', '--home', box.node]);
    expect(start.code).toBe(4);
    expect(start.stderr).toContain('factory.local.yaml');
    expect(start.stderr).toContain('git rm --cached');
  });

  it('fails doctor, and stops start, for a token in a tracked file, and never prints the value (TP-45)', async () => {
    await initNode();
    await writeFile(join(box.node, 'notes.md'), `The key is ${FAKE_GITHUB_TOKEN} for now.\n`);
    expect((await box.git(box.node, ['add', '-f', 'notes.md'])).code).toBe(0);
    const doctor = await box.run(['doctor', '--home', box.node]);
    expect(doctor.code).toBe(1);
    expect(doctor.stdout).toMatch(/root-files\s+notes\.md holds a value that looks like a password or a token/);
    const start = await box.run(['start', '--dry-run', '--home', box.node]);
    expect(start.code).toBe(4);
    for (const text of [doctor.stdout, doctor.stderr, start.stdout, start.stderr]) expect(text).not.toContain(FAKE_GITHUB_TOKEN);
  });

  it('fails doctor, and stops start, for a setting that skips permission prompts in the coordinator folder (TP-133)', async () => {
    await initNode();
    await mkdir(join(box.node, 'coordinator', '.claude'), { recursive: true });
    await writeFile(
      join(box.node, 'coordinator', '.claude', 'settings.local.json'),
      '{"permissions":{"defaultMode":"bypassPermissions"}}\n',
    );
    const doctor = await box.run(['doctor', '--home', box.node]);
    expect(doctor.code).toBe(1);
    expect(doctor.stdout).toContain('coordinator/.claude/settings.local.json skips the permission checks');
    const start = await box.run(['start', '--dry-run', '--home', box.node]);
    expect(start.code).toBe(4);
    expect(start.stderr).toContain('coordinator/.claude/settings.local.json');
  });

  it('fails doctor for a Claude settings path that the root repo tracks at any depth (TP-168)', async () => {
    await initNode();
    const folder = join(box.node, 'tools', 'deep', '.claude');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'settings.json'), '{"skipDangerousModePermissionPrompt": true}\n');
    expect((await box.git(box.node, ['add', '-f', 'tools/deep/.claude/settings.json'])).code).toBe(0);
    const doctor = await box.run(['doctor', '--home', box.node]);
    expect(doctor.code).toBe(1);
    expect(doctor.stdout).toContain('tools/deep/.claude/settings.json skips the permission checks');
  });

  it('fails doctor for a project folder that is a link to a folder outside the root (TP-63)', async () => {
    await initNode();
    const outside = join(box.root, 'outside-web');
    await rename(join(box.node, 'web'), outside);
    await symlink(outside, join(box.node, 'web'));
    const doctor = await box.run(['doctor', '--home', box.node]);
    expect(doctor.code).toBe(1);
    expect(doctor.stdout).toMatch(/project-paths\s+project web \(web\) resolves outside the factory folder/);
  });
});
