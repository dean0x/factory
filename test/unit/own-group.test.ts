import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { killKeptGroups, pidOfReadyText, readyPid } from '../helpers/own-group.js';

/**
 * The helper keeps a test from signalling a process group that the test did not make. Here `process.kill` is a stub that sends
 * nothing, so these tests never signal any process.
 */
let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-own-group-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const BAD_TEXTS = ['', '\n', '0', '1', '-7', '-0', 'abc', '1.5', '1e3', '12 34', '99999999999', '2147483648', String(process.pid)];

describe('test helper: the pid of a ready file', () => {
  it.each(BAD_TEXTS)('refuses the text %j', (text) => {
    expect(() => pidOfReadyText(text)).toThrow('the ready file has no usable pid');
  });

  it('accepts a whole number from 2 up, with a line break after it', () => {
    expect(pidOfReadyText('4242\n')).toBe(4242);
    expect(pidOfReadyText('2')).toBe(2);
  });

  it('keeps nothing and fails when the ready file does not come', async () => {
    const kept: number[] = [];
    await expect(readyPid(kept, join(dir, 'never-written'), 2)).rejects.toThrow('the ready file has no usable pid');
    expect(kept).toEqual([]);
  });

  it.each(BAD_TEXTS.filter((text) => text.trim() !== ''))('keeps nothing and fails for a ready file with %j', async (text) => {
    const file = join(dir, `bad-${Buffer.from(text).toString('hex')}`);
    await writeFile(file, text);
    const kept: number[] = [];
    await expect(readyPid(kept, file, 2)).rejects.toThrow('the ready file has no usable pid');
    expect(kept).toEqual([]);
  });

  it('keeps the pid of a good ready file', async () => {
    const file = join(dir, 'good');
    await writeFile(file, '4242');
    const kept: number[] = [];
    expect(await readyPid(kept, file, 2)).toBe(4242);
    expect(kept).toEqual([4242]);
  });
});

describe('test helper: the clean-up of the groups', () => {
  it('sends no signal for a value that is not the pid of one child, and empties the list', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const kept = [0, 1, -5, Number.NaN, 1.5, process.pid, 2 ** 40, Number.POSITIVE_INFINITY];
    killKeptGroups(kept);
    expect(kill).not.toHaveBeenCalled();
    expect(kept).toEqual([]);
  });

  it('sends KILL only to the group of a good pid', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killKeptGroups([0, 4242, -1]);
    expect(kill.mock.calls).toEqual([[-4242, 'SIGKILL']]);
  });

  it('goes on when the group has ended', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    killKeptGroups([4242, 4243]);
    expect(kill).toHaveBeenCalledTimes(2);
  });
});
