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
    expect((await box.run(['init', '--home', box.node, '--name', 'demo', '--owner-name', 'Test Owner'])).code).toBe(0);

    const dry = await box.run(['up', '--home', box.node, '--dry-run'], {
      env: { PATH: `${bin}:${box.env['PATH'] ?? ''}`, TMUX: '/somewhere/else,1,0' },
    });
    expect(dry.code).toBe(0);
    expect(await box.read(seen)).toBe(`${box.env['TMUX_TMPDIR']}|unset`);
    await box.remove();
  });
});
