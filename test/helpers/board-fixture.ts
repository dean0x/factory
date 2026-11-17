import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../src/cli/run.js';
import { files } from '../../src/names.js';
import { layoutOf } from '../../src/state/layout.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { boardText, itemRecord } from './board-node.js';
import { createFakeDeps, exited, missingProgram, registerRoot, type FakeDeps } from './fake-deps.js';
import { sampleConfigWithBoard, seedConfig } from './sample-config.js';
import { captureSink } from './sink.js';

export const BOARD_HOME = '/w/demo';
export const BOARD_TIME = '2030-01-02T03:04:05.678Z';

/** One home for the board command and its section contracts. No real process runs. */
export const boardFixture = async (): Promise<FakeDeps> => {
  const fixture = (name: string): string => readFileSync(join(__dirname, '..', 'fixtures', 'machine', 'macos', name), 'utf8');
  const answers: Readonly<Record<string, string>> = {
    memory_pressure: fixture('memory_pressure.txt'),
    df: fixture('df.txt'),
    pmset: fixture('pmset-ac.txt'),
  };
  const deps = createFakeDeps({
    cwd: BOARD_HOME,
    os: 'darwin',
    env: { XDG_STATE_HOME: '/state' },
    run: (call) => {
      if (call.command === 'tmux') return exited(1);
      if (call.command === 'sysctl') return exited(0, fixture(call.args.includes('vm.loadavg') ? 'sysctl-loadavg.txt' : 'sysctl-ncpu.txt'));
      const answer = answers[call.command];
      return answer === undefined ? missingProgram(call.command) : exited(0, answer);
    },
  });
  const config = sampleConfigWithBoard();
  seedConfig(deps, BOARD_HOME, config);
  registerRoot(deps, BOARD_HOME, config.core.node.id);
  const layout = layoutOf(BOARD_HOME);
  deps.seed(join(layout.stateDir, files.board), boardText([
    itemRecord('B-1', { title: 'Build the board', status: 'doing', stage: 'build', stage_at: BOARD_TIME, epic: 'Views', lane: 'alpha', track: 'views' }),
    itemRecord('B-2', { title: 'Old item', status: 'done' }),
    itemRecord('B-3', { title: 'Next item', stage_at: 'not a time', epic: false }),
  ], [{ id: 'views', name: 'Views', roadmap: true }], [
    { name: 'Ship the board', items: ['B-1'], note: 'Check the view', release_group: 'Next', release: true },
  ]));
  deps.seed(join(layout.stateDir, files.waiting), JSON.stringify({ intro: '', groups: [], items: [{
    id: 'D-1', title: 'Choose the view', question: 'Which view?', options: [{ key: 'a', text: 'Board' }], opened_at: BOARD_TIME, group: 'later',
  }] }));
  const worker = await writeWorkerRecord(deps, BOARD_HOME, {
    id: 'alpha', project: 'web', workCopy: `${BOARD_HOME}/work-copies/web/alpha`, branch: 'worker/alpha',
  });
  if (!worker.ok) throw new Error(worker.error.message);
  return deps;
};

export const boardCommand = async (deps: FakeDeps, words: readonly string[]) => {
  const sink = captureSink();
  const code = await runCli([...words, '--home', BOARD_HOME], deps, sink);
  const stdout = sink.out.join('');
  const json: unknown = words.includes('--json') && stdout !== '' ? JSON.parse(stdout) : null;
  return { code, stdout, json, stderr: sink.errors.join('') };
};
