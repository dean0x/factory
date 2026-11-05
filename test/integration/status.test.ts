import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasTmux, LIFECYCLE_CASE_MS, useLab } from './lifecycle-lab.js';

if (!hasTmux) console.warn('The tmux cases of status.test.ts are skipped: tmux 3.0 or newer is not installed.');

const lab = useLab();

interface StatusJson {
  readonly schema: string;
  readonly home: string;
  readonly running: boolean;
  readonly workers: readonly {
    readonly id: string;
    readonly pane: string | null;
    readonly state: string;
    readonly workItem: { readonly state: string };
    readonly idle: boolean;
  }[];
}

describe('factory status (built binary, separate tmux server, AC-21, TP-48, TP-50)', () => {
  it.skipIf(!hasTmux)(
    'lists each worker with its state, an unknown work item and no idle worker',
    async () => {
      await lab.node();
      const result = await lab.factory('status');
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/ID\s+PROJECT\s+STATE\s+WORK ITEM\s+IDLE/);
      expect(result.stdout).toMatch(/alpha\s+web\s+at prompt\s+unknown\s+no\b/);
      expect(result.stdout).toMatch(/beta\s+web\s+at prompt\s+unknown\s+no\b/);
    },
    LIFECYCLE_CASE_MS,
  );

  it.skipIf(!hasTmux)(
    'shows each worker as stopped when no tmux server runs (TP-50)',
    async () => {
      await lab.node();
      expect((await lab.tmux(['kill-server'])).code).toBe(0);
      const result = await lab.factory('status', ['--json']);
      expect(result.code, result.stderr).toBe(0);
      const status = JSON.parse(result.stdout) as StatusJson;
      expect(status.running).toBe(false);
      expect(status.workers.map((worker) => [worker.id, worker.state, worker.pane, worker.idle])).toEqual([
        ['alpha', 'stopped', null, false],
        ['beta', 'stopped', null, false],
      ]);
    },
    LIFECYCLE_CASE_MS,
  );
});

describe('factory status: the folder of a git work tree (built binary, AC-22, TP-51, TP-52)', () => {
  it('finds the factory from a separate git work tree of a listed project, outside the factory folder, and exits 0 (TP-51)', async () => {
    await lab.init();
    const tree = join(lab.box.root, 'web-fix');
    const added = await lab.box.git(join(lab.box.node, 'web'), ['worktree', 'add', '-q', '-b', 'fix', tree]);
    expect(added.code, added.stderr).toBe(0);

    const result = await lab.box.run(['status', '--json'], { cwd: tree });
    expect(result.code, result.stderr).toBe(0);
    const status = JSON.parse(result.stdout) as StatusJson;
    expect(status.schema).toBe('factory.status/v1');
    expect(status.home).toBe(await realpath(lab.box.node));
  });

  it('exits 2 and prints the hint from a git work tree of no listed project (TP-52)', async () => {
    await lab.init();
    const other = await lab.box.makeProject('other');

    const result = await lab.box.run(['status'], { cwd: other });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no factory.yaml found');
    expect(result.stderr).toContain('factory init');
    expect(result.stdout).toBe('');
  });
});
