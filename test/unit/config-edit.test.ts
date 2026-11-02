import { describe, expect, it } from 'vitest';
import { parseYamlText } from '../../src/config/load.js';
import { renderConfig } from '../../src/config/render.js';
import { addChildText, removeChildText } from '../../src/config/edit.js';
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
    const original = renderConfig(sampleConfig());
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
    expect(added(renderConfig(sampleConfig()), { id: 'a', address: 'file:///x/y' })).toContain('address: "file:///x/y"');
  });

  it('writes a long address on one line', () => {
    const address = `file:///${'long-folder-name/'.repeat(10)}web-factory`;
    expect(address.length).toBeGreaterThan(100);
    const text = added(renderConfig(sampleConfig()), { id: 'web', address });
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
    const text = removed(added(renderConfig(sampleConfig())), 'web');
    expect(childrenOf(text)).toEqual([]);
    expect(text).toContain('children: []');
  });

  it('gives back the original text of a fresh config after an add and a remove', () => {
    const original = renderConfig(sampleConfig());
    expect(removed(added(original), 'web')).toBe(normalized(original));
  });

  it('refuses an id that is not a child, and a text that does not parse', () => {
    expect(removeChildText(OWNER_TEXT, 'nobody').ok).toBe(false);
    expect(removeChildText('a: [1\n', 'web').ok).toBe(false);
    expect(removeChildText('x: 1\n', 'web').ok).toBe(false);
  });
});
