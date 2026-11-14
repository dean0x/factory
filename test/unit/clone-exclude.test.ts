import { describe, expect, it } from 'vitest';
import { exitCodeOf } from '../../src/cli/errors.js';
import { cloneExclude } from '../../src/names.js';
import { ensureCloneExclude } from '../../src/workers/exclude.js';
import { createFakeDeps, withFsWatch, type FakeDeps } from '../helpers/fake-deps.js';
import { gitHandler, type FakeRepo } from '../helpers/git-fake.js';

const CLONE = '/w/web';
const COMMON = '/w/web/.git';
const EXCLUDE = '/w/web/.git/info/exclude';
const ENTRY = '/.claude/settings.local.json';
/** The text that `git clone` leaves in the exclude file of a new clone. */
const TEMPLATE = '# git ls-files --others --exclude-from=.git/info/exclude\n# Lines that start with \'#\' are comments.\n*.log\n';

const make = (repo: FakeRepo = {}, exclude: string | null = TEMPLATE): FakeDeps => {
  const deps = createFakeDeps({ run: gitHandler({ repos: { [CLONE]: repo } }).handler });
  deps.seedDir(COMMON);
  if (exclude !== null) deps.seed(EXCLUDE, exclude);
  return deps;
};

const added = async (deps: FakeDeps) => {
  const result = await ensureCloneExclude(deps, CLONE);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe('the exclude entry of a clone', () => {
  it('names the settings file of a work copy, anchored at the top of the work tree', () => {
    expect(cloneExclude.entry).toBe(ENTRY);
  });

  it('adds the entry after every line that the file has, and changes no other line', async () => {
    const deps = make();
    expect(await added(deps)).toBe('added');
    expect(deps.files.get(EXCLUDE)).toBe(`${TEMPLATE}${ENTRY}\n`);
  });

  it('puts the entry on a line of its own when the last line has no line end', async () => {
    const deps = make({}, '*.log\nbuild/');
    await added(deps);
    expect(deps.files.get(EXCLUDE)).toBe(`*.log\nbuild/\n${ENTRY}\n`);
  });

  it('writes the entry alone into an empty file', async () => {
    const deps = make({}, '');
    await added(deps);
    expect(deps.files.get(EXCLUDE)).toBe(`${ENTRY}\n`);
  });

  it('adds the entry once: a second call finds it and makes no write call', async () => {
    const deps = make();
    await added(deps);
    const after = deps.files.get(EXCLUDE);
    const calls: string[] = [];
    expect(await added(withFsWatch(deps, (method) => calls.push(method)))).toBe('present');
    expect(deps.files.get(EXCLUDE)).toBe(after);
    expect(calls.filter((method) => method === 'rename' || method === 'writeText' || method === 'writeTextAtomic')).toEqual([]);
    expect((after ?? '').split('\n').filter((line) => line === ENTRY)).toHaveLength(1);
  });

  it.each([
    ['the entry between other lines', `*.log\n${ENTRY}\nbuild/\n`],
    ['the entry with a Windows line end', `*.log\r\n${ENTRY}\r\n`],
    ['the entry with blanks at the end', `${ENTRY}  \n`],
    ['the entry as the last line, with no line end', `*.log\n${ENTRY}`],
  ])('finds %s and writes nothing', async (_name, text) => {
    const deps = make({}, text);
    expect(await added(deps)).toBe('present');
    expect(deps.files.get(EXCLUDE)).toBe(text);
  });

  it.each([
    ['a comment that holds the entry', `# ${ENTRY}\n`],
    ['an entry that is not anchored', '.claude/settings.local.json\n'],
    ['a longer path with the entry as its start', `${ENTRY}.bak\n`],
  ])('does not count %s', async (_name, text) => {
    const deps = make({}, text);
    expect(await added(deps)).toBe('added');
    expect(deps.files.get(EXCLUDE)).toBe(`${text}${ENTRY}\n`);
  });

  /** The permission bits that the call gives to the new exclude file: the mode of the temporary file that it renames. */
  const modeOfNewFile = async (deps: FakeDeps): Promise<number | undefined> => {
    let given: number | undefined;
    const fs = {
      ...deps.fs,
      writeTextExclusive: async (path: string, text: string, mode: number) => {
        if (path.startsWith(`${EXCLUDE}.tmp-`)) given = mode;
        return deps.fs.writeTextExclusive(path, text, mode);
      },
    };
    await added({ ...deps, fs });
    return given;
  };

  it('makes the info folder and the file when the repo has none, with the usual permission bits', async () => {
    const deps = make({}, null);
    expect(await modeOfNewFile(deps)).toBe(cloneExclude.fileMode);
    expect(deps.files.get(EXCLUDE)).toBe(`${ENTRY}\n`);
    expect(deps.modes.get('/w/web/.git/info')).toBe(cloneExclude.folderMode);
  });

  it('keeps the permission bits of a file that exists', async () => {
    const deps = make();
    deps.modes.set(EXCLUDE, 0o640);
    expect(await modeOfNewFile(deps)).toBe(0o640);
  });

  it('writes into the common git folder, so every work tree of the repo shares the entry', async () => {
    const deps = createFakeDeps({ run: gitHandler({ repos: { [CLONE]: { commonDir: '/store/web.git' } } }).handler });
    deps.seedDir('/store/web.git');
    deps.seed('/store/web.git/info/exclude', TEMPLATE);
    await added(deps);
    expect(deps.files.get('/store/web.git/info/exclude')).toBe(`${TEMPLATE}${ENTRY}\n`);
  });

  it('changes no file other than the exclude file, and leaves no lock file', async () => {
    const deps = make();
    deps.seed('/w/web/README.md', 'text\n');
    const before = new Map(deps.files);
    await added(deps);
    const changed = [...deps.files].filter(([path, text]) => before.get(path) !== text).map(([path]) => path);
    expect(changed).toEqual([EXCLUDE]);
    expect([...deps.files.keys()].filter((path) => path.includes('.lock') || path.includes('.tmp-'))).toEqual([]);
  });

  it('stops with exit code 4 for an exclude file that is a link, and writes nothing', async () => {
    const deps = createFakeDeps({
      run: gitHandler({ repos: { [CLONE]: {} } }).handler,
      links: { [EXCLUDE]: '/elsewhere/exclude' },
    });
    deps.seedDir(COMMON);
    deps.seed('/elsewhere/exclude', TEMPLATE);
    const result = await ensureCloneExclude(deps, CLONE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(exitCodeOf[result.error.kind]).toBe(4);
      expect(result.error.hint).toContain('factory doctor');
    }
    expect(deps.files.get('/elsewhere/exclude')).toBe(TEMPLATE);
  });

  it('stops with exit code 4 for an info folder that is a link', async () => {
    const deps = createFakeDeps({
      run: gitHandler({ repos: { [CLONE]: {} } }).handler,
      links: { '/w/web/.git/info': '/elsewhere' },
    });
    deps.seedDir(COMMON);
    deps.seedDir('/elsewhere');
    const result = await ensureCloneExclude(deps, CLONE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(exitCodeOf[result.error.kind]).toBe(4);
    expect([...deps.files.keys()].filter((path) => path.startsWith('/elsewhere'))).toEqual([]);
  });

  it('fails for an exclude path that is a folder', async () => {
    const deps = make({}, null);
    deps.seedDir(EXCLUDE);
    const result = await ensureCloneExclude(deps, CLONE);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });

  it('fails, and writes nothing, for a file larger than the read bound', async () => {
    const big = `${'#'.repeat(cloneExclude.maxBytes)}\n`;
    const deps = make({}, big);
    const result = await ensureCloneExclude(deps, CLONE);
    expect(result.ok).toBe(false);
    expect(deps.files.get(EXCLUDE)).toBe(big);
  });

  it('fails for a folder that is in no git repo', async () => {
    const deps = createFakeDeps({ run: gitHandler({ repos: {} }).handler });
    const result = await ensureCloneExclude(deps, CLONE);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(deps.files.size).toBe(0);
  });

  it('fails and writes nothing when another process holds the lock', async () => {
    const deps = make();
    deps.seed(`${EXCLUDE}${cloneExclude.lock.suffix}`, '1\n');
    const result = await ensureCloneExclude(deps, CLONE);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) expect(result.error.message).toContain('another process holds the lock');
    expect(deps.files.get(EXCLUDE)).toBe(TEMPLATE);
  });
});
