import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeSandbox, removeOpenSandboxes, tmuxSocketOf } from './harness.js';

afterAll(removeOpenSandboxes);

/** The longest path that a socket can have on macOS: the field is 104 bytes, and the last byte is the end of the string. */
const MAX_SOCKET_PATH_BYTES = 103;

/** A tmux that records the two variables which decide the server, and then reports that no session runs. */
const probeTmux = (seen: string): string =>
  ['#!/bin/sh', `printf '%s|%s' "\${TMUX_TMPDIR-unset}" "\${TMUX-unset}" > '${seen}'`, 'exit 1', ''].join('\n');

describe('the sandbox of the integration tests', () => {
  it('removes its folder for remove()', async () => {
    const box = await makeSandbox();
    expect(existsSync(box.root)).toBe(true);
    await box.remove();
    expect(existsSync(box.root)).toBe(false);
  });

  it('removes every open sandbox for removeOpenSandboxes(), also when a test never called remove()', async () => {
    const first = await makeSandbox();
    const second = await makeSandbox();
    await second.remove();
    await removeOpenSandboxes();
    expect(existsSync(first.root)).toBe(false);
    expect(existsSync(second.root)).toBe(false);
  });

  it('does nothing when no sandbox is open', async () => {
    await removeOpenSandboxes();
    await expect(removeOpenSandboxes()).resolves.toBeUndefined();
  });

  it('keeps the home of the sandbox inside its root, so one removal clears the home and the folders below it', async () => {
    const box = await makeSandbox();
    expect(box.env['HOME']?.startsWith(box.root)).toBe(true);
    expect(box.node.startsWith(box.root)).toBe(true);
    await box.remove();
    expect(existsSync(box.env['HOME'] ?? '')).toBe(false);
  });
});

describe('the offline origins of the sandbox', () => {
  it('serves the origin of a project from the disk, with and without the user part of the URL', async () => {
    const box = await makeSandbox();
    await box.makeProject('web', 'git@github.com:acme/web.git');
    await box.makeProject('api', 'https://deploy@github.com/acme/api.git');

    const scp = await box.git(box.root, ['clone', '-q', 'git@github.com:acme/web.git', join(box.root, 'clone-web')]);
    const withUser = await box.git(box.root, ['clone', '-q', 'https://deploy@github.com/acme/api.git', join(box.root, 'clone-api')]);
    const withoutUser = await box.git(box.root, ['clone', '-q', 'https://github.com/acme/api.git', join(box.root, 'clone-api-bare')]);

    expect({ scp: scp.code, withUser: withUser.code, withoutUser: withoutUser.code }).toEqual({ scp: 0, withUser: 0, withoutUser: 0 });
    await box.remove();
  });

  it('refuses a clone of an https URL that the sandbox does not serve, with no network', async () => {
    const box = await makeSandbox();
    const result = await box.git(box.root, ['clone', '-q', 'https://host.invalid/acme/other.git', join(box.root, 'clone-other')]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("transport 'https' not allowed");
    expect(existsSync(join(box.root, 'clone-other'))).toBe(false);
    await box.remove();
  });

  it('refuses a clone of an ssh URL that the sandbox does not serve, so no key of the real home is used', async () => {
    const box = await makeSandbox();
    const result = await box.git(box.root, ['clone', '-q', 'git@host.invalid:acme/other.git', join(box.root, 'clone-other')]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("transport 'ssh' not allowed");
    await box.remove();
  });

  it('stops the setup when a git step fails', async () => {
    const box = await makeSandbox();
    const locked = join(box.root, 'locked');
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o500);
    await expect(box.makeProject('locked')).rejects.toThrow(/sandbox: git init failed/);
    await chmod(locked, 0o700);
    await box.remove();
  });
});

describe('the tmux isolation of the sandbox', () => {
  it('gives every command a tmux folder inside the sandbox that exists, and no TMUX variable', async () => {
    const box = await makeSandbox();
    expect(box.env['TMUX_TMPDIR']?.startsWith(`${box.root}/`)).toBe(true);
    expect(existsSync(box.env['TMUX_TMPDIR'] ?? '')).toBe(true);
    expect(box.env['TMUX']).toBeUndefined();
    await box.remove();
  });

  it('keeps the socket path of the tmux server below the limit of macOS', async () => {
    const box = await makeSandbox();
    const socket = tmuxSocketOf(box.root);
    expect(socket.startsWith(`${box.env['TMUX_TMPDIR']}/`)).toBe(true);
    expect({ socket, bytes: Buffer.byteLength(socket) <= MAX_SOCKET_PATH_BYTES }).toEqual({ socket, bytes: true });
    await box.remove();
  });

  it('reaches tmux with the folder of the sandbox, also when the caller sets TMUX', async () => {
    const box = await makeSandbox();
    const bin = join(box.root, 'bin');
    const seen = join(box.root, 'seen');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'tmux'), probeTmux(seen));
    await chmod(join(bin, 'tmux'), 0o755);
    expect((await box.run(['init', '--yes', '--home', box.node, '--name', 'demo', '--owner-name', 'Test Owner'])).code).toBe(0);

    const dry = await box.run(['start', '--home', box.node, '--dry-run'], {
      env: { PATH: `${bin}:${box.env['PATH'] ?? ''}`, TMUX: '/somewhere/else,1,0' },
    });
    expect(dry.code).toBe(0);
    expect(await box.read(seen)).toBe(`${box.env['TMUX_TMPDIR']}|unset`);
    await box.remove();
  });
});
