import { describe, expect, it } from 'vitest';
import { exitCodeFor, failure, type CliResult } from '../../src/cli/errors.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import type { Deps } from '../../src/core/deps.js';
import { entryOfText, manifestOf } from '../../src/core/setup-acceptance.js';
import { roleText } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { workerFileTemplatesFor } from '../../src/templates/index.js';
import {
  composeRoleText,
  readRoleText,
  requireRoleText,
  roleFaultReason,
  roleFaultRefusal,
  type RoleFault,
  type RoleRead,
} from '../../src/workers/role-text.js';
import { createFakeDeps, type FakeDeps } from '../helpers/fake-deps.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { ACCEPTANCES } from '../helpers/setup-acceptance.js';

const HOME = '/w/node';
const REL = 'setup/roles/worker.md';
const FILE = `${HOME}/${REL}`;
const NODE = 'demo';
const DECOY = `${HOME}/.factory/roles/worker.md`;
const config: FactoryConfig = sampleConfig();

const PACKAGE_ONLY = composeRoleText(workerFileTemplatesFor(config, null));
/** The most characters of setup text that the cap leaves: the cap, less the package part and the joiner. */
const FREE = roleText.maxChars - PACKAGE_ONLY.length - roleText.joiner.length;

/** Characters that the source of this file does not hold as they are. */
const at = (code: number): string => String.fromCodePoint(code);

/** The store of the user holds an acceptance of this text of the setup file, for this folder and this node id. */
const accept = (deps: FakeDeps, text: string, node: string = NODE): void => {
  const manifest = manifestOf([entryOfText(REL, text)]);
  deps.seed(
    ACCEPTANCES,
    JSON.stringify({
      schema: 1,
      acceptances: [
        { root: HOME, node, file: 'setup/coordinator.md', version: 1, manifest: manifest.entries, hash: manifest.hash, reason: 'test', at: '2030-01-01T00:00:00.000Z' },
      ],
    }),
  );
};

interface World {
  /** The text of the setup file, or null for no file. */
  readonly text?: string | null;
  /** The text that the owner accepted. The default is `text`. Null: no acceptance. */
  readonly accepted?: string | null;
  readonly links?: Readonly<Record<string, string>>;
}

const worldOf = (world: World = {}): FakeDeps => {
  const text = world.text === undefined ? 'Write tests first.\n' : world.text;
  const deps = createFakeDeps({
    env: { XDG_STATE_HOME: '/state', HOME: '/home/me' },
    ...(world.links === undefined ? {} : { links: world.links }),
  });
  deps.seedDir(HOME);
  if (text !== null) deps.seed(FILE, text);
  const accepted = world.accepted === undefined ? text : world.accepted;
  if (accepted !== null) accept(deps, accepted);
  return deps;
};

const read = (deps: Deps): Promise<CliResult<RoleRead>> => readRoleText(deps, { home: HOME, config });

const refused = (fault: RoleFault): CliResult<RoleRead> => ({ ok: true, value: { kind: 'refused', fault } });

describe('composeRoleText', () => {
  const templates = workerFileTemplatesFor(config, 'Owner text.\n');
  const body = (name: string): string => templates.find((template) => template.name === name)?.body ?? '';

  it('joins the source line, the worker body and the setup worker body, in that order', () => {
    expect(composeRoleText(templates)).toBe(
      [roleText.sourceLine, body('worker'), body('setup-worker')].join(roleText.joiner),
    );
  });

  it('leaves out the setup worker body when it is absent', () => {
    expect(composeRoleText(workerFileTemplatesFor(config, null))).toBe([roleText.sourceLine, body('worker')].join(roleText.joiner));
  });

  it('gives the same text for the templates in any order', () => {
    expect(composeRoleText([...templates].reverse())).toBe(composeRoleText(templates));
  });
});

