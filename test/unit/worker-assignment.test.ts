import { describe, expect, it } from 'vitest';
import { exitCodeOf, failure, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { Deps, LinkKind } from '../../src/core/deps.js';
import { ok } from '../../src/core/result.js';
import { maxFileBytes } from '../../src/names.js';
import { readAssignment } from '../../src/workers/assignment.js';
import { createFakeDeps, withFsWatch, type FakeDeps } from '../helpers/fake-deps.js';
import { gitHandler } from '../helpers/git-fake.js';

const HOME = '/w/node';
const TREE = '/w/tree';
const AGAIN = 'worker new alpha --project web --assignment FILE';
const TEXT = '# Task\n\nFix the build.\n';

interface Setup {
  /** The working folder of the caller. Default: the work tree. */
  readonly cwd?: string;
  /** Files by path. The work tree and the factory folder exist, so their folders exist. */
  readonly files?: Readonly<Record<string, string>>;
  /** Links: a path under a key resolves to the same path under the value. The map can change during a test. */
  readonly links?: Record<string, string>;
  /** False: the working folder is in no git work tree. */
  readonly workTree?: boolean;
}

interface Made {
  readonly deps: FakeDeps;
  readonly links: Record<string, string>;
}

const make = (setup: Setup = {}): Made => {
  const links = setup.links ?? {};
  const repos = setup.workTree === false ? {} : { [TREE]: {}, [HOME]: {} };
  const { handler } = gitHandler({ repos });
  const deps = createFakeDeps({ cwd: setup.cwd ?? TREE, run: handler, links });
  deps.seedDir(HOME);
  deps.seedDir(TREE);
  for (const [path, text] of Object.entries(setup.files ?? {})) deps.seed(path, text);
  return { deps, links };
};

const read = (deps: Deps, path: string): Promise<CliResult<string>> => readAssignment(deps, { home: HOME, path, again: AGAIN });

const errorOf = (result: CliResult<string>): CliError => {
  if (result.ok) throw new Error('expected a refusal, but the check passed');
  return result.error;
};

const codeOf = (result: CliResult<string>): number => exitCodeOf[errorOf(result).kind];

const valueOf = (result: CliResult<string>): string => {
  if (!result.ok) throw new Error(`the check failed: ${result.error.message}`);
  return result.value;
};

/** The deps with another answer of `lstat` for one path: for example `other`, the kind of a FIFO. */
const withKind = (deps: FakeDeps, path: string, kind: LinkKind): Deps => ({
  ...deps,
  fs: { ...deps.fs, lstat: async (asked) => (asked === path ? ok(kind) : deps.fs.lstat(asked)) },
});

describe('TP-32: a source that the check refuses (exit 4) and changes nothing', () => {
  const refused = async (made: Made, path: string): Promise<CliError> => {
    const before = new Map(made.deps.files);
    const error = errorOf(await read(made.deps, path));
    expect(made.deps.files).toEqual(before);
    expect(made.deps.atomicWrites).toEqual([]);
    return error;
  };

  it('TP-32: refuses a file that is a link', async () => {
    const made = make({ files: { [`${TREE}/real.md`]: TEXT }, links: { [`${TREE}/task.md`]: `${TREE}/real.md` } });
    const error = await refused(made, `${TREE}/task.md`);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('link');
  });

  it('TP-32: refuses a file with a link in a folder above it, also when the link stays in the same folder tree', async () => {
    const made = make({
      files: { [`${TREE}/dir/task.md`]: TEXT },
      links: { [`${TREE}/dir`]: `${TREE}/real` },
    });
    const error = await refused(made, `${TREE}/dir/task.md`);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('link');
  });

  it('TP-32: refuses a file that a link in a folder above it moves out of the work tree', async () => {
    const made = make({ files: { [`${TREE}/dir/task.md`]: TEXT }, links: { [`${TREE}/dir`]: '/w/elsewhere' } });
    expect(exitCodeOf[(await refused(made, `${TREE}/dir/task.md`)).kind]).toBe(4);
  });

  it('TP-32: refuses a file outside the factory folder and outside the work tree', async () => {
    const made = make({ files: { '/w/other/task.md': TEXT } });
    const error = await refused(made, '/w/other/task.md');
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toContain('.factory/orders/');
    expect(error.hint).toContain('work tree');
  });

  it('TP-32: refuses every file when the working folder is in no work tree and the file is outside the factory folder', async () => {
    const made = make({ files: { [`${TREE}/task.md`]: TEXT }, workTree: false });
    expect(exitCodeOf[(await refused(made, `${TREE}/task.md`)).kind]).toBe(4);
  });

  it.each([
    ['a folder that starts with a dot in the work tree', `${TREE}/.hidden/task.md`],
    ['a file that starts with a dot in the work tree', `${TREE}/.env`],
    ['the settings folder of Claude Code in the work tree', `${TREE}/.claude/settings.local.json`],
    ['the git folder of the work tree', `${TREE}/.git/config`],
    ['a deep path with a dot part', `${TREE}/src/.cache/task.md`],
    ['the state folder of the factory folder', `${HOME}/.factory/state/heartbeat/a.json`],
    ['the folder of the workers in the factory folder', `${HOME}/.factory/workers/alpha/worker.json`],
    ['the backups of the factory folder', `${HOME}/.factory/backups/a.md`],
    ['a file below the orders folder that starts with a dot', `${HOME}/.factory/orders/.hidden.md`],
    ['the orders folder below the top of a work tree that is not the factory folder', `${TREE}/.factory/orders/task.md`],
  ])('TP-32: refuses %s', async (_name, path) => {
    const made = make({ files: { [path]: TEXT } });
    const error = await refused(made, path);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toContain('.factory/orders/');
  });

  it('TP-32: refuses the local config at the top of the factory folder', async () => {
    const made = make({ files: { [`${HOME}/factory.local.yaml`]: 'proxy: secret\n' } });
    const error = await refused(made, `${HOME}/factory.local.yaml`);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).not.toContain('secret');
  });

  it('TP-32: refuses the local config of the factory folder when the working folder is in a work tree that holds it', async () => {
    const made = make({ files: { [`${HOME}/factory.local.yaml`]: 'proxy: secret\n' }, cwd: HOME });
    expect(exitCodeOf[(await refused(made, 'factory.local.yaml')).kind]).toBe(4);
  });
});

