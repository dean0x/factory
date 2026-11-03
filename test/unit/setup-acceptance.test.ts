import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  acceptanceState,
  acceptPromptText,
  acceptSetup,
  collectManifest,
  manifestChange,
  manifestHash,
  manifestOf,
  readAcceptances,
  recordSetupAcceptance,
  visibleText,
  type AcceptanceInput,
  type Collected,
  type ManifestEntry,
} from '../../src/core/setup-acceptance.js';
import { env, setupAcceptance } from '../../src/names.js';
import { createFakeDeps, type FakeDeps } from '../helpers/fake-deps.js';

const ROOT = '/w/root';
const STATE = '/state';
const FOLDER = '/state/factory';
const STORE = '/state/factory/setup-acceptances.json';
const APPROVAL_STORE = '/state/factory/owner-records.json';
const NODE = 'demo';
const SETUP = 'setup/coordinator.md';

/** Characters that the source of this file does not hold as they are. */
const at = (code: number): string => String.fromCodePoint(code);
const RIGHT_TO_LEFT_OVERRIDE = at(0x202e);
const ZERO_WIDTH_SPACE = at(0x200b);
const BYTE_ORDER_MARK = at(0xfeff);
const LINE_SEPARATOR = at(0x2028);
const NEXT_LINE = at(0x85);
const E_ACUTE = at(0xe9);
const A_UMLAUT = at(0xe4);
const FULLWIDTH_TILDE = at(0xff5e);
const EMOJI = at(0x1f600);
const ESC = at(0x1b);

interface Options {
  readonly stdinIsTTY?: boolean;
  readonly stdoutIsTTY?: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly answer?: string;
}

const person = (options: Options = {}): FakeDeps => {
  const deps = createFakeDeps({
    env: options.env ?? { XDG_STATE_HOME: STATE, HOME: '/home/me' },
    stdinIsTTY: options.stdinIsTTY ?? true,
    stdoutIsTTY: options.stdoutIsTTY ?? true,
    prompt: () => ({ ok: true, value: options.answer ?? 'y' }),
  });
  deps.seedDir(ROOT);
  deps.seed(`${ROOT}/${SETUP}`, 'Write tests first.\n');
  return deps;
};

