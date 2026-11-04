import { describe, expect, it } from 'vitest';
import {
  killPaneArgs,
  paneListArgs,
  parsePaneList,
  runShellBackgroundArgs,
  setPaneOptionArgs,
  splitWorkerPaneArgs,
  startSteps,
  swapPaneArgs,
  type PaneRow,
  type TmuxArgs,
} from '../../src/launch/tmux.js';
import type { Result } from '../../src/core/result.js';
import { tmuxHandler, type TmuxFixture } from '../helpers/tmux-fake.js';

const must = (result: Result<TmuxArgs, string>): TmuxArgs => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const fakeTmux = (fixture?: TmuxFixture) => {
  const { handler, log } = tmuxHandler(fixture);
  const run = (args: readonly string[]) => {
    const result = handler({ command: 'tmux', args, cwd: undefined });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  const rowsOf = (id: string): readonly PaneRow[] => {
    const listed = parsePaneList(run(paneListArgs(id)).stdout);
    if (!listed.ok) throw new Error(listed.error);
    return listed.value;
  };
  const startSession = (id: string): void => {
    for (const step of startSteps({ id, home: '/w/node', coordinatorDir: '/w/node/coordinator', launch: ['claude'] })) {
      expect(run(step).exitCode).toBe(0);
    }
  };
  return { run, log, rowsOf, startSession };
};

const where = (log: ReturnType<typeof fakeTmux>['log']) => log.panes().map((pane) => `${pane.id}@${pane.window}`);

describe('the tmux fake: windows and panes', () => {
  it('gives a started session the view window with two panes and the workers window with one pane', () => {
    const { log, startSession } = fakeTmux();
    startSession('demo');
    expect(where(log)).toEqual(['%0@view', '%1@view', '%2@workers']);
    expect(log.panes().map((pane) => pane.options)).toEqual([{ '@node': 'demo' }, { '@slot': 'board' }, {}]);
    expect(log.panes()[0]?.cwd).toBe('/w/node/coordinator');
    expect(log.panes()[0]?.command).toEqual(['claude']);
    expect(log.sessions().get('demo')).toBe('/w/node');
  });

  it('gives a session of the fixture the same windows', () => {
    const { log, rowsOf } = fakeTmux({ sessions: { demo: '/w/node' } });
    expect(where(log)).toEqual(['%0@view', '%1@view', '%2@workers']);
    expect(rowsOf('demo').map((row) => row.worker)).toEqual([null, null, null]);
  });

  it('lists the panes with the id, the pid, the dead flag and the worker option, and the list parses', () => {
    const { rowsOf } = fakeTmux({
      sessions: { demo: '/w/node' },
      panes: [{ id: '%9', session: 'demo', options: { '@worker': 'alpha' }, pid: 5001, dead: true }],
    });
    expect(rowsOf('demo').at(-1)).toEqual({ paneId: '%9', pid: 5001, dead: true, worker: 'alpha' });
    expect(rowsOf('demo')).toHaveLength(4);
  });

  it('gives a pane of the fixture the next free id after the highest id of the fixture', () => {
    const { log, run } = fakeTmux({ sessions: { demo: null }, panes: [{ id: '%20', session: 'demo' }] });
    expect(where(log)).toEqual(['%21@view', '%22@view', '%23@workers', '%20@workers']);
    expect(run(must(splitWorkerPaneArgs({ id: 'demo', cwd: '/w', command: ['claude'] }))).stdout).toBe('%24\n');
  });

  it('makes a worker pane in the workers window, prints its id, and keeps the folder, the command and the option', () => {
    const { log, run, rowsOf, startSession } = fakeTmux();
    startSession('demo');
    const made = run(must(splitWorkerPaneArgs({ id: 'demo', cwd: '/w/node/work-copies/a', command: ['env', 'claude'] })));
    expect(made.stdout).toBe('%3\n');
    expect(run(must(setPaneOptionArgs('%3', '@worker', 'alpha'))).exitCode).toBe(0);
    expect(rowsOf('demo').at(-1)).toEqual({ paneId: '%3', pid: 4003, dead: false, worker: 'alpha' });
    expect(log.panes().at(-1)).toMatchObject({
      window: 'workers',
      cwd: '/w/node/work-copies/a',
      command: ['env', 'claude'],
      options: { '@worker': 'alpha' },
    });
  });

  it('makes a pane that ends at once as a dead pane, when the fixture says so', () => {
    const { run, rowsOf } = fakeTmux({ sessions: { demo: null }, newPanesEndAtOnce: true });
    run(must(splitWorkerPaneArgs({ id: 'demo', cwd: '/w', command: ['claude'] })));
    expect(rowsOf('demo').map((row) => row.dead)).toEqual([false, false, false, true]);
  });

  it('keeps the dead flag of the coordinator for a session whose coordinator has ended', () => {
    const { rowsOf } = fakeTmux({ sessions: { demo: null }, endedCoordinators: ['demo'] });
    expect(rowsOf('demo').map((row) => row.dead)).toEqual([true, false, false]);
  });

  it('ends a pane by its id, and ends the window and then the session with its last pane', () => {
    const { log, run } = fakeTmux({ sessions: { demo: '/w/node' } });
    expect(run(must(killPaneArgs('%2'))).exitCode).toBe(0);
    expect(where(log)).toEqual(['%0@view', '%1@view']);
    expect(run(['new-window', '-d', '-t', '=demo:', '-n', 'workers']).exitCode).toBe(0);
    expect(where(log)).toEqual(['%0@view', '%1@view', '%3@workers']);
    run(must(killPaneArgs('%0')));
    run(must(killPaneArgs('%1')));
    run(must(killPaneArgs('%3')));
    expect(log.panes()).toEqual([]);
    expect(log.sessions().has('demo')).toBe(false);
  });

  it('swaps two panes: each pane keeps its id and options, and takes the place of the other', () => {
    const { log, run, rowsOf } = fakeTmux({ sessions: { demo: null } });
    run(must(splitWorkerPaneArgs({ id: 'demo', cwd: '/w', command: ['claude'] })));
    run(must(setPaneOptionArgs('%3', '@worker', 'alpha')));
    run(must(setPaneOptionArgs('%1', '@slot', 'board')));
    expect(run(must(swapPaneArgs('%3', '%1'))).exitCode).toBe(0);
    expect(log.panes().find((pane) => pane.id === '%3')).toMatchObject({ window: 'view', options: { '@worker': 'alpha' } });
    expect(log.panes().find((pane) => pane.id === '%1')).toMatchObject({ window: 'workers', options: { '@slot': 'board' } });
    expect(rowsOf('demo').map((row) => row.paneId)).toEqual(['%0', '%3', '%2', '%1']);
  });

  it('records a background shell call and does nothing else', () => {
    const { log, run } = fakeTmux({ sessions: { demo: null } });
    expect(run(must(runShellBackgroundArgs('sleep 900'))).exitCode).toBe(0);
    expect(log.commands().at(-1)).toBe('run-shell -b sleep 900');
    expect(log.panes()).toHaveLength(3);
  });
});

describe('the tmux fake: calls that fail', () => {
  it('fails a pane call for a pane that does not exist, and names the pane', () => {
    const { run } = fakeTmux({ sessions: { demo: null } });
    for (const args of [
      must(killPaneArgs('%99')),
      must(setPaneOptionArgs('%99', '@worker', 'a')),
      must(swapPaneArgs('%99', '%1')),
      must(swapPaneArgs('%1', '%99')),
    ]) {
      const result = run(args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('%99');
    }
  });

  it('fails a list or a split for a session or a window that does not exist', () => {
    const { run } = fakeTmux({ sessions: { demo: null } });
    expect(run(paneListArgs('other')).exitCode).toBe(1);
    expect(run(must(splitWorkerPaneArgs({ id: 'other', cwd: '/w', command: ['claude'] }))).exitCode).toBe(1);
    expect(run(['split-window', '-d', '-t', '=demo:nowhere']).exitCode).toBe(1);
  });

  it('fails a second window with the same name', () => {
    const { run } = fakeTmux({ sessions: { demo: null } });
    expect(run(['new-window', '-d', '-t', '=demo:', '-n', 'workers']).exitCode).toBe(1);
    expect(run(['new-window', '-d', '-t', '=demo:', '-n', 'extra']).exitCode).toBe(0);
  });

  it('fails the command that the fixture names', () => {
    const { run } = fakeTmux({ sessions: { demo: null }, failing: 'list-panes' });
    expect(run(paneListArgs('demo')).exitCode).toBe(1);
  });

  it('refuses a fixture pane for a session that is not in the fixture, and the same id twice', () => {
    expect(() => tmuxHandler({ panes: [{ session: 'demo' }] })).toThrow('not in the fixture');
    expect(() => tmuxHandler({ sessions: { demo: null }, panes: [{ id: '%4', session: 'demo' }, { id: '%4', session: 'demo' }] })).toThrow(
      'twice',
    );
    expect(() => tmuxHandler({ sessions: { demo: null }, panes: [{ id: '4', session: 'demo' }] })).toThrow('not a pane id');
  });

  it('drops the panes of a session that is killed', () => {
    const { log, run } = fakeTmux({ sessions: { demo: null, other: null } });
    run(['kill-session', '-t', '=demo']);
    expect(log.panes().map((pane) => pane.session)).toEqual(['other', 'other', 'other']);
  });
});
