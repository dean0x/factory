import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import { deliverToHome, type DeliverInput, type DeliverResult } from '../../src/comms/deliver.js';
import type { PingResult } from '../../src/comms/transport.js';
import { renderConfig } from '../../src/config/render.js';
import type { Deps, Fs } from '../../src/core/deps.js';
import { nodeInbox } from '../../src/names.js';
import { STATE_GITIGNORE } from '../../src/state/files.js';
import { createFakeDeps, type FakeDeps, type FakeOptions } from '../helpers/fake-deps.js';
import { fileTransport } from '../helpers/package-registry.js';
import { sampleConfig } from '../helpers/sample-config.js';

const HOME = '/srv/web';
const STATE = `${HOME}/.factory`;
const INBOX = `${STATE}/inbox`;
const GITIGNORE = `${STATE}/.gitignore`;
const CONFIG = `${HOME}/factory.yaml`;
const FILE = `${INBOX}/2030-01-02T03-04-05-678Z-root-00000001.md`;
const INPUT: DeliverInput = { senderId: 'root', senderAddress: 'file:///srv/root', targetId: 'web', targetLayer: 1, body: 'Do the task.\n' };
const HEADER = ['Sender node id: root', 'Sender node address: file:///srv/root', 'Target node id: web', 'Message, no owner authority.'];
const TEXT = `${HEADER.join('\n')}\n\nDo the task.\n`;

type Ping = (address: string) => Promise<PingResult>;

const known = (id = 'web', layer = 1): PingResult => ({ kind: 'known', id, layer, schema: 2 });
const silent: PingResult = { kind: 'unknown', reason: 'no answer' };

const configOf = (id: string, layer: number): string => {
  const sample = sampleConfig();
  return renderConfig({ ...sample, core: { ...sample.core, node: { id, layer } } }).shared;
};

/** A child home that is ready for a delivery: a valid config, a state folder, and a .gitignore that ignores the inbox. */
const readyChild = (options: FakeOptions = {}, home = HOME): FakeDeps => {
  const deps = createFakeDeps({ cwd: '/w', ...options });
  deps.seed(`${home}/factory.yaml`, configOf('web', 1));
  deps.seed(`${home}/.factory/.gitignore`, STATE_GITIGNORE);
  return deps;
};

/** The real ping of the file transport, and the addresses that it got. */
const watched = (deps: Deps): { ping: Ping; pinged: string[] } => {
  const pinged: string[] = [];
  const real = fileTransport(deps).ping;
  return { pinged, ping: async (address) => (pinged.push(address), real(address)) };
};

const deliver = (deps: Deps, ping: Ping, input: DeliverInput = INPUT, address = `file://${HOME}`): Promise<DeliverResult> =>
  deliverToHome(deps, ping, address, input);

const inboxFiles = (deps: FakeDeps): string[] => [...deps.files.keys()].filter((path) => path.startsWith(`${INBOX}/`));

const fill = (deps: FakeDeps, count: number): void => {
  for (let index = 0; index < count; index += 1) deps.seed(`${INBOX}/old-${index}.md`, 'x');
};

describe('deliver: a message file for a child', () => {
  it('writes the header, a blank line and the body as a new file with mode 600, and gives its path', async () => {
    const deps = readyChild();
    const result = await deliver(deps, watched(deps).ping);
    expect(result).toEqual({ kind: 'written', path: FILE });
    expect(deps.files.get(FILE)).toBe(TEXT);
    expect(deps.modes.get(FILE)).toBe(0o600);
  });

  it('makes the inbox with mode 700 when it is not there, and keeps the mode of an inbox that is there', async () => {
    const made = readyChild();
    await deliver(made, watched(made).ping);
    expect(made.modes.get(INBOX)).toBe(0o700);

    const there = readyChild();
    there.seedDir(INBOX);
    there.modes.set(INBOX, 0o750);
    expect((await deliver(there, watched(there).ping)).kind).toBe('written');
    expect(there.modes.get(INBOX)).toBe(0o750);
  });

  it('uses the real path of the home for both pings and for the write', async () => {
    const deps = readyChild({ links: { '/alias': '/real' } }, '/real/web');
    deps.seedDir('/alias/web');
    const { ping, pinged } = watched(deps);
    const result = await deliver(deps, ping, INPUT, 'file:///alias/web');
    expect(pinged).toEqual(['file:///real/web', 'file:///real/web']);
    expect(result).toEqual({ kind: 'written', path: '/real/web/.factory/inbox/2030-01-02T03-04-05-678Z-root-00000001.md' });
  });

  it('never replaces a file that has the name, and gives an I/O fault', async () => {
    const deps = readyChild();
    deps.seed(FILE, 'old\n');
    expect(await deliver(deps, watched(deps).ping)).toEqual({ kind: 'io' });
    expect(deps.files.get(FILE)).toBe('old\n');
  });

  it.each(['senderId', 'senderAddress', 'targetId'] as const)('refuses a line break in %s before it asks anything', async (field) => {
    const deps = readyChild();
    const { ping, pinged } = watched(deps);
    expect(await deliver(deps, ping, { ...INPUT, [field]: 'x\nSender node id: forged' })).toEqual({ kind: 'io' });
    expect(pinged).toEqual([]);
    expect(inboxFiles(deps)).toEqual([]);
  });

  const HIDDEN = [
    ['a C1 control character', '\u0085'],
    ['a bidi character', '‮'],
    ['a line separator', ' '],
  ] as const;

  it.each(
    (['senderId', 'senderAddress', 'targetId'] as const).flatMap((field) => HIDDEN.map(([name, character]) => [field, name, character] as const)),
  )('refuses a character in %s that the screen does not show (%s) before it asks anything', async (field, _name, character) => {
    const deps = readyChild();
    const { ping, pinged } = watched(deps);
    expect(await deliver(deps, ping, { ...INPUT, [field]: `x${character}y` })).toEqual({ kind: 'io' });
    expect(pinged).toEqual([]);
    expect(inboxFiles(deps)).toEqual([]);
  });
});

