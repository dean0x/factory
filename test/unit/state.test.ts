import { describe, expect, it } from 'vitest';
import { describeIssues } from '../../src/core/zod.js';
import {
  initialBoardText,
  initialDecisionLogText,
  initialWaitingText,
  jsonText,
} from '../../src/state/files.js';
import { layoutOf, stagingDirOf } from '../../src/state/layout.js';
import { inspectState, loadState, parseJsonText } from '../../src/state/load.js';
import { nodeStateSchema } from '../../src/state/schema.js';
import { createFakeDeps } from '../helpers/fake-deps.js';
import { FAKE_GITHUB_TOKEN } from '../helpers/fake-secret.js';

const valid = { schema_version: 1, created_with: '0.1.0', blocks: { coordinator: 1, safety: 1, protocol: 1 } };

const issues = (value: unknown): string | null => {
  const parsed = nodeStateSchema.safeParse(value);
  return parsed.success ? null : describeIssues(parsed.error);
};

describe('state schema', () => {
  it('accepts a valid node.json', () => {
    expect(issues(valid)).toBeNull();
  });

  it('is strict', () => {
    expect(issues({ ...valid, owner: 'x' })).toContain('owner: unknown key');
  });

  it('rejects a bad version, a missing key and a bad block entry', () => {
    expect(issues({ ...valid, schema_version: 2 })).toContain('schema_version:');
    expect(issues({ schema_version: 1, blocks: {} })).toContain('created_with:');
    expect(issues({ ...valid, blocks: { 'Bad Name': 1 } })).toContain('blocks.Bad Name');
    expect(issues({ ...valid, blocks: { coordinator: 0 } })).toContain('blocks.coordinator:');
    expect(issues({ ...valid, blocks: { coordinator: 1.5 } })).toContain('blocks.coordinator:');
  });
});

describe('inspectState and loadState', () => {
  const HOME = '/node';
  const withState = (text: string | null) => {
    const deps = createFakeDeps();
    deps.seedDir(`${HOME}/.factory`);
    if (text !== null) deps.seed(`${HOME}/.factory/node.json`, text);
    return deps;
  };

  it('loads a valid file', async () => {
    const loaded = await loadState(withState(jsonText(valid)), HOME);
    expect(loaded).toEqual({ ok: true, value: valid });
  });

  it('reports a missing file with its label', async () => {
    expect(await inspectState(withState(null), HOME)).toEqual({ kind: 'missing' });
    expect(await loadState(withState(null), HOME)).toMatchObject({
      ok: false,
      error: { message: '.factory/node.json not found' },
    });
  });

  it('reports text that is not JSON without repeating it', async () => {
    const state = await inspectState(withState('{ secret-value'), HOME);
    expect(state).toEqual({ kind: 'unparsable', message: 'the text is not valid JSON' });
  });

  it('reports a newer schema_version', async () => {
    const state = await inspectState(withState(jsonText({ ...valid, schema_version: 2 })), HOME);
    expect(state).toMatchObject({ kind: 'newer', version: 2 });
  });

  it('reports an invalid document', async () => {
    const state = await inspectState(withState(jsonText({ ...valid, extra: true })), HOME);
    expect(state).toMatchObject({ kind: 'invalid' });
  });

  it('hides a key that looks like a token in the error', async () => {
    const state = await inspectState(withState(jsonText({ ...valid, [FAKE_GITHUB_TOKEN]: true })), HOME);
    expect(state).toMatchObject({ kind: 'invalid', message: '<key>: unknown key' });
    const blocks = await inspectState(
      withState(jsonText({ ...valid, blocks: { ...valid.blocks, [FAKE_GITHUB_TOKEN]: 1 } })),
      HOME,
    );
    expect(blocks.kind).toBe('invalid');
    if (blocks.kind === 'invalid') expect(blocks.message).not.toContain(FAKE_GITHUB_TOKEN);
  });
});

describe('parseJsonText and initial files', () => {
  it('parses JSON', () => {
    expect(parseJsonText('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonText('{').ok).toBe(false);
  });

  it('writes the initial files with the shapes of the plan', () => {
    expect(JSON.parse(initialBoardText())).toEqual({ merge: [], items: [] });
    expect(JSON.parse(initialWaitingText())).toEqual({ intro: '', groups: [], items: [] });
    expect(JSON.parse(initialDecisionLogText())).toEqual({ rows: [] });
    expect(initialBoardText().endsWith('\n')).toBe(true);
  });
});

describe('layout', () => {
  it('builds every path from the home', () => {
    const layout = layoutOf('/h/node');
    expect(layout).toEqual({
      home: '/h/node',
      configFile: '/h/node/factory.yaml',
      claudeMd: '/h/node/CLAUDE.md',
      stateDir: '/h/node/.factory',
      nodeJson: '/h/node/.factory/node.json',
      protocolMd: '/h/node/.factory/protocol.md',
      backupsDir: '/h/node/.factory/backups',
    });
  });

  it('puts the staging folder next to the state folder, named by the pid', () => {
    expect(stagingDirOf('/h/node', 77)).toBe('/h/node/.factory.tmp-77');
  });
});
