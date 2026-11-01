import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSandbox, type Sandbox } from './harness.js';

let box: Sandbox;

beforeEach(async () => {
  box = await makeSandbox();
});

afterEach(async () => {
  await box.remove();
});

const initNode = async (): Promise<void> => {
  const web = await box.makeProject('web', 'git@github.com:acme/web.git');
  const result = await box.run([
    'init',
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

  it('finds the node from a folder below it', async () => {
    await initNode();
    const result = await box.run(['doctor'], { cwd: join(box.node, '.factory') });
    expect(result.code).toBe(0);
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
  });

  it('warns about an edited block and still exits 0', async () => {
    await initNode();
    const claude = join(box.node, 'CLAUDE.md');
    const text = await box.read(claude);
    const edited = text.replace('Coordinate. Do not produce.', 'Do as you like.');
    expect(edited).not.toBe(text);
    await writeFile(claude, edited);
    const result = await box.run(['doctor', '--home', box.node]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('coordinator (edited');
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
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    await writeFile(path, `${await box.read(path)}\nnote: ${secret}\n`);
    const result = await box.run(['doctor', '--home', box.node]);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(secret);
  });

  it('exits 1 when there is no config file above the folder', async () => {
    const result = await box.run(['doctor'], { cwd: box.root });
    expect(result.code).toBe(1);
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