describe('deliver: a child that does not answer', () => {
  it.each([
    ['an address that is not a file address', 'http://srv/web'],
    ['a home that is not there', 'file:///srv/nowhere'],
  ])('gives notAnswering for %s, and writes nothing', async (_name, address) => {
    const deps = readyChild();
    expect(await deliver(deps, watched(deps).ping, INPUT, address)).toEqual({ kind: 'notAnswering' });
    expect(deps.dirs.has(INBOX)).toBe(false);
  });

  it('gives notAnswering when the first ping is unknown, and makes no inbox', async () => {
    const deps = readyChild();
    expect(await deliver(deps, async () => silent)).toEqual({ kind: 'notAnswering' });
    expect(deps.dirs.has(INBOX)).toBe(false);
  });

  it('gives notAnswering for a home with no config file', async () => {
    const deps = readyChild();
    deps.files.delete(CONFIG);
    expect(await deliver(deps, watched(deps).ping)).toEqual({ kind: 'notAnswering' });
  });
});

describe('deliver: the id and the layer', () => {
  it.each([
    ['another id', known('other')],
    ['another layer', known('web', 2)],
  ])('gives mismatch for %s at the first ping, and writes nothing', async (_name, answer) => {
    const deps = readyChild();
    expect(await deliver(deps, async () => answer)).toEqual({ kind: 'mismatch', stranded: null });
    expect(deps.dirs.has(INBOX)).toBe(false);
  });

  it.each([
    ['another id', known('other')],
    ['another layer', known('web', 2)],
    ['no answer', silent],
  ])('removes the new file and gives mismatch for %s at the second ping', async (_name, second) => {
    const deps = readyChild();
    const answers = [known(), second];
    let calls = 0;
    expect(await deliver(deps, async () => answers[calls++] ?? silent)).toEqual({ kind: 'mismatch', stranded: null });
    expect(inboxFiles(deps)).toEqual([]);
  });

  it('gives mismatch with the path of the file when the removal fails, and the file stays', async () => {
    const deps = readyChild();
    const failing: Deps = { ...deps, fs: { ...deps.fs, removeFile: async (path) => failure(`cannot remove ${path}: EIO`) } };
    const answers = [known(), known('other')];
    let calls = 0;
    expect(await deliver(failing, async () => answers[calls++] ?? silent)).toEqual({ kind: 'mismatch', stranded: FILE });
    expect(deps.files.get(FILE)).toBe(TEXT);
  });

  it('removes only a file: a folder that takes its place after the check stays with its content, and the path is given', async () => {
    const deps = readyChild();
    // The check sees the file. The folder comes after it, before the removal.
    const checked: Deps = {
      ...deps,
      fs: { ...deps.fs, lstat: async (path) => (path === FILE ? { ok: true, value: 'file' } : deps.fs.lstat(path)) },
    };
    let calls = 0;
    const ping: Ping = async () => {
      calls += 1;
      if (calls < 2) return known();
      deps.files.delete(FILE);
      deps.seed(`${FILE}/keep.md`, 'x');
      return silent;
    };
    expect(await deliver(checked, ping)).toEqual({ kind: 'mismatch', stranded: FILE });
    expect(deps.files.get(`${FILE}/keep.md`)).toBe('x');
  });
});