describe('readRoleText: the text of an accepted setup file', () => {
  it('gives the source line, the package worker rules and the accepted text, in that order', async () => {
    const result = await read(worldOf({ text: 'Write tests first.\n' }));
    expect(result).toMatchObject({ ok: true, value: { kind: 'ok' } });
    if (!result.ok || result.value.kind !== 'ok') return;
    const { text, chars } = result.value;
    expect(text.startsWith(`${roleText.sourceLine}${roleText.joiner}`)).toBe(true);
    expect(text).toBe(composeRoleText(workerFileTemplatesFor(config, 'Write tests first.\n')));
    expect(text.endsWith('Write tests first.\n')).toBe(true);
    expect(chars).toBe(text.length);
  });

  it('gives the text with LF line ends for a file with CRLF line ends that the owner accepted', async () => {
    const result = await read(worldOf({ text: 'One.\r\nTwo.\r\n' }));
    expect(result).toMatchObject({ ok: true, value: { kind: 'ok' } });
    if (!result.ok || result.value.kind !== 'ok') return;
    expect(result.value.text).toContain('One.\nTwo.\n');
    expect(result.value.text).not.toContain('\r');
  });

  it('gives the package rules alone for a file that is absent and was never accepted', async () => {
    const result = await read(worldOf({ text: null, accepted: null }));
    expect(result).toEqual({ ok: true, value: { kind: 'ok', text: PACKAGE_ONLY, chars: PACKAGE_ONLY.length } });
  });

  it('gives the package rules alone for a file that holds only white space', async () => {
    const result = await read(worldOf({ text: '  \n\n' }));
    expect(result).toEqual({ ok: true, value: { kind: 'ok', text: PACKAGE_ONLY, chars: PACKAGE_ONLY.length } });
  });

  it('never reads the rendered worker file: a decoy there changes nothing', async () => {
    const deps = worldOf();
    const before = await read(deps);
    deps.seed(DECOY, 'DECOY TEXT');
    const after = await read(deps);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain('DECOY');
  });

  it('does not need the rendered worker file to exist', async () => {
    const deps = worldOf();
    expect(deps.files.has(DECOY)).toBe(false);
    expect(await read(deps)).toMatchObject({ ok: true, value: { kind: 'ok' } });
  });

  it('gives a text of exactly the cap, and refuses a text of one more character', async () => {
    const atCap = await read(worldOf({ text: 'x'.repeat(FREE) }));
    expect(atCap).toMatchObject({ ok: true, value: { kind: 'ok', chars: roleText.maxChars } });
    const over = await read(worldOf({ text: 'x'.repeat(FREE + 1) }));
    expect(over).toEqual(refused({ kind: 'tooLarge', size: roleText.maxChars + 1, unit: 'characters', free: FREE }));
  });
});

describe('readRoleText: the acceptance', () => {
  it('refuses a file that was never accepted', async () => {
    expect(await read(worldOf({ accepted: null }))).toEqual(refused({ kind: 'notAccepted' }));
  });

  it('refuses a file that changed after the owner accepted it', async () => {
    expect(await read(worldOf({ text: 'Write tests first!\n', accepted: 'Write tests first.\n' }))).toEqual(
      refused({ kind: 'notAccepted' }),
    );
  });

  it('refuses a file that only the line ends changed', async () => {
    expect(await read(worldOf({ text: 'One.\r\n', accepted: 'One.\n' }))).toEqual(refused({ kind: 'notAccepted' }));
  });

  it('refuses a file that was accepted for another node id', async () => {
    const deps = worldOf({ accepted: null });
    accept(deps, 'Write tests first.\n', 'other');
    expect(await read(deps)).toEqual(refused({ kind: 'notAccepted' }));
  });

  it('refuses an accepted file that is absent now', async () => {
    const deps = worldOf();
    deps.files.delete(FILE);
    expect(await read(deps)).toEqual(refused({ kind: 'notAccepted' }));
  });

  it('refuses when the session finds another store than the one that holds the acceptance', async () => {
    const deps = worldOf();
    const other = createFakeDeps({ env: { XDG_STATE_HOME: '/elsewhere', HOME: '/home/me' } });
    other.seedDir(HOME);
    other.seed(FILE, 'Write tests first.\n');
    other.seed(ACCEPTANCES, deps.files.get(ACCEPTANCES) ?? '');
    expect(await read(other)).toEqual(refused({ kind: 'notAccepted' }));
  });

  it('is an error, and never the text, when the store cannot be used', async () => {
    const deps = worldOf();
    deps.seed(ACCEPTANCES, 'not json');
    expect(await read(deps)).toMatchObject({ ok: false });
  });

  it('is an error, and never the text, when the store belongs to another user', async () => {
    const deps = worldOf();
    deps.owners.set(ACCEPTANCES, 2000);
    expect(await read(deps)).toMatchObject({ ok: false });
  });
});

