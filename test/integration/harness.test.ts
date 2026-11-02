import { existsSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { makeSandbox, removeOpenSandboxes } from './harness.js';

afterAll(removeOpenSandboxes);

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
