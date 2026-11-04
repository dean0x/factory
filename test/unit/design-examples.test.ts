import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfigTexts } from '../helpers/package-registry.js';

const DESIGN = join(__dirname, '..', '..', 'docs', 'design.md');
const SECTION = '### 4.4 ';
const FENCE = '```';

/**
 * The text of one section of the design: from its heading to the next heading of the same or a higher level. A line
 * inside a fenced block is never a heading, also when it starts with a hash.
 */
const sectionOf = (text: string, heading: string): string => {
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  const section: string[] = [];
  let inside = false;
  let fenced = false;
  for (const line of text.split('\n')) {
    if (line.trim().startsWith(FENCE)) fenced = !fenced;
    const marks = fenced ? null : /^(#+) /.exec(line);
    if (!inside && line.startsWith(heading)) inside = true;
    else if (inside && marks !== null && (marks[1]?.length ?? 0) <= level) break;
    if (inside) section.push(line);
  }
  return section.join('\n');
};

/** The fenced yaml blocks of a text, in order. */
const yamlBlocksOf = (text: string): string[] => {
  const blocks: string[] = [];
  const lines = text.split('\n');
  let current: string[] | null = null;
  for (const line of lines) {
    if (current === null && line.trim() === `${FENCE}yaml`) current = [];
    else if (current !== null && line.trim() === FENCE) {
      blocks.push(`${current.join('\n')}\n`);
      current = null;
    } else current?.push(line);
  }
  return blocks;
};

/**
 * The two values that `init` writes: the display name and the GitHub login of the owner. The design shows each as a
 * template marker, so the test gives each a value. Any other marker in an example stays, and fails the load.
 */
const filled = (local: string): string =>
  local
    .replace('"{{from git config user.name}}"', '"Test Owner"')
    .replace('"{{from gh api user}}"', '"some-login"');

describe('the example config files of the design (section 4.4)', () => {
  const section = sectionOf(readFileSync(DESIGN, 'utf8'), SECTION);
  const [shared, local, ...others] = yamlBlocksOf(section);

  it('has one shared example and one local example', () => {
    expect(section).toContain('factory.yaml');
    expect(shared).toMatch(/^schema: 2\b/);
    expect(local).toMatch(/^schema: 1\b/);
    expect(others).toEqual([]);
  });

  it('loads with the shared schema and the local schema', () => {
    const loaded = parseConfigTexts(shared ?? '', filled(local ?? ''));
    expect(loaded.ok ? null : loaded.error.message).toBeNull();
  });

  it('gives the project of the example one folder name as its path', () => {
    const loaded = parseConfigTexts(shared ?? '', filled(local ?? ''));
    expect(loaded.ok && loaded.value.recipe.projects.map((project) => project.path)).toEqual(['web']);
    expect(loaded.ok && loaded.value.core.sources).toEqual({ web: '/srv/code/web' });
  });
});