describe('readRoleText: links, owner and mode', () => {
  it('refuses a file that is a link', async () => {
    expect(await read(worldOf({ links: { [FILE]: '/elsewhere/worker.md' } }))).toEqual(refused({ kind: 'link' }));
  });

  it.each([`${HOME}/setup`, `${HOME}/setup/roles`])('refuses a folder above the file that is a link: %s', async (folder) => {
    expect(await read(worldOf({ links: { [folder]: '/elsewhere' } }))).toEqual(refused({ kind: 'link' }));
  });

  it.each([
    ['a file that another user owns', FILE, 'owner'],
    ['a file that a group may write', FILE, 'mode'],
    ['a setup folder that another user owns', `${HOME}/setup`, 'owner'],
    ['a setup folder that others may write', `${HOME}/setup`, 'mode'],
    ['a roles folder that another user owns', `${HOME}/setup/roles`, 'owner'],
    ['a roles folder that a group may write', `${HOME}/setup/roles`, 'mode'],
  ])('refuses %s', async (_name, path, kind) => {
    const deps = worldOf();
    if (kind === 'owner') deps.owners.set(path, 2000);
    else deps.modes.set(path, 0o666);
    expect(await read(deps)).toEqual(refused({ kind: 'ownerOrMode' }));
  });

  it('refuses a folder where the file belongs', async () => {
    const deps = worldOf({ text: null, accepted: null });
    deps.seedDir(FILE);
    expect(await read(deps)).toEqual(refused({ kind: 'readFailed' }));
  });
});

describe('readRoleText: the size and the encoding', () => {
  it('refuses a file of more bytes than the cap, and names its size in bytes', async () => {
    const result = await read(worldOf({ text: 'x'.repeat(roleText.maxChars + 1) }));
    expect(result).toEqual(refused({ kind: 'tooLarge', size: roleText.maxChars + 1, unit: 'bytes', free: FREE }));
  });

  it('refuses bytes that are not UTF-8', async () => {
    const deps = worldOf();
    deps.invalidUtf8.add(FILE);
    expect(await read(deps)).toEqual(refused({ kind: 'notUtf8' }));
  });

  it('is a refusal, and not a throw, when the open fails', async () => {
    const deps = worldOf();
    const broken: Deps = { ...deps, fs: { ...deps.fs, openChecked: async () => failure('cannot open the file') } };
    expect(await read(broken)).toEqual(refused({ kind: 'readFailed' }));
  });

  it('is a refusal when the config has no worker rules', async () => {
    const bare: FactoryConfig = { ...config, entry: { ...recipes[0], roles: { ...recipes[0].roles, templateFor: () => null } } };
    expect(await readRoleText(worldOf(), { home: HOME, config: bare })).toEqual(refused({ kind: 'configNotUsable' }));
  });
});