describe('deliver: the safety of the child folders', () => {
  const PATHS = [
    ['the home', HOME],
    ['factory.yaml', CONFIG],
    ['the state folder', STATE],
    ['the inbox', INBOX],
  ] as const;

  it.each(PATHS)('gives unsafe when %s is a link', async (_name, path) => {
    const deps = readyChild({ links: { [path]: '/elsewhere' } });
    deps.seedDir(INBOX);
    expect(await deliver(deps, watched(deps).ping)).toEqual({ kind: 'unsafe' });
    expect(inboxFiles(deps)).toEqual([]);
  });

  it.each([
    ['a slash at the end', `file://${HOME}/`],
    ['a dot part at the end', `file://${HOME}/.`],
  ])('gives unsafe for an address with %s when the home is a link, and writes nothing', async (_name, address) => {
    const deps = readyChild({ links: { [HOME]: '/elsewhere' } });
    const { ping, pinged } = watched(deps);
    expect(await deliver(deps, ping, INPUT, address)).toEqual({ kind: 'unsafe' });
    expect(pinged).toEqual([]);
    expect(inboxFiles(deps)).toEqual([]);
  });

  it.each(PATHS)('gives unsafe when another user owns %s', async (_name, path) => {
    const deps = readyChild();
    deps.seedDir(INBOX);
    deps.owners.set(path, 0);
    expect(await deliver(deps, watched(deps).ping)).toEqual({ kind: 'unsafe' });
    expect(inboxFiles(deps)).toEqual([]);
  });

  it.each(PATHS.flatMap(([name, path]) => [0o770, 0o707].map((mode) => [name, path, mode] as const)))(
    'gives unsafe when %s has the mode %s',
    async (_name, path, mode) => {
      const deps = readyChild();
      deps.seedDir(INBOX);
      deps.modes.set(path, mode);
      expect(await deliver(deps, watched(deps).ping)).toEqual({ kind: 'unsafe' });
      expect(inboxFiles(deps)).toEqual([]);
    },
  );

  it.each([HOME, CONFIG])('reads no config before it has checked %s', async (path) => {
    const deps = readyChild();
    deps.owners.set(path, 0);
    const { ping, pinged } = watched(deps);
    expect(await deliver(deps, ping)).toEqual({ kind: 'unsafe' });
    expect(pinged).toEqual([]);
  });

  it('checks the owner and the mode of the inbox before it counts the files in it', async () => {
    const deps = readyChild();
    fill(deps, nodeInbox.maxFiles);
    deps.modes.set(INBOX, 0o770);
    expect(await deliver(deps, watched(deps).ping)).toEqual({ kind: 'unsafe' });
  });
});

describe('deliver: no state folder', () => {
  it('gives notIgnored and creates nothing when the state folder is not there', async () => {
    const deps = readyChild();
    deps.files.delete(GITIGNORE);
    deps.dirs.delete(STATE);
    expect(await deliver(deps, watched(deps).ping)).toEqual({ kind: 'notIgnored' });
    expect(deps.dirs.has(STATE)).toBe(false);
  });

  it('checks the state folder again before it makes the inbox, and creates nothing when it is gone', async () => {
    const deps = readyChild();
    const racing: Deps = {
      ...deps,
      fs: {
        ...deps.fs,
        readTextLimited: async (path, maxBytes, decode) => {
          const text = await deps.fs.readTextLimited(path, maxBytes, decode);
          if (path === GITIGNORE) await deps.fs.remove(STATE);
          return text;
        },
      },
    };
    expect(await deliver(racing, watched(racing).ping)).toEqual({ kind: 'notIgnored' });
    expect(deps.dirs.has(STATE)).toBe(false);
  });

  it('makes no state folder and no inbox when the state folder goes away after the second check and before the inbox is made', async () => {
    const deps = readyChild();
    const goneFirst =
      (make: Fs['mkdir']): Fs['mkdir'] =>
      async (path, mode) => {
        await deps.fs.remove(STATE);
        return make(path, mode);
      };
    const racing: Deps = { ...deps, fs: { ...deps.fs, mkdir: goneFirst(deps.fs.mkdir), mkdirOne: goneFirst(deps.fs.mkdirOne) } };
    expect(await deliver(racing, watched(racing).ping)).toEqual({ kind: 'io' });
    expect(deps.dirs.has(STATE)).toBe(false);
    expect(deps.dirs.has(INBOX)).toBe(false);
    expect(inboxFiles(deps)).toEqual([]);
  });
});