describe('TP-32: a source that is not a plain text file (exit 2) changes nothing', () => {
  const refusedWith2 = async (made: Made | { readonly deps: Deps }, path: string): Promise<CliError> => {
    const error = errorOf(await read(made.deps, path));
    expect(exitCodeOf[error.kind]).toBe(2);
    return error;
  };

  it('TP-32: refuses a FIFO before it opens the file', async () => {
    const made = make({ files: { [`${TREE}/task.md`]: TEXT } });
    const opened: string[] = [];
    const watched = withFsWatch(withKind(made.deps, `${TREE}/task.md`, 'other'), (method, path) => {
      if (method === 'readTextLimited' || method === 'readText' || method === 'digestFile') opened.push(path);
    });
    await refusedWith2({ deps: watched }, `${TREE}/task.md`);
    expect(opened).toEqual([]);
  });

  it('TP-32: refuses a file of more than 1 MiB, and takes one of exactly 1 MiB', async () => {
    const big = make({ files: { [`${TREE}/big.md`]: 'a'.repeat(maxFileBytes + 1) } });
    await refusedWith2(big, `${TREE}/big.md`);
    const edge = make({ files: { [`${TREE}/edge.md`]: 'a'.repeat(maxFileBytes) } });
    expect(valueOf(await read(edge.deps, `${TREE}/edge.md`))).toHaveLength(maxFileBytes);
  });

  it('TP-32: refuses a file with a NUL byte, and does not repeat its text', async () => {
    const made = make({ files: { [`${TREE}/task.md`]: 'secret\0text' } });
    const error = await refusedWith2(made, `${TREE}/task.md`);
    expect(error.message).not.toContain('secret');
  });

  it('TP-32: refuses a file that is not valid UTF-8 (the decoder marks a bad byte with U+FFFD)', async () => {
    const made = make({ files: { [`${TREE}/task.md`]: 'secret � text' } });
    const error = await refusedWith2(made, `${TREE}/task.md`);
    expect(error.message).not.toContain('secret');
  });

  it('TP-32: refuses a folder where a file must be', async () => {
    const made = make({});
    made.deps.seedDir(`${TREE}/docs`);
    await refusedWith2(made, `${TREE}/docs`);
  });

  it('TP-32: refuses a file that does not exist', async () => {
    await refusedWith2(make({}), `${TREE}/missing.md`);
  });

  it('TP-32: refuses an empty path', async () => {
    await refusedWith2(make({}), '');
  });
});