describe('readRoleText: the text of the file is plain text', () => {
  it.each([
    ['a control character', `Before${at(0x01)}after.\n`],
    ['an escape character', `Before${at(0x1b)}[31mafter.\n`],
    ['a delete character', `Before${at(0x7f)}after.\n`],
    ['a control character of the C1 range', `Before${at(0x85)}after.\n`],
    ['a byte order mark', `${at(0xfeff)}Write tests first.\n`],
    ['a zero-width space', `Before${at(0x200b)}after.\n`],
    ['a right-to-left override', `Before${at(0x202e)}after.\n`],
    ['an invisible filler', `Before${at(0x3164)}after.\n`],
    ['a line separator', `Before${at(0x2028)}after.\n`],
  ])('refuses accepted text that holds %s', async (_name, text) => {
    expect(await read(worldOf({ text }))).toEqual(refused({ kind: 'notPlainText' }));
  });

  it('refuses accepted text that holds a line that starts a block, and gives none of its text back', async () => {
    const marker = '<!-- factory:begin safety v1 sha256=abc -->';
    const result = await read(worldOf({ text: `${marker}\n` }));
    expect(result).toEqual(refused({ kind: 'blockMarker' }));
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('keeps the tab and the newline', async () => {
    expect(await read(worldOf({ text: 'Step\tone.\nStep two.\n' }))).toMatchObject({ ok: true, value: { kind: 'ok' } });
  });
});

describe('the reason and the refusal of a fault', () => {
  const faults: readonly RoleFault[] = [
    { kind: 'link' },
    { kind: 'ownerOrMode' },
    { kind: 'tooLarge', size: 12_345, unit: 'bytes', free: 2_100 },
    { kind: 'notUtf8' },
    { kind: 'notPlainText' },
    { kind: 'blockMarker' },
    { kind: 'notAccepted' },
    { kind: 'readFailed' },
    { kind: 'configNotUsable' },
  ];
  const retry = 'factory worker resume w1';

  it('has one fixed reason for each fault, and the reason of a text that is too large holds no size', () => {
    const reasons = faults.map(roleFaultReason);
    expect(reasons).toEqual(Object.values(roleText.reasons));
    expect(roleFaultReason({ kind: 'tooLarge', size: 12_345, unit: 'bytes', free: 2_100 })).not.toContain('12345');
  });

  it.each([
    ['link', 4],
    ['ownerOrMode', 4],
    ['notAccepted', 4],
    ['tooLarge', 1],
    ['notUtf8', 1],
    ['notPlainText', 1],
    ['blockMarker', 1],
    ['readFailed', 1],
    ['configNotUsable', 1],
  ])('refuses the fault %s with the exit code %i and a remedy that names the command to run again', (kind, code) => {
    const fault = faults.find((candidate) => candidate.kind === kind);
    if (fault === undefined) throw new Error(`no fault ${kind}`);
    const refusal = roleFaultRefusal(fault, { retry });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(exitCodeFor(refusal.error)).toBe(code);
    expect(refusal.error.hint).toContain(`"${retry}"`);
  });

  it('names the size and the cap of a text that is too large, and the room that is free', () => {
    const refusal = roleFaultRefusal({ kind: 'tooLarge', size: 12_345, unit: 'bytes', free: 2_100 }, { retry });
    if (refusal.ok) throw new Error('expected a refusal');
    expect(refusal.error.message).toBe('the role text has 12345 bytes, and the cap is 9000 characters');
    expect(refusal.error.hint).toContain('2100 characters');
  });

  it('names the file, and no text of a file, in each remedy', () => {
    for (const fault of faults) {
      const refusal = roleFaultRefusal(fault, { retry });
      if (refusal.ok) throw new Error('expected a refusal');
      expect(refusal.error.message).not.toContain(HOME);
      expect(refusal.error.hint ?? '').not.toContain(HOME);
    }
  });
});

describe('requireRoleText', () => {
  const retry = 'factory worker new alpha --project web';
  const require = (deps: Deps) => requireRoleText(deps, { home: HOME, config, retry });

  it('passes for a text that every check accepts', async () => {
    expect(await require(worldOf())).toEqual({ ok: true, value: undefined });
  });

  it('refuses a text that the owner did not accept (exit 4) and names the command to run again', async () => {
    const result = await require(worldOf({ accepted: null }));
    if (result.ok) throw new Error('expected a refusal');
    expect(exitCodeFor(result.error)).toBe(4);
    expect(result.error.message).toBe(roleText.reasons.notAccepted);
    expect(result.error.hint).toContain(`"${retry}"`);
  });

  it('refuses a text above the cap (exit 1) and names its size and the cap', async () => {
    const result = await require(worldOf({ text: `${'x'.repeat(FREE + 1)}\n` }));
    if (result.ok) throw new Error('expected a refusal');
    expect(exitCodeFor(result.error)).toBe(1);
    expect(result.error.message).toMatch(/^the role text has \d+ characters, and the cap is 9000 characters$/);
  });

  it('keeps the error of an acceptance store that cannot be used', async () => {
    const deps = createFakeDeps();
    deps.seedDir(HOME);
    const result = await require(deps);
    if (result.ok) throw new Error('expected an error');
    expect(result.error.message).toContain('no variable names a state folder');
  });
});