const collect = async (deps: FakeDeps, paths: readonly string[] = [SETUP], root = ROOT): Promise<Collected> => {
  const result = await collectManifest(deps, root, paths);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const inputOf = (collected: Collected, overrides: Partial<AcceptanceInput> = {}): AcceptanceInput => ({
  root: ROOT,
  node: NODE,
  file: SETUP,
  entries: collected.manifest.entries,
  reason: 'a test',
  ...overrides,
});

const stored = (deps: FakeDeps): { schema: number; acceptances: Record<string, any>[] } =>
  JSON.parse(deps.files.get(STORE) ?? '{"schema":1,"acceptances":[]}');

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const entryOf = (path: string, text: string): ManifestEntry => ({
  path,
  type: 'file',
  size: Buffer.byteLength(text),
  sha256: sha256(text),
  blob: null,
});

describe('setup acceptance: the manifest and its hash (TP-171)', () => {
  it('holds the path, the type, the size, the SHA-256 of the bytes and the blob id of each file', async () => {
    const deps = person();
    deps.seed(`${ROOT}/.claude/settings.json`, '{}\n');
    const blob = 'a'.repeat(40);
    const result = await collectManifest(deps, ROOT, [SETUP, '.claude/settings.json'], new Map([[SETUP, blob]]));
    expect(result.ok && result.value.manifest.entries).toEqual([
      { path: '.claude/settings.json', type: 'file', size: 3, sha256: sha256('{}\n'), blob: null },
      { path: SETUP, type: 'file', size: 19, sha256: sha256('Write tests first.\n'), blob },
    ]);
  });

  it('hashes a header with the format version and one line for each file, with a NUL byte after the path', async () => {
    const collected = await collect(person());
    const expected = sha256(`factory setup manifest v1\n${SETUP}\0file\0${19}\0${sha256('Write tests first.\n')}\n`);
    expect(collected.manifest.hash).toBe(expected);
    expect(collected.manifest.version).toBe(1);
  });

  it('gives another hash when bytes move between a path and its content', async () => {
    const left = person();
    left.seed(`${ROOT}/a`, 'bc');
    const right = person();
    right.seed(`${ROOT}/ab`, 'c');
    const first = await collect(left, ['a']);
    const second = await collect(right, ['ab']);
    expect(`a${'bc'}`).toBe(`ab${'c'}`);
    expect(first.manifest.hash).not.toBe(second.manifest.hash);
  });

  it('gives another hash when two files swap their content', async () => {
    const left = person();
    left.seed(`${ROOT}/a.md`, 'X');
    left.seed(`${ROOT}/b.md`, 'Y');
    const right = person();
    right.seed(`${ROOT}/a.md`, 'Y');
    right.seed(`${ROOT}/b.md`, 'X');
    expect((await collect(left, ['a.md', 'b.md'])).manifest.hash).not.toBe(
      (await collect(right, ['a.md', 'b.md'])).manifest.hash,
    );
  });

  it('sorts the paths by their bytes, and not by a locale or by UTF-16 units', async () => {
    const deps = person();
    const names = ['z.md', `${A_UMLAUT}.md`, 'a.md', `${EMOJI}.md`, `${FULLWIDTH_TILDE}.md`, 'A.md'];
    for (const name of names) deps.seed(`${ROOT}/${name}`, name);
    const collected = await collect(deps, names);
    // The first byte: 'A' 0x41, 'a' 0x61, 'z' 0x7a, the umlaut 0xc3, the fullwidth tilde 0xef, the emoji 0xf0.
    // In UTF-16 the emoji (0xd83d) comes before the fullwidth tilde (0xff5e).
    expect(collected.manifest.entries.map((entry) => entry.path)).toEqual([
      'A.md',
      'a.md',
      'z.md',
      `${A_UMLAUT}.md`,
      `${FULLWIDTH_TILDE}.md`,
      `${EMOJI}.md`,
    ]);
  });

  it('gives one hash for one set of files, whatever the order of the list', async () => {
    const deps = person();
    deps.seed(`${ROOT}/b.md`, 'B');
    const one = await collect(deps, [SETUP, 'b.md']);
    const two = await collect(deps, ['b.md', SETUP, 'b.md']);
    expect(one.manifest.hash).toBe(two.manifest.hash);
    expect(manifestHash([...one.manifest.entries].reverse())).toBe(one.manifest.hash);
  });

  it('keeps the blob id out of the hash: the same bytes give one hash whether git tracks the file or not', async () => {
    const deps = person();
    const plain = await collect(deps);
    const tracked = await collectManifest(deps, ROOT, [SETUP], new Map([[SETUP, 'b'.repeat(40)]]));
    expect(tracked.ok && tracked.value.manifest.hash).toBe(plain.manifest.hash);
  });

  it('gives another hash for another size, another type or other bytes', () => {
    const base: ManifestEntry = { path: 'a', type: 'file', size: 1, sha256: sha256('x'), blob: null };
    const hashes = [
      manifestHash([base]),
      manifestHash([{ ...base, size: 2 }]),
      manifestHash([{ ...base, type: 'link' }]),
      manifestHash([{ ...base, sha256: sha256('y') }]),
      manifestHash([]),
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('puts the format version in each record of the store', async () => {
    const deps = person();
    await recordSetupAcceptance(deps, inputOf(await collect(deps)));
    expect(stored(deps).acceptances[0]).toMatchObject({ version: 1 });
    expect(setupAcceptance.formatVersion).toBe(1);
  });

  it('reads the text from the bytes that the hash covers, for a file within the display bound', async () => {
    const collected = await collect(person());
    expect(collected.texts.get(SETUP)).toBe('Write tests first.\n');
  });

  it('gives no text for a file over the display bound, and the hash still covers all of its bytes', async () => {
    const deps = person();
    const big = 'x'.repeat(setupAcceptance.maxDisplayBytes + 1);
    deps.seed(`${ROOT}/big.md`, big);
    const collected = await collect(deps, ['big.md']);
    expect(collected.texts.get('big.md')).toBeNull();
    expect(collected.manifest.entries[0]).toMatchObject({ size: big.length, sha256: sha256(big) });
  });

  it('counts a link as a link', async () => {
    const deps = createFakeDeps({ links: { [`${ROOT}/link.md`]: `${ROOT}/${SETUP}` } });
    deps.seed(`${ROOT}/${SETUP}`, 'text');
    deps.seed(`${ROOT}/link.md`, 'text');
    const collected = await collect(deps, ['link.md']);
    expect(collected.manifest.entries[0]).toMatchObject({ path: 'link.md', type: 'link' });
  });

  it('stops for a file that is not there, for a folder and for a path that leaves the folder', async () => {
    const deps = person();
    deps.seedDir(`${ROOT}/setup/roles`);
    for (const path of ['missing.md', 'setup/roles', '../x', '/etc/hosts', 'a/../../x']) {
      expect(await collectManifest(deps, ROOT, [path]), path).toMatchObject({ ok: false });
    }
  });

  it('stops with exit 4 for a list over the bound, and reads at the bound', async () => {
    const deps = person();
    const paths = Array.from({ length: setupAcceptance.maxManifestFiles + 1 }, (_, index) => `f${index}.md`);
    for (const path of paths) deps.seed(`${ROOT}/${path}`, 'x');
    expect(await collectManifest(deps, ROOT, paths)).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(await collectManifest(deps, ROOT, paths.slice(1))).toMatchObject({ ok: true });
  });

  it('compares with an accepted manifest: added, removed and changed files', () => {
    const accepted = [entryOf('a', '1'), entryOf('b', '2'), entryOf('c', '3')];
    const current = [entryOf('a', '1'), entryOf('b', '22'), entryOf('d', '4')];
    expect(manifestChange(accepted, current)).toEqual({ added: ['d'], removed: ['c'], changed: ['b'] });
    expect(manifestChange(null, current)).toEqual({ added: ['a', 'b', 'd'], removed: [], changed: [] });
    expect(manifestChange(current, current)).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe('setup acceptance: the visible text', () => {
  it('shows each control character apart from the newline and the tab as an escape', () => {
    expect(visibleText(`a${ESC}[2Jb${at(0)}c${at(13)}d${at(0x7f)}e${NEXT_LINE}f`)).toBe('a\\x1b[2Jb\\x00c\\x0dd\\x7fe\\x85f');
    expect(visibleText('line\n\tindent')).toBe('line\n\tindent');
  });

  it('shows the characters that only format text as an escape', () => {
    const text = `a${RIGHT_TO_LEFT_OVERRIDE}b${ZERO_WIDTH_SPACE}c${BYTE_ORDER_MARK}d${LINE_SEPARATOR}e`;
    expect(visibleText(text)).toBe('a\\u{202e}b\\u{200b}c\\u{feff}d\\u{2028}e');
  });

  it('leaves other text as it is', () => {
    const text = `${E_ACUTE}crire des tests. ${EMOJI}`;
    expect(visibleText(text)).toBe(text);
  });
});

describe('setup acceptance: the accept prompt (TP-161, TP-162)', () => {
  const collectedOf = (files: Record<string, string | null>, sizes: Record<string, number> = {}): Collected => ({
    manifest: manifestOf(
      Object.entries(files).map(([path, text]) => ({ ...entryOf(path, text ?? ''), size: sizes[path] ?? Buffer.byteLength(text ?? '') })),
    ),
    texts: new Map(Object.entries(files)),
  });

  it('names each added, removed and changed file, and shows the full text of the added and changed files only', () => {
    const current = collectedOf({ 'new.md': 'NEW TEXT', 'edit.md': 'EDITED TEXT', 'same.md': 'SAME TEXT' });
    const accepted = [entryOf('edit.md', 'OLD TEXT'), entryOf('same.md', 'SAME TEXT'), entryOf('gone.md', 'GONE TEXT')];
    const text = acceptPromptText({ root: ROOT, node: NODE, current, accepted });
    expect(text).toContain('Added files:\n  new.md');
    expect(text).toContain('Changed files:\n  edit.md');
    expect(text).toContain('Removed files:\n  gone.md');
    expect(text).toContain('NEW TEXT');
    expect(text).toContain('EDITED TEXT');
    expect(text).not.toContain('SAME TEXT');
    expect(text).not.toContain('GONE TEXT');
    expect(text).not.toContain('OLD TEXT');
  });

  it('shows every file as added when no acceptance exists, with the hash of all files', () => {
    const current = collectedOf({ [SETUP]: 'TEXT' });
    const text = acceptPromptText({ root: ROOT, node: NODE, current, accepted: null });
    expect(text).toContain(`Added files:\n  ${SETUP}`);
    expect(text).not.toContain('Changed files');
    expect(text).toContain(current.manifest.hash);
  });

  it('shows a control character of a file text and of a file name as an escape, and no raw one', () => {
    const current = collectedOf({ [`odd${ESC}.md`]: `before${ESC}[31mred${at(7)}${RIGHT_TO_LEFT_OVERRIDE}after` });
    const text = acceptPromptText({ root: ROOT, node: NODE, current, accepted: null });
    expect(text).toContain('before\\x1b[31mred\\x07\\u{202e}after');
    expect(text).toContain('odd\\x1b.md');
    for (const raw of [ESC, at(7), RIGHT_TO_LEFT_OVERRIDE]) expect(text).not.toContain(raw);
  });

  it('asks with no as the default', () => {
    const text = acceptPromptText({ root: ROOT, node: NODE, current: collectedOf({ a: 'A' }), accepted: null });
    expect(text.endsWith('Accept these files? [y/N] ')).toBe(true);
  });

  it('shows a file at the display bound in full', () => {
    const body = 'y'.repeat(setupAcceptance.maxDisplayBytes);
    const text = acceptPromptText({ root: ROOT, node: NODE, current: collectedOf({ 'edge.md': body }), accepted: null });
    expect(text).toContain(body);
  });

  it('says that it does not show the full text of a file over the bound, names the path and the command to read it', () => {
    const size = setupAcceptance.maxDisplayBytes + 1;
    const current = collectedOf({ 'big.md': null }, { 'big.md': size });
    const text = acceptPromptText({ root: ROOT, node: NODE, current, accepted: null });
    expect(text).toContain('does not show the full text of this file');
    expect(text).toContain(`This file has ${size} bytes. The limit is ${setupAcceptance.maxDisplayBytes} bytes.`);
    expect(text).toContain('big.md');
    expect(text).toContain(`Read it with: cat -v -- '${ROOT}/big.md'`);
    expect(text.endsWith('[y/N] ')).toBe(true);
  });

  it('shows no part of a file over the bound', async () => {
    const deps = person();
    deps.seed(`${ROOT}/big.md`, `FIRST-LINE-OF-A-LONG-FILE\n${'x'.repeat(setupAcceptance.maxDisplayBytes)}`);
    const collected = await collect(deps, ['big.md']);
    const text = acceptPromptText({ root: ROOT, node: NODE, current: collected, accepted: null });
    expect(text).not.toContain('FIRST-LINE');
  });

  it('quotes a path with a single quote in the command', () => {
    const current = collectedOf({ "it's.md": null }, { "it's.md": setupAcceptance.maxDisplayBytes + 1 });
    const text = acceptPromptText({ root: ROOT, node: NODE, current, accepted: null });
    expect(text).toContain(`cat -v -- '${ROOT}/it'\\''s.md'`);
  });

  it('shows no more than the total bound in all, and treats the files past it like a file over the bound', () => {
    const each = setupAcceptance.maxDisplayBytes;
    const fitting = Math.floor(setupAcceptance.maxDisplayTotalBytes / each);
    const count = fitting + 2;
    const files = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`f${String(index).padStart(2, '0')}.md`, `${index}`.padEnd(each, '.')]),
    );
    const text = acceptPromptText({ root: ROOT, node: NODE, current: collectedOf(files), accepted: null });
    expect(text).toContain(`The files above use up the limit of ${setupAcceptance.maxDisplayTotalBytes} bytes.`);
    expect(text.split('does not show the full text of this file')).toHaveLength(count - fitting + 1);
  });

  it('says that a link is a link', async () => {
    const deps = createFakeDeps({ links: { [`${ROOT}/link.md`]: `${ROOT}/${SETUP}` } });
    deps.seed(`${ROOT}/link.md`, 'text');
    const text = acceptPromptText({ root: ROOT, node: NODE, current: await collect(deps, ['link.md']), accepted: null });
    expect(text).toContain('a link; the text is the text of its target');
  });
});

describe('setup acceptance: the accept step', () => {
  it('asks once, and writes the acceptance on yes', async () => {
    const deps = person({ answer: 'y' });
    const current = await collect(deps);
    const result = await acceptSetup(deps, { root: ROOT, node: NODE, file: SETUP, current, reason: 'accepted at the prompt' });
    expect(result).toEqual({ ok: true, value: true });
    expect(deps.prompts).toHaveLength(1);
    expect(deps.prompts[0]).toContain('Write tests first.');
    expect(stored(deps).acceptances).toEqual([
      expect.objectContaining({ root: ROOT, node: NODE, file: SETUP, hash: current.manifest.hash, reason: 'accepted at the prompt' }),
    ]);
  });

  it.each(['', 'n', 'no', 'maybe', ' '])('writes nothing for the answer "%s"', async (answer) => {
    const deps = person({ answer });
    const current = await collect(deps);
    const result = await acceptSetup(deps, { root: ROOT, node: NODE, file: SETUP, current, reason: 'a test' });
    expect(result).toEqual({ ok: true, value: false });
    expect(deps.files.has(STORE)).toBe(false);
  });

  it('accepts "yes" in any case with spaces around it', async () => {
    const deps = person({ answer: '  YES ' });
    const current = await collect(deps);
    expect(await acceptSetup(deps, { root: ROOT, node: NODE, file: SETUP, current, reason: 'a test' })).toEqual({ ok: true, value: true });
  });

  it('passes on a failure to read the answer, and writes nothing', async () => {
    const deps = createFakeDeps({ env: { XDG_STATE_HOME: STATE }, stdinIsTTY: true, stdoutIsTTY: true });
    deps.seedDir(ROOT);
    deps.seed(`${ROOT}/${SETUP}`, 'x');
    const current = await collect(deps);
    const result = await acceptSetup(deps, { root: ROOT, node: NODE, file: SETUP, current, reason: 'a test' });
    expect(result).toMatchObject({ ok: false });
    expect(deps.files.has(STORE)).toBe(false);
  });

  it('lists the change against the newest acceptance of the folder', async () => {
    const deps = person();
    deps.seed(`${ROOT}/keep.md`, 'KEEP TEXT');
    const first = await collect(deps, [SETUP, 'keep.md']);
    await acceptSetup(deps, { root: ROOT, node: NODE, file: SETUP, current: first, reason: 'first' });
    deps.seed(`${ROOT}/${SETUP}`, 'Changed text.\n');
    const second = await collect(deps, [SETUP, 'keep.md']);
    await acceptSetup(deps, { root: ROOT, node: NODE, file: SETUP, current: second, reason: 'second' });
    const prompt = deps.prompts[1] ?? '';
    expect(prompt).toContain(`Changed files:\n  ${SETUP}`);
    expect(prompt).toContain('Changed text.');
    expect(prompt).not.toContain('KEEP TEXT');
    expect(stored(deps).acceptances).toHaveLength(1);
    expect(stored(deps).acceptances[0]).toMatchObject({ hash: second.manifest.hash });
  });

  describe('each guard alone refuses, asks nothing and writes nothing', () => {
    const cases: readonly (readonly [string, Options])[] = [
      ['a factory session with a terminal window for input and output', { env: { XDG_STATE_HOME: STATE, [env.session]: 'demo' } }],
      ['no terminal window for input', { stdinIsTTY: false }],
      ['no terminal window for output', { stdoutIsTTY: false }],
    ];
    it.each(cases)('%s', async (_name, options) => {
      const deps = person(options);
      const current = await collect(deps);
      const result = await acceptSetup(deps, { root: ROOT, node: NODE, file: SETUP, current, reason: 'a test' });
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(deps.prompts).toEqual([]);
      expect(deps.files.has(STORE)).toBe(false);
    });
  });
});

describe('setup acceptance: the writer (TP-144, TP-184)', () => {
  describe('with a person in a terminal window outside a factory session', () => {
    it('writes the root, the node id, the file, the version, the manifest, the hash, the reason and the time', async () => {
      const deps = person();
      const collected = await collect(deps);
      expect(await recordSetupAcceptance(deps, inputOf(collected))).toEqual({ ok: true, value: undefined });
      expect(stored(deps)).toEqual({
        schema: 1,
        acceptances: [
          {
            root: ROOT,
            node: NODE,
            file: SETUP,
            version: 1,
            manifest: collected.manifest.entries,
            hash: collected.manifest.hash,
            reason: 'a test',
            at: '2030-01-02T03:04:05.678Z',
          },
        ],
      });
    });

    it('writes a set with files apart from the setup file, and a change of an old acceptance', async () => {
      const deps = person();
      deps.seed(`${ROOT}/.mcp.json`, '{}');
      const collected = await collect(deps, [SETUP, '.mcp.json']);
      expect(await recordSetupAcceptance(deps, inputOf(collected))).toMatchObject({ ok: true });
      expect(await recordSetupAcceptance(deps, inputOf(collected, { reason: 'again' }))).toMatchObject({ ok: true });
      expect(stored(deps).acceptances).toHaveLength(1);
    });

    it('keeps the acceptance of another node id of the same folder, and replaces the one of the same node id', async () => {
      const deps = person();
      const collected = await collect(deps);
      await recordSetupAcceptance(deps, inputOf(collected));
      await recordSetupAcceptance(deps, inputOf(collected, { node: 'other' }));
      await recordSetupAcceptance(deps, inputOf(collected, { reason: 'later' }));
      expect(stored(deps).acceptances.map((record) => `${record.node}:${record.reason}`).sort()).toEqual(['demo:later', 'other:a test']);
    });
  });

  describe('with no terminal window', () => {
    it('refuses a record when init with yes is not the caller, with exit 4 and a remedy that names init', async () => {
      const deps = person({ stdinIsTTY: false, stdoutIsTTY: false });
      const result = await recordSetupAcceptance(deps, inputOf(await collect(deps)));
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety', hint: expect.stringContaining('factory init') } });
      expect(deps.files.has(STORE)).toBe(false);
    });

    it.each([
      ['input only', { stdinIsTTY: true, stdoutIsTTY: false }],
      ['output only', { stdinIsTTY: false, stdoutIsTTY: true }],
    ])('refuses a record when a terminal window is there for %s', async (_name, options) => {
      const deps = person(options);
      expect(await recordSetupAcceptance(deps, inputOf(await collect(deps)))).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(deps.files.has(STORE)).toBe(false);
    });

    it('writes a first acceptance of the setup file for init with yes', async () => {
      const deps = person({ stdinIsTTY: false, stdoutIsTTY: false });
      const collected = await collect(deps);
      const result = await recordSetupAcceptance(deps, inputOf(collected, { reason: 'init with yes' }), { fromInitYes: true });
      expect(result).toEqual({ ok: true, value: undefined });
      expect(stored(deps).acceptances).toEqual([expect.objectContaining({ root: ROOT, node: NODE, file: SETUP, hash: collected.manifest.hash })]);
    });

    it('refuses a record that covers a file apart from the setup file, also for init with yes (TP-184)', async () => {
      const deps = person({ stdinIsTTY: false, stdoutIsTTY: false });
      deps.seed(`${ROOT}/.claude/settings.json`, '{}');
      const collected = await collect(deps, [SETUP, '.claude/settings.json']);
      const result = await recordSetupAcceptance(deps, inputOf(collected), { fromInitYes: true });
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety', hint: expect.stringContaining('factory init') } });
      expect(deps.files.has(STORE)).toBe(false);
    });

    it('refuses a record that covers only another file than the setup file, too', async () => {
      const deps = person({ stdinIsTTY: false, stdoutIsTTY: false });
      deps.seed(`${ROOT}/other.md`, 'x');
      const collected = await collect(deps, ['other.md']);
      expect(await recordSetupAcceptance(deps, inputOf(collected), { fromInitYes: true })).toMatchObject({ ok: false, error: { kind: 'safety' } });
    });

    it('refuses init with yes when an acceptance exists for the folder under the same node id', async () => {
      const deps = person({ stdinIsTTY: false, stdoutIsTTY: false });
      const collected = await collect(deps);
      await recordSetupAcceptance(deps, inputOf(collected), { fromInitYes: true });
      deps.seed(`${ROOT}/${SETUP}`, 'Changed text.\n');
      const changed = await collect(deps);
      const before = deps.files.get(STORE);
      const result = await recordSetupAcceptance(deps, inputOf(changed), { fromInitYes: true });
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety', hint: expect.stringContaining('factory init') } });
      expect(deps.files.get(STORE)).toBe(before);
    });

    it('refuses init with yes when an acceptance exists for the folder under another node id', async () => {
      const deps = person({ stdinIsTTY: false, stdoutIsTTY: false });
      const collected = await collect(deps);
      await recordSetupAcceptance(deps, inputOf(collected, { node: 'old' }), { fromInitYes: true });
      const result = await recordSetupAcceptance(deps, inputOf(collected, { node: 'new' }), { fromInitYes: true });
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(stored(deps).acceptances.map((record) => record.node)).toEqual(['old']);
    });

    it('writes a first acceptance for another folder next to the first one', async () => {
      const deps = person({ stdinIsTTY: false, stdoutIsTTY: false });
      deps.seedDir('/w/second');
      deps.seed(`/w/second/${SETUP}`, 'Second.\n');
      await recordSetupAcceptance(deps, inputOf(await collect(deps)), { fromInitYes: true });
      const second = await collect(deps, [SETUP], '/w/second');
      expect(await recordSetupAcceptance(deps, inputOf(second, { root: '/w/second' }), { fromInitYes: true })).toMatchObject({ ok: true });
      expect(stored(deps).acceptances).toHaveLength(2);
    });
  });

  describe('with a terminal window and init with yes (the yes flag never answers the prompt)', () => {
    it('refuses a record that covers a file apart from the setup file', async () => {
      const deps = person();
      deps.seed(`${ROOT}/.mcp.json`, '{}');
      const collected = await collect(deps, [SETUP, '.mcp.json']);
      expect(await recordSetupAcceptance(deps, inputOf(collected), { fromInitYes: true })).toMatchObject({ ok: false, error: { kind: 'safety' } });
    });
  });

  describe('inside a factory session', () => {
    const inSession = { XDG_STATE_HOME: STATE, [env.session]: 'demo' };

    it.each([
      ['a terminal window', {}],
      ['no terminal window', { stdinIsTTY: false, stdoutIsTTY: false }],
    ])('refuses with %s, and writes nothing', async (_name, options) => {
      const deps = person({ ...options, env: inSession });
      const result = await recordSetupAcceptance(deps, inputOf(await collect(deps)));
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(deps.files.has(STORE)).toBe(false);
    });

    it('refuses for init with yes, too', async () => {
      const deps = person({ stdinIsTTY: false, stdoutIsTTY: false, env: inSession });
      const result = await recordSetupAcceptance(deps, inputOf(await collect(deps)), { fromInitYes: true });
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(deps.files.has(STORE)).toBe(false);
    });
  });

  it('leaves the approval record store alone and has its own file in the same state folder (TP-143)', async () => {
    const deps = person({ stdinIsTTY: false, stdoutIsTTY: false });
    deps.seed(APPROVAL_STORE, '{"schema":1,"records":[]}\n');
    await recordSetupAcceptance(deps, inputOf(await collect(deps)), { fromInitYes: true });
    expect(deps.files.get(APPROVAL_STORE)).toBe('{"schema":1,"records":[]}\n');
    expect(deps.files.has(STORE)).toBe(true);
  });

  it('writes the file with mode 0600 in a folder of mode 0700', async () => {
    const deps = person();
    await recordSetupAcceptance(deps, inputOf(await collect(deps)));
    expect(deps.modes.get(STORE)).toBe(0o600);
    expect(deps.modes.get(FOLDER)).toBe(0o700);
  });

  it('refuses a state folder inside the factory folder', async () => {
    const deps = person({ env: { XDG_STATE_HOME: `${ROOT}/state`, HOME: '/home/me' } });
    const result = await recordSetupAcceptance(deps, inputOf(await collect(deps)));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(deps.files.has(`${ROOT}/state/factory/setup-acceptances.json`)).toBe(false);
  });

  it('refuses a reason with a control character', async () => {
    const deps = person();
    const result = await recordSetupAcceptance(deps, inputOf(await collect(deps), { reason: 'a\nb' }));
    expect(result).toMatchObject({ ok: false });
    expect(deps.files.has(STORE)).toBe(false);
  });

  describe('the size cap of the store', () => {
    it('refuses a file over the cap, in the reader and in the writer', async () => {
      const deps = person();
      deps.seed(STORE, ' '.repeat(setupAcceptance.maxBytes + 1));
      expect(await readAcceptances(deps, STORE)).toMatchObject({ ok: false, error: expect.stringContaining('larger than') });
      const result = await recordSetupAcceptance(deps, inputOf(await collect(deps)));
      expect(result).toMatchObject({ ok: false });
      expect(deps.files.get(STORE)).toBe(' '.repeat(setupAcceptance.maxBytes + 1));
    });

    it('reads a file at the cap', async () => {
      const deps = person();
      const body = '{"schema":1,"acceptances":[]}\n';
      deps.seed(STORE, body + ' '.repeat(setupAcceptance.maxBytes - body.length));
      expect(await readAcceptances(deps, STORE)).toEqual({ ok: true, value: [] });
    });

    it('holds at most the number of records that the cap names, and still replaces a record at the cap', async () => {
      const deps = person();
      const collected = await collect(deps);
      for (let index = 0; index < setupAcceptance.maxRecords; index += 1) {
        await recordSetupAcceptance(deps, inputOf(collected, { node: `n${index}` }));
      }
      expect(await recordSetupAcceptance(deps, inputOf(collected, { node: 'one-more' }))).toMatchObject({ ok: false });
      expect(stored(deps).acceptances).toHaveLength(setupAcceptance.maxRecords);
      expect(await recordSetupAcceptance(deps, inputOf(collected, { node: 'n3', reason: 'again' }))).toMatchObject({ ok: true });
    });
  });

  describe('who may use the file', () => {
    const seeded = async (): Promise<FakeDeps> => {
      const deps = person();
      await recordSetupAcceptance(deps, inputOf(await collect(deps)));
      return deps;
    };

    it.each([
      ['a file that a group may write', STORE, 'mode'],
      ['a folder that other users may write', FOLDER, 'mode'],
      ['a file that another user owns', STORE, 'owner'],
    ])('refuses %s', async (_name, path, kind) => {
      const deps = await seeded();
      if (kind === 'mode') deps.modes.set(path, 0o666);
      else deps.owners.set(path, 2000);
      expect(await readAcceptances(deps, STORE)).toMatchObject({ ok: false });
      expect(await acceptanceState(deps, { root: ROOT, node: NODE, hash: 'x' })).toMatchObject({ ok: false });
      expect(await recordSetupAcceptance(deps, inputOf(await collect(deps), { node: 'second' }))).toMatchObject({ ok: false });
      expect(stored(deps).acceptances).toHaveLength(1);
    });
  });
});

describe('setup acceptance: what the store says about a set of files', () => {
  it('has no acceptance for a folder with no record, under any node id', async () => {
    const deps = person();
    const collected = await collect(deps);
    expect(await acceptanceState(deps, { root: ROOT, node: NODE, hash: collected.manifest.hash })).toEqual({ ok: true, value: { state: 'none' } });
  });

  it('has the acceptance for the same folder, node id and hash', async () => {
    const deps = person();
    const collected = await collect(deps);
    await recordSetupAcceptance(deps, inputOf(collected));
    const state = await acceptanceState(deps, { root: ROOT, node: NODE, hash: collected.manifest.hash });
    expect(state).toMatchObject({ ok: true, value: { state: 'accepted', record: { hash: collected.manifest.hash } } });
  });

  it('calls a set with another hash a change of the newest acceptance', async () => {
    const deps = person();
    const collected = await collect(deps);
    await recordSetupAcceptance(deps, inputOf(collected));
    const state = await acceptanceState(deps, { root: ROOT, node: NODE, hash: 'f'.repeat(64) });
    expect(state).toMatchObject({ ok: true, value: { state: 'changed', record: { hash: collected.manifest.hash } } });
  });

  it('calls a set with the same hash under another node id a change, and not an acceptance', async () => {
    const deps = person();
    const collected = await collect(deps);
    await recordSetupAcceptance(deps, inputOf(collected, { node: 'old' }));
    const state = await acceptanceState(deps, { root: ROOT, node: 'new', hash: collected.manifest.hash });
    expect(state).toMatchObject({ ok: true, value: { state: 'changed', record: { node: 'old' } } });
  });

  it('has no acceptance for another folder', async () => {
    const deps = person();
    deps.seedDir('/w/second');
    const collected = await collect(deps);
    await recordSetupAcceptance(deps, inputOf(collected));
    expect(await acceptanceState(deps, { root: '/w/second', node: NODE, hash: collected.manifest.hash })).toMatchObject({
      ok: true,
      value: { state: 'none' },
    });
  });

  it('does not count a record file inside the folder', async () => {
    const deps = person();
    const collected = await collect(deps);
    deps.seed(`${ROOT}/setup-acceptances.json`, '{"schema":1,"acceptances":[]}');
    expect(await acceptanceState(deps, { root: ROOT, node: NODE, hash: collected.manifest.hash })).toMatchObject({ ok: true, value: { state: 'none' } });
  });

  it('is an error, and not a first acceptance, when the store cannot be read', async () => {
    const deps = person();
    deps.seed(STORE, 'not json');
    expect(await acceptanceState(deps, { root: ROOT, node: NODE, hash: 'x' })).toMatchObject({ ok: false });
  });
});
