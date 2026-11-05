import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { hookNames } from '../../src/names.js';

/** The folder of the Claude Code payload fixtures: the captured hook payloads and the status line payload. */
const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'claude');
const REPO_DIR = join(__dirname, '..', '..');

/** The limits of the walk over the fixtures. A walk that reaches a limit fails the test. */
const MAX_FILES = 20;
const MAX_FILE_BYTES = 1_000_000;
const MAX_DEPTH = 8;
const MAX_STRINGS = 500;

/** The only ids and the only path root that a fixture may hold. */
const PLACEHOLDER_ID = /^00000000-0000-4000-8000-0000000000[0-9a-f]{2}$/;
const PLACEHOLDER_ROOT = '/placeholder/';
const PLACEHOLDER_PATH = /\/placeholder\/[^\s"']*/g;
const ANY_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A key whose value is an id, and a key whose value is a path of the session. */
const ID_KEY = /_id$/;
const PATH_KEYS: readonly string[] = ['cwd', 'transcript_path'];
/** A folder that holds a user: the home folders, the temp folders and the folder of the transcripts of Claude Code. */
const REAL_FOLDER = /\/(?:users|home|private|tmp|var|root|volumes)\//i;
const TRANSCRIPT_FOLDER = /\.claude\/projects/;

interface Leaf {
  readonly key: string;
  readonly text: string;
}

interface Leaves {
  readonly leaves: readonly Leaf[];
  /** False when the walk stopped at a limit and did not read every string. */
  readonly complete: boolean;
}

/** Every string of a JSON value, with the last object key above it (the key of the array for an item). */
const leavesOf = (value: unknown): Leaves => {
  const leaves: Leaf[] = [];
  let complete = true;
  const visit = (node: unknown, key: string, depth: number): void => {
    if (typeof node === 'string') {
      if (leaves.length >= MAX_STRINGS) complete = false;
      else leaves.push({ key, text: node });
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    if (depth >= MAX_DEPTH) {
      complete = false;
      return;
    }
    const isList = Array.isArray(node);
    for (const [childKey, child] of Object.entries(node)) visit(child, isList ? key : childKey, depth + 1);
  };
  visit(value, '$', 0);
  return { leaves, complete };
};

interface RealValues {
  readonly homeDir: string;
  readonly repoDir: string;
}

/**
 * The reasons why a fixture holds a real value: an id that is not a placeholder, a path or cwd outside the placeholder
 * root, a folder of a user, the transcript folder of Claude Code, or the home or the repository folder of this machine.
 */
const realValuesIn = (fixture: unknown, real: RealValues): string[] => {
  const { leaves, complete } = leavesOf(fixture);
  const problems: string[] = complete ? [] : ['the walk reached a limit of depth or string count'];
  for (const { key, text } of leaves) {
    const found = (reason: string): void => {
      problems.push(`${key}: ${reason}`);
    };
    for (const id of text.match(ANY_ID) ?? []) if (!PLACEHOLDER_ID.test(id)) found(`id ${id} is not a placeholder`);
    if (ID_KEY.test(key) && !PLACEHOLDER_ID.test(text)) found('the id is not a placeholder');
    if (PATH_KEYS.includes(key) && !text.startsWith(PLACEHOLDER_ROOT)) found('the path is not a placeholder');
    if (REAL_FOLDER.test(text.replaceAll(PLACEHOLDER_PATH, ''))) found('the text holds a path of a user or a temp folder');
    if (TRANSCRIPT_FOLDER.test(text)) found('the text holds a path in the transcript folder');
    for (const folder of [real.homeDir, real.repoDir]) {
      if (folder.length > 1 && text.includes(folder)) found('the text holds a folder of this machine');
    }
  }
  return problems;
};

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8')) as unknown;

/** The JSON files of the fixture folder. A file over the size limit, or a folder over the file limit, is an error. */
const fixtureFiles = (): { readonly paths: string[]; readonly complete: boolean } => {
  const names = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json'));
  const paths = names.slice(0, MAX_FILES).map((name) => join(FIXTURE_DIR, name));
  const complete = names.length <= MAX_FILES && paths.every((path) => statSync(path).size <= MAX_FILE_BYTES);
  return { paths, complete };
};

const REAL: RealValues = { homeDir: homedir(), repoDir: REPO_DIR };

describe('the payload fixtures (TP-4)', () => {
  it('hold placeholders only: no real home path, cwd, transcript path or session id', () => {
    const files = fixtureFiles();
    expect(files.complete, 'the fixture folder reached a limit of file count or file size').toBe(true);
    expect(files.paths.length, 'the fixture folder holds no JSON file').toBeGreaterThan(0);
    for (const path of files.paths) expect(realValuesIn(readJson(path), REAL), path).toEqual([]);
  });
});

describe('the finder of real values in a fixture', () => {
  const synthetic: RealValues = { homeDir: '/data/example', repoDir: '/srv/checkout/factory' };
  const problemsOf = (value: unknown): string[] => realValuesIn(value, synthetic);

  it('accepts the placeholder id, the placeholder paths and free text', () => {
    const payload = {
      session_id: '00000000-0000-4000-8000-000000000001',
      prompt_id: '00000000-0000-4000-8000-000000000002',
      cwd: '/placeholder/home/coordinator',
      transcript_path: '/placeholder/home/transcripts/00000000-0000-4000-8000-000000000001.jsonl',
      prompt: 'Reply with the single word ok.',
      background_tasks: [],
      nothing: null,
    };
    expect(problemsOf(payload)).toEqual([]);
  });

  it.each([
    ['a session id', { session_id: 'a3f1c2d4-1b2c-4d5e-8f90-123456789abc' }],
    ['an id that is not a UUID', { prompt_id: 'abc' }],
    ['an id inside a longer text', { prompt: 'resume a3f1c2d4-1b2c-4d5e-8f90-123456789abc now' }],
    ['a cwd outside the placeholder root', { cwd: '/work/project' }],
    ['a cwd that holds the placeholder root only in the middle', { cwd: '/work/placeholder/project' }],
    ['a transcript path in the home folder', { transcript_path: '/Users/example/notes/a.jsonl' }],
    ['a home path in a free text', { prompt: 'open /Users/example/notes now' }],
    ['a home path in a list', { background_tasks: ['/home/example/job'] }],
    ['a home path next to a placeholder path', { prompt: '/placeholder/x then /Users/example/y' }],
    ['a temp folder path', { last_assistant_message: 'wrote /private/tmp/out' }],
    ['the transcript folder of Claude Code behind the placeholder root', { prompt: '/placeholder/home/.claude/projects/x' }],
    ['the home folder of this machine', { prompt: 'open /data/example/notes' }],
    ['the repository folder of this machine', { prompt: 'see /srv/checkout/factory/src' }],
  ])('finds %s', (_name, value) => {
    expect(problemsOf(value).length).toBeGreaterThan(0);
  });

  it('finds a real value in a nested object', () => {
    const nested = { statusline: { payload: { workspace: { cwd: '/work/project' } } } };
    expect(problemsOf(nested)).toEqual(['cwd: the path is not a placeholder']);
  });

  it('fails when the value is deeper than the limit, so that a real value cannot hide there', () => {
    let deep: unknown = { cwd: '/work/project' };
    for (let level = 0; level < MAX_DEPTH + 1; level += 1) deep = { inner: deep };
    expect(problemsOf(deep)).toEqual(['the walk reached a limit of depth or string count']);
  });
});

describe('payloads.json', () => {
  const fixture = readJson(join(FIXTURE_DIR, 'payloads.json'));

  const hookPayload = z.looseObject({
    session_id: z.string(),
    transcript_path: z.string(),
    cwd: z.string(),
    hook_event_name: z.string(),
  });
  const statusLinePayload = z.strictObject({
    session_id: z.string(),
    transcript_path: z.string(),
    model: z.strictObject({ display_name: z.string() }),
    cost: z.strictObject({ total_cost_usd: z.number() }),
    context_window: z.strictObject({
      context_window_size: z.number(),
      used_percentage: z.number().nullable(),
      current_usage: z
        .strictObject({
          input_tokens: z.number(),
          cache_creation_input_tokens: z.number(),
          cache_read_input_tokens: z.number(),
        })
        .nullable(),
    }),
    rate_limits: z.strictObject({
      five_hour: z.strictObject({ used_percentage: z.number() }),
      seven_day: z.strictObject({ used_percentage: z.number() }),
    }),
  });
  const payloadsFile = z.looseObject({
    claude_code_version: z.string().regex(/^\d+\.\d+\.\d+$/),
    hooks: z.record(z.string(), hookPayload),
    hook_sources: z.record(z.string(), z.strictObject({ captured: z.boolean(), source: z.string() })),
    statusline: z.looseObject({ captured: z.boolean(), source: z.string(), payload: statusLinePayload }),
  });

  it('holds the Claude Code version, one payload for each hook event and the status line payload', () => {
    const parsed = payloadsFile.safeParse(fixture);
    expect(parsed.success, parsed.success ? '' : parsed.error.message).toBe(true);
  });

  it('holds exactly one payload for each event of the fixed list, named by its event', () => {
    const parsed = payloadsFile.parse(fixture);
    expect(Object.keys(parsed.hooks).sort()).toEqual([...hookNames.events].sort());
    for (const [event, payload] of Object.entries(parsed.hooks)) expect(payload.hook_event_name).toBe(event);
  });

  it('TP-3: holds 6 payloads; the 2 new ones are not captured and name a docs source, and the Notification payload carries a type of the list', () => {
    const parsed = payloadsFile.parse(fixture);
    expect(Object.keys(parsed.hooks)).toHaveLength(6);
    expect(Object.keys(parsed.hook_sources).sort()).toEqual(['Notification', 'PreToolUse']);
    for (const source of Object.values(parsed.hook_sources)) {
      expect(source.captured).toBe(false);
      expect(source.source).toContain('https://code.claude.com/docs/en/hooks');
    }
    const type = parsed.hooks['Notification']?.['notification_type'];
    expect(typeof type === 'string' && (hookNames.notificationTypes as readonly string[]).includes(type)).toBe(true);
    expect(hookNames.notificationTypes).not.toContain('idle_prompt');
    expect(parsed.hooks['PreToolUse']).not.toHaveProperty('notification_type');
  });

  it('says that the status line payload is not captured and names its source', () => {
    const { statusline } = payloadsFile.parse(fixture);
    expect(statusline.captured).toBe(false);
    expect(statusline.source).toContain('devflow HUD');
    expect(statusline.source).toContain('status line docs');
  });
});