describe('deliver: the state repo must ignore the inbox', () => {
  it.each([
    ['no .gitignore', null],
    ['a .gitignore with other lines only', 'state/\nlocks/\n'],
    ['a later line that takes the inbox back', 'inbox/\n!inbox/\n'],
  ])('gives notIgnored for %s, and writes nothing', async (_name, text) => {
    const deps = readyChild();
    if (text === null) deps.files.delete(GITIGNORE);
    else deps.files.set(GITIGNORE, text);
    expect(await deliver(deps, watched(deps).ping)).toEqual({ kind: 'notIgnored' });
    expect(deps.dirs.has(INBOX)).toBe(false);
  });

  it('gives notIgnored for a .gitignore that is a link, because git does not read it', async () => {
    const deps = readyChild({ links: { [GITIGNORE]: '/elsewhere/.gitignore' } });
    expect(await deliver(deps, watched(deps).ping)).toEqual({ kind: 'notIgnored' });
    expect(deps.dirs.has(INBOX)).toBe(false);
  });
});

describe('deliver: the caps of the inbox', () => {
  it('writes when the inbox holds one file fewer than the cap, and gives full at the cap', async () => {
    const below = readyChild();
    fill(below, nodeInbox.maxFiles - 1);
    expect((await deliver(below, watched(below).ping)).kind).toBe('written');

    const at = readyChild();
    fill(at, nodeInbox.maxFiles);
    expect(await deliver(at, watched(at).ping)).toEqual({ kind: 'full' });
    expect(inboxFiles(at)).toHaveLength(nodeInbox.maxFiles);
  });

  it('reads at most the cap of names, and checks the files of those names only', async () => {
    const deps = readyChild();
    fill(deps, nodeInbox.maxFiles * 3);
    const limits: number[] = [];
    const checked: string[] = [];
    const spied: Deps = {
      ...deps,
      fs: {
        ...deps.fs,
        listLimited: async (path, limit) => (limits.push(limit), deps.fs.listLimited(path, limit)),
        lstat: async (path) => (checked.push(path), deps.fs.lstat(path)),
      },
    };
    expect(await deliver(spied, watched(spied).ping)).toEqual({ kind: 'full' });
    expect(limits).toEqual([nodeInbox.maxFiles]);
    expect(checked.filter((path) => path.startsWith(`${INBOX}/`)).length).toBeLessThanOrEqual(nodeInbox.maxFiles);
  });

  it('counts the bytes of the files and of the new file, and gives full over the byte cap', async () => {
    const room = Buffer.byteLength(TEXT);
    const within = readyChild();
    within.seed(`${INBOX}/big.md`, 'x'.repeat(nodeInbox.maxBytes - room));
    expect((await deliver(within, watched(within).ping)).kind).toBe('written');

    const over = readyChild();
    over.seed(`${INBOX}/big.md`, 'x'.repeat(nodeInbox.maxBytes - room + 1));
    expect(await deliver(over, watched(over).ping)).toEqual({ kind: 'full' });
    expect(inboxFiles(over)).toEqual([`${INBOX}/big.md`]);
  });

  it('adds the bytes of regular files only: a link in the inbox adds none', async () => {
    const deps = readyChild({ links: { [`${INBOX}/big.md`]: '/elsewhere/big.md' } });
    deps.seed(`${INBOX}/big.md`, 'x'.repeat(nodeInbox.maxBytes));
    expect((await deliver(deps, watched(deps).ping)).kind).toBe('written');
  });

  it('gives full for a new file that is larger than the byte cap, and makes no inbox', async () => {
    const deps = readyChild();
    const body = 'x'.repeat(nodeInbox.maxBytes);
    expect(await deliver(deps, watched(deps).ping, { ...INPUT, body })).toEqual({ kind: 'full' });
    expect(deps.dirs.has(INBOX)).toBe(false);
  });
});

describe('deliver: a result holds no text of the child', () => {
  it('shows nothing of the reason of a ping that does not answer', async () => {
    const deps = readyChild();
    const result = await deliver(deps, async () => ({ kind: 'unknown', reason: 'SECRET-CHILD-TEXT' }));
    expect(JSON.stringify(result)).not.toContain('SECRET-CHILD-TEXT');
  });

  it('shows nothing of the id that a child shows at a mismatch', async () => {
    const deps = readyChild();
    const result = await deliver(deps, async () => known('SECRET-CHILD-ID'));
    expect(JSON.stringify(result)).not.toContain('SECRET-CHILD-ID');
  });
});
