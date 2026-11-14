import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { boardNode, boardText } from '../helpers/board-node.js';
import type { FakeDeps } from '../helpers/fake-deps.js';
import { HOME } from '../helpers/guard-fixture.js';
import { captureSink } from '../helpers/sink.js';
import { seedWorkerSession, withWorkerPanes } from '../helpers/worker-session.js';

/**
 * The exit check of the JSON data for a view that lives outside the core. The test runs the commands through the command line, and
 * it reads the JSON documents and nothing else. From the documents it fills one row for a worker and one count of waiting requests,
 * and it makes its own state word, as a view must, because factory gives facts and no final state word.
 */

const MINUTE = 60_000;
const TITLE = 'Build the login page';
const STALLED_AFTER_MINUTES = 15;

interface WorkerFacts {
  readonly id: string;
  readonly contextPct: number | null;
  readonly itemTitle: string | null;
  readonly stage: string | null;
  readonly stageAt: string | null;
  readonly paneLive: boolean;
  readonly sessionState: string;
  readonly stalled: boolean;
}

interface RequestFacts {
  readonly openedAt: string | null;
  readonly group: string;
}

/** Runs one command with `--json` and gives the parsed document. The command must exit with code 0 and print no error. */
const documentOf = async (deps: FakeDeps, argv: readonly string[]): Promise<unknown> => {
  const sink = captureSink();
  const code = await runCli([...argv, '--json', '--home', HOME], deps, sink);
  expect({ argv, code, error: sink.errors.join('') }).toEqual({ argv, code: 0, error: '' });
  return JSON.parse(sink.out.join(''));
};

const workersOf = async (deps: FakeDeps): Promise<readonly WorkerFacts[]> =>
  ((await documentOf(deps, ['worker', 'list'])) as { workers: WorkerFacts[] }).workers;

const requestsOf = async (deps: FakeDeps): Promise<readonly RequestFacts[]> =>
  ((await documentOf(deps, ['request', 'list'])) as { requests: RequestFacts[] }).requests;

/** The state word of the view. The view makes it from three facts of the row, and the words are its own. */
const stateWordOf = (worker: WorkerFacts): string => {
  if (!worker.paneLive) return 'stopped';
  if (worker.stalled) return 'stalled';
  switch (worker.sessionState) {
    case 'busy':
      return 'working';
    case 'waits':
      return 'needs an answer';
    case 'at prompt':
      return 'ready';
    default:
      return 'unknown';
  }
};

const rowOf = (worker: WorkerFacts, now: Date) => ({
  worker: worker.id,
  title: worker.itemTitle,
  stage: worker.stage,
  state: stateWordOf(worker),
  minutesInStage: worker.stageAt === null ? null : Math.floor((now.getTime() - Date.parse(worker.stageAt)) / MINUTE),
  context: worker.contextPct,
});

/** The count of the waiting requests and the oldest open time among them. A request with no open time is counted and not dated. */
const waitingOf = (requests: readonly RequestFacts[]) => {
  const times = requests.flatMap((request) => (request.openedAt === null ? [] : [request.openedAt])).sort();
  return { count: requests.length, oldest: times[0] ?? null };
};

const OLD_REQUEST = { id: 'D-1', title: 'Old request', question: 'Which?', options: [{ key: 'a', text: 'Yes' }] };

/**
 * A factory with one worker on one item and one open request. The commands set the stage time and the open time. The session of the
 * worker is busy, with 35 percent of context, 3 minutes before the end of the setup.
 */
const factoryWith = async (older: readonly Record<string, unknown>[] = []) => {
  const waiting = `${JSON.stringify({ intro: '', groups: [], items: older }, null, 2)}\n`;
  const repo = await boardNode({ board: boardText([], []), waiting });
  const deps = withWorkerPanes(repo.deps, HOME, ['w1']);
  await documentOf(deps, ['item', 'add', '--title', TITLE, '--field', 'priority=P1', '--field', 'lane=w1']);
  deps.advance(5 * MINUTE);
  await documentOf(deps, ['item', 'move', 'B-1', '--stage', 'building']);
  const stageAt = deps.now().toISOString();
  deps.advance(MINUTE);
  await documentOf(deps, ['request', 'add', '--title', 'Which tool?', '--question', 'Which tool do we use?', '--option', 'a=Tool A', '--option', 'b=Tool B']);
  const openedAt = deps.now().toISOString();
  deps.advance(MINUTE);
  await seedWorkerSession(deps, HOME, { id: 'w1', event: 'UserPromptSubmit', percent: 35 });
  deps.advance(3 * MINUTE);
  return { deps, stageAt, openedAt };
};

describe('the facts of a worker row and of the waiting requests, from the JSON output alone', () => {
  it('fills the row of a busy worker and the waiting count with the oldest date', async () => {
    const { deps, stageAt, openedAt } = await factoryWith();
    const [worker] = await workersOf(deps);
    expect(worker?.stageAt).toBe(stageAt);
    expect(rowOf(worker as WorkerFacts, deps.now())).toEqual({
      worker: 'w1',
      title: TITLE,
      stage: 'building',
      state: 'working',
      minutesInStage: 5,
      context: 35,
    });
    expect(waitingOf(await requestsOf(deps))).toEqual({ count: 1, oldest: openedAt });
  });

  it('makes the state word stalled when the busy session has no new activity for longer than the limit', async () => {
    const { deps } = await factoryWith();
    deps.advance((STALLED_AFTER_MINUTES + 1) * MINUTE);
    const [worker] = await workersOf(deps);
    expect(rowOf(worker as WorkerFacts, deps.now())).toMatchObject({ state: 'stalled', minutesInStage: 21, context: 35 });
  });

  it('counts a request with no open time and takes the oldest date from the requests that have one', async () => {
    const { deps, openedAt } = await factoryWith([OLD_REQUEST]);
    const requests = await requestsOf(deps);
    expect(requests.map((request) => request.openedAt)).toEqual([null, openedAt]);
    expect(waitingOf(requests)).toEqual({ count: 2, oldest: openedAt });
  });
});