describe('TP-33: a good source gives its text', () => {
  it('TP-33: reads a file of the work tree, by an absolute path and by a path from the working folder', async () => {
    const made = make({ files: { [`${TREE}/docs/task.md`]: TEXT } });
    expect(valueOf(await read(made.deps, `${TREE}/docs/task.md`))).toBe(TEXT);
    expect(valueOf(await read(made.deps, 'docs/task.md'))).toBe(TEXT);
  });

  it('TP-33: reads a file of the work tree from a folder below its top', async () => {
    const made = make({ files: { [`${TREE}/docs/task.md`]: TEXT, [`${TREE}/src/a.ts`]: '' }, cwd: `${TREE}/src` });
    made.deps.seedDir(`${TREE}/src`);
    expect(valueOf(await read(made.deps, '../docs/task.md'))).toBe(TEXT);
  });

  it('TP-33: reads a file of the orders folder of the factory folder', async () => {
    const made = make({ files: { [`${HOME}/.factory/orders/task.md`]: TEXT }, workTree: false });
    expect(valueOf(await read(made.deps, `${HOME}/.factory/orders/task.md`))).toBe(TEXT);
  });

  it('TP-33: reads a file below a folder of the orders folder', async () => {
    const made = make({ files: { [`${HOME}/.factory/orders/web/task.md`]: TEXT } });
    expect(valueOf(await read(made.deps, `${HOME}/.factory/orders/web/task.md`))).toBe(TEXT);
  });

  it('TP-33: reads a file of the factory folder that has no dot part', async () => {
    const made = make({ files: { [`${HOME}/notes/task.md`]: TEXT } });
    expect(valueOf(await read(made.deps, `${HOME}/notes/task.md`))).toBe(TEXT);
  });

  it('TP-33: reads the file once and no other file', async () => {
    const made = make({ files: { [`${TREE}/task.md`]: TEXT } });
    const reads: string[] = [];
    const watched = withFsWatch(made.deps, (method, path) => {
      if (method === 'readTextLimited' || method === 'readText' || method === 'digestFile') reads.push(path);
    });
    expect(valueOf(await read(watched, `${TREE}/task.md`))).toBe(TEXT);
    expect(reads).toEqual([`${TREE}/task.md`]);
  });

  it('TP-33: reads a file by the path of its real folder when the working folder is reached by a link', async () => {
    const { handler } = gitHandler({ repos: { '/w/link-tree': {}, [HOME]: {} } });
    const deps = createFakeDeps({ cwd: '/w/link-tree', run: handler, links: { '/w/link-tree': '/w/real-tree' } });
    deps.seed('/w/real-tree/task.md', TEXT);
    deps.seed('/w/link-tree/task.md', TEXT);
    deps.seedDir(HOME);
    expect(valueOf(await read(deps, 'task.md'))).toBe(TEXT);
  });
});

