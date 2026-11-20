import { describe, expect, it } from 'vitest';
import { parseYamlText } from '../../src/config/load.js';
import { renderConfig } from '../../src/config/render.js';
import { addChildText, removeChildText, removeGuardKeysText, setApprovalText, setGuardText } from '../../src/config/edit.js';
import type { ApprovalModes } from '../../src/recipes/index.js';
import { sampleConfig } from '../helpers/sample-config.js';

const WEB = { id: 'web', address: 'file:///srv/web-factory' };
const API = { id: 'api', address: 'file:///srv/api-factory' };

const childrenOf = (text: string): unknown => {
  const parsed = parseYamlText(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return (parsed.value as { children: unknown }).children;
};

/** The yaml library writes one space before a comment at the end of a line. This is the only change it makes to a layout. */
const normalized = (text: string): string => text.replace(/(\S) {2,}#/g, '$1 #');

const added = (text: string, link = WEB): string => {
  const result = addChildText(text, link);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const removed = (text: string, id: string): string => {
  const result = removeChildText(text, id);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

/** A config that a person edited: comments in every part, and a children list with notes. */
const OWNER_TEXT = `# my notes about this node
schema: 2   # keep at 2

node:
  id: demo     # also the tmux session
  layer: 2

owner:
  display: "Test Owner"
  prefix: "[From {owner}, typed by {node} at the owner's explicit instruction, {date}]"

session:
  permission_mode: auto
  effort: high
  model: default
  proxy: none

limits:
  memory_free_min_pct: 20
  disk_free_min_gb: 20
  load_max: cpu_count
  context_prepare_pct: 30
  context_max_pct: 40

tracker:
  kind: local

recipe:
  id: software
  variant: plain
  projects: []

parent: null

# The children of this node.
children:
  # the web node, owned by Ana
  - id: web
    address: "file:///srv/web-factory"   # on this machine

# the end
`;

describe('add a child to the config text', () => {
  it('turns the empty list of a fresh config into a block list with the child', () => {
    const original = renderConfig(sampleConfig()).local;
    const text = added(original);
    expect(childrenOf(text)).toEqual([WEB]);
    expect(text).toContain('children:\n  - id: web\n    address: "file:///srv/web-factory"\n');
    expect(text).not.toContain('children: []');
    const before = original.slice(0, original.indexOf('children: []'));
    expect(normalized(text).startsWith(normalized(before))).toBe(true);
  });

  it('keeps the comments, the blank lines and the order of the keys of the owner', () => {
    const text = added(OWNER_TEXT, API);
    expect(childrenOf(text)).toEqual([WEB, API]);
    const kept = normalized(OWNER_TEXT).split('\n').filter((line) => line !== '');
    for (const line of kept) expect(normalized(text)).toContain(line);
    expect(text.indexOf('# my notes about this node')).toBe(0);
    expect(text.indexOf('# the web node, owned by Ana')).toBeLessThan(text.indexOf('id: api'));
    expect(text.endsWith('# the end\n')).toBe(true);
    const keys = [...text.matchAll(/^([a-z_]+):/gm)].map((match) => match[1]);
    expect(keys).toEqual(['schema', 'node', 'owner', 'session', 'limits', 'tracker', 'recipe', 'parent', 'children']);
  });

  it('adds the key when the config has no children key', () => {
    const text = added(OWNER_TEXT.replace(/# The children[\s\S]*# the end\n/, ''));
    expect(childrenOf(text)).toEqual([WEB]);
  });

  it('writes the address as a quoted text, as the render does', () => {
    expect(added(renderConfig(sampleConfig()).local, { id: 'a', address: 'file:///x/y' })).toContain('address: "file:///x/y"');
  });

  it('writes a long address on one line', () => {
    const address = `file:///${'long-folder-name/'.repeat(10)}web-factory`;
    expect(address.length).toBeGreaterThan(100);
    const text = added(renderConfig(sampleConfig()).local, { id: 'web', address });
    expect(text).toContain(`    address: "${address}"\n`);
    expect(childrenOf(text)).toEqual([{ id: 'web', address }]);
  });

  it('refuses a text that does not parse, and a children key that is not a list', () => {
    expect(addChildText('a: [1\n', WEB).ok).toBe(false);
    expect(addChildText('children: 3\n', WEB).ok).toBe(false);
    expect(addChildText('- a\n- b\n', WEB).ok).toBe(false);
  });

  it('does not repeat the text in an error', () => {
    const result = addChildText('secret-token: [1\n', WEB);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain('secret-token');
  });
});

describe('remove a child from the config text', () => {
  it('removes only the entry of the id, with its own comments, and keeps the rest', () => {
    const two = added(OWNER_TEXT, API);
    const text = removed(two, 'web');
    expect(childrenOf(text)).toEqual([API]);
    expect(text).toContain('# The children of this node.');
    expect(text).toContain('# my notes about this node');
    expect(text).toContain('id: demo # also the tmux session');
    expect(text.endsWith('# the end\n')).toBe(true);
  });

  it('keeps the other entries and their notes when it removes the last one', () => {
    const two = added(OWNER_TEXT, API);
    const text = removed(two, 'api');
    expect(childrenOf(text)).toEqual([WEB]);
    expect(text).toContain('# the web node, owned by Ana');
    expect(text).toContain('# on this machine');
  });

  it('leaves an empty list when the last child goes', () => {
    const text = removed(added(renderConfig(sampleConfig()).local), 'web');
    expect(childrenOf(text)).toEqual([]);
    expect(text).toContain('children: []');
  });

  it('gives back the original text of a fresh config after an add and a remove', () => {
    const original = renderConfig(sampleConfig()).local;
    expect(removed(added(original), 'web')).toBe(normalized(original));
  });

  it('refuses an id that is not a child, and a text that does not parse', () => {
    expect(removeChildText(OWNER_TEXT, 'nobody').ok).toBe(false);
    expect(removeChildText('a: [1\n', 'web').ok).toBe(false);
    expect(removeChildText('x: 1\n', 'web').ok).toBe(false);
  });
});

describe('set the guard values in the config text', () => {
  it('changes only the named guard and keeps comments, blank lines and key order', () => {
    const original = '# my node\nschema: 1\n\nguards:\n  # keep this note\n  install-rules: on # local rule\n  resume-routines: off\n\nparent: null\n';
    expect(setGuardText(original, { 'install-rules': 'off' })).toEqual({
      ok: true,
      value: original.replace('install-rules: on', 'install-rules: off'),
    });
  });

  it('adds new guard ids at the end of a block map', () => {
    expect(setGuardText('guards: { install-rules: on }\n', { 'resume-routines': 'off' })).toEqual({
      ok: true,
      value: 'guards:\n  install-rules: on\n  resume-routines: off\n',
    });
  });

  it.each(['schema: 1\n', 'schema: 1\nguards: {}\n'])('adds guard values to an absent or empty map', (text) => {
    expect(setGuardText(text, { 'install-rules': 'on' })).toEqual({
      ok: true,
      value: 'schema: 1\nguards:\n  install-rules: on\n',
    });
  });

  it.each(['a: [1\n', '- a\n- b\n', 'guards: 3\n', 'guards: []\n', 'guards: null\n', 'guards:\n', 'guards: {}\nguards: {}\n'])(
    'refuses invalid text or a guard value that is not a map',
    (text) => expect(setGuardText(text, { 'install-rules': 'on' })).toMatchObject({ ok: false }),
  );

  it('does not repeat raw text in an error', () => {
    const result = setGuardText('private-value: [1\n', { 'install-rules': 'on' });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).not.toContain('private-value');
  });
});

describe('remove the keys of fixed guards from the config text', () => {
  const FIXED = ['clone-rules', 'hook-runtime'] as const;
  const removedKeys = (text: string): string => {
    const result = removeGuardKeysText(text, 'shared_guards', FIXED);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  const lines = [
    '# shared node',
    'schema: 1    # four spaces',
    'node:',
    '  id: demo  # two spaces',
    '  name: "Demo"      # six spaces',
    '',
    'shared_guards:',
    '  # keep this note',
    '  install-rules: on # one space',
    '  clone-rules: on    # a fixed guard',
    '  secrets: on\t# a tab',
    '  hook-runtime: on',
    '',
    'limits:',
    '  context_max_pct: 40        # eight spaces',
  ];

  it('removes only the lines of the fixed keys and keeps every other line byte for byte, with the spaces of its comment', () => {
    const original = `${lines.join('\n')}\n`;
    const expected = `${lines.filter((line) => !FIXED.some((id) => line.trimStart().startsWith(`${id}:`))).join('\n')}\n`;
    expect(removedKeys(original)).toBe(expected);
  });

  it('removes the key with its map when the map is left empty, and keeps every other line byte for byte', () => {
    const original = 'schema: 1    # four spaces\nshared_guards:\n  clone-rules: on  # two spaces\n  hook-runtime: on\nlimits:\n  context_max_pct: 40      # six spaces\n';
    expect(removedKeys(original)).toBe('schema: 1    # four spaces\nlimits:\n  context_max_pct: 40      # six spaces\n');
  });

  it('changes only the line of a flow map and keeps the other pairs as written', () => {
    const original = 'schema: 1    # four spaces\nshared_guards: {clone-rules: on, install-rules: on}\nlimits: {}  # two spaces\n';
    expect(removedKeys(original)).toBe('schema: 1    # four spaces\nshared_guards: { install-rules: on }\nlimits: {}  # two spaces\n');
  });

  it('gives back a text with none of the ids unchanged, and refuses a text that does not parse', () => {
    const original = 'schema: 1    # four spaces\nshared_guards:\n  install-rules: on  # two spaces\n';
    expect(removeGuardKeysText(original, 'shared_guards', FIXED)).toEqual({ ok: true, value: original });
    expect(removeGuardKeysText('shared_guards: [1\n', 'shared_guards', FIXED)).toMatchObject({ ok: false });
  });
});

describe('set the approval modes in the config text', () => {
  const MODES: ApprovalModes = { merge: 'delegated', release: 'owner' };

  const approvalOf = (text: string): unknown => {
    const parsed = parseYamlText(text);
    if (!parsed.ok) throw new Error(parsed.error);
    return (parsed.value as { approval: unknown }).approval;
  };

  const set = (text: string, modes: ApprovalModes = MODES): string => {
    const result = setApprovalText(text, modes);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };

  it('replaces the modes of a fresh local file and keeps every other line', () => {
    const original = renderConfig(sampleConfig()).local;
    const text = set(original);
    expect(approvalOf(text)).toEqual(MODES);
    expect(text).toContain('approval:\n  merge: delegated\n  release: owner\n');
    expect(normalized(text).replace(/approval:\n( {2}\S.*\n)+/, 'approval: {}\n')).toBe(
      normalized(original).replace(/approval:\n( {2}\S.*\n)+/, 'approval: {}\n'),
    );
  });

  it('keeps the comments, the blank lines and the order of the keys of the owner', () => {
    const owned = `${OWNER_TEXT}\napproval:\n  # the merge point\n  merge: owner   # the safe mode\n  release: owner\n`;
    const text = set(owned);
    expect(approvalOf(text)).toEqual(MODES);
    expect(text).toContain('# the merge point');
    expect(text).toContain('# my notes about this node');
    expect(text).toContain('id: demo # also the tmux session');
    expect(text.indexOf('approval:')).toBeGreaterThan(text.indexOf('children:'));
  });

  it('turns an empty map into a block map', () => {
    const text = set('schema: 1\napproval: {}\nparent: null\n');
    expect(text).toBe('schema: 1\napproval:\n  merge: delegated\n  release: owner\nparent: null\n');
  });

  it('adds the key when the file has none', () => {
    expect(approvalOf(set('schema: 1\nparent: null\n'))).toEqual(MODES);
  });

  it('refuses a text that does not parse, a document that is not a mapping and an approval that is not a mapping', () => {
    expect(setApprovalText('a: [1\n', MODES).ok).toBe(false);
    expect(setApprovalText('- a\n- b\n', MODES).ok).toBe(false);
    expect(setApprovalText('approval: 3\n', MODES).ok).toBe(false);
  });

  it('does not repeat the text in an error', () => {
    const result = setApprovalText('secret-token: [1\n', MODES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain('secret-token');
  });
});
