import { describe, expect, it } from 'vitest';
import { displayLine } from '../../src/cli/output.js';
import { BOARD_HOME, boardCommand, boardFixture } from '../helpers/board-fixture.js';

const docOf = (value: unknown): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON document');
  return value as Readonly<Record<string, unknown>>;
};

describe('board section contracts', () => {
  it('uses exactly the fact rows of each section command', async () => {
    const deps = await boardFixture();
    const board = await boardCommand(deps, ['board', '--json']);
    const requests = await boardCommand(deps, ['request', 'list', '--json']);
    const queue = await boardCommand(deps, ['queue', 'show', '--json']);
    const workers = await boardCommand(deps, ['worker', 'list', '--json']);
    const machine = await boardCommand(deps, ['machine', '--json']);
    expect([board.code, requests.code, queue.code, workers.code, machine.code]).toEqual([0, 0, 0, 0, 0]);
    const { schema: _schema, home: _home, ...machineFacts } = docOf(machine.json);
    expect(board.json).toMatchObject({
      schema: 'factory.board/v1', home: BOARD_HOME,
      requests: docOf(requests.json)['requests'],
      queue: docOf(queue.json)['rows'],
      workers: docOf(workers.json)['workers'],
      machine: machineFacts,
      faults: [],
    });
  });

  it.each([40, 100, 120])('uses exactly the section command text at width %s', async (width) => {
    const deps = await boardFixture();
    const board = await boardCommand(deps, ['board', '--width', String(width)]);
    const requests = await boardCommand(deps, ['request', 'list']);
    const workers = await boardCommand(deps, ['worker', 'list']);
    const items = await boardCommand(deps, ['item', 'list']);
    const queue = await boardCommand(deps, ['queue', 'show']);
    const machine = await boardCommand(deps, ['machine']);
    expect([board.code, requests.code, workers.code, items.code, queue.code, machine.code]).toEqual([0, 0, 0, 0, 0, 0]);
    const sections = [
      ['Requests', requests.stdout], ['Workers', workers.stdout], ['Board', items.stdout], ['Queue', queue.stdout], ['Machine', machine.stdout],
    ] as const;
    const expected = sections.map(([heading, stdout]) => `${heading}\n${stdout.trimEnd().split('\n').map((line) => displayLine(line, width)).join('\n')}`).join('\n\n');
    expect(board.stdout).toBe(`${expected}\n`);
  });
});