describe('TP-33: a source that changes during the read is refused (exit 4)', () => {
  /** The deps whose read runs `change` right after it returns its text. */
  const changingAfterRead = (deps: FakeDeps, change: () => void): Deps => ({
    ...deps,
    fs: {
      ...deps.fs,
      readTextLimited: async (path, maxBytes) => {
        const text = await deps.fs.readTextLimited(path, maxBytes);
        change();
        return text;
      },
    },
  });

  it('TP-33: refuses a file that became a link after the read', async () => {
    const made = make({ files: { [`${TREE}/task.md`]: TEXT, [`${TREE}/other.md`]: 'other\n' } });
    const deps = changingAfterRead(made.deps, () => {
      made.links[`${TREE}/task.md`] = `${TREE}/other.md`;
    });
    const result = await read(deps, `${TREE}/task.md`);
    expect(codeOf(result)).toBe(4);
    expect(errorOf(result).message).toContain('changed');
  });

  it('TP-33: refuses a file whose real path moved after the read, because a folder above it became a link', async () => {
    const made = make({ files: { [`${TREE}/dir/task.md`]: TEXT, '/w/elsewhere/task.md': 'other\n' } });
    const deps = changingAfterRead(made.deps, () => {
      made.links[`${TREE}/dir`] = '/w/elsewhere';
    });
    expect(codeOf(await read(deps, `${TREE}/dir/task.md`))).toBe(4);
  });

  it('TP-33: gives the text of a file that did not change', async () => {
    const made = make({ files: { [`${TREE}/task.md`]: TEXT } });
    const deps = changingAfterRead(made.deps, () => undefined);
    expect(valueOf(await read(deps, `${TREE}/task.md`))).toBe(TEXT);
  });
});

describe('TP-33: a fault of the file system in the check after the read is exit 1, and not a change of the file', () => {
  const FAULT = 'EIO: input/output error';

  /** The deps whose `lstat` of one path fails with a fault, from the moment the read of the file has returned its text. */
  const lstatFailingAfterRead = (deps: FakeDeps, path: string): Deps => {
    let readDone = false;
    return {
      ...deps,
      fs: {
        ...deps.fs,
        readTextLimited: async (asked, maxBytes) => {
          const text = await deps.fs.readTextLimited(asked, maxBytes);
          readDone = true;
          return text;
        },
        lstat: async (asked) => (readDone && asked === path ? failure(FAULT) : deps.fs.lstat(asked)),
      },
    };
  };

  /** The same for `realpath`. */
  const realpathFailingAfterRead = (deps: FakeDeps, path: string): Deps => {
    let readDone = false;
    return {
      ...deps,
      fs: {
        ...deps.fs,
        readTextLimited: async (asked, maxBytes) => {
          const text = await deps.fs.readTextLimited(asked, maxBytes);
          readDone = true;
          return text;
        },
        realpath: async (asked) => (readDone && asked === path ? failure(FAULT) : deps.fs.realpath(asked)),
      },
    };
  };

  it('TP-33: the second lstat of the file fails: the fault is exit 1, and the message does not say that the file changed', async () => {
    const made = make({ files: { [`${TREE}/task.md`]: TEXT } });
    const result = await read(lstatFailingAfterRead(made.deps, `${TREE}/task.md`), `${TREE}/task.md`);
    expect(codeOf(result)).toBe(1);
    expect(errorOf(result).message).toContain(FAULT);
    expect(errorOf(result).message).not.toContain('changed while it was read');
  });

  it('TP-33: the second realpath of the file fails: the fault is exit 1, and the message does not say that the file changed', async () => {
    const made = make({ files: { [`${TREE}/task.md`]: TEXT } });
    const result = await read(realpathFailingAfterRead(made.deps, `${TREE}/task.md`), `${TREE}/task.md`);
    expect(codeOf(result)).toBe(1);
    expect(errorOf(result).message).toContain(FAULT);
    expect(errorOf(result).message).not.toContain('changed while it was read');
  });
});
