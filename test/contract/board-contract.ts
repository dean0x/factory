import { describe, expect, it } from 'vitest';
import type { BoardConnector, DecisionAskInput, FieldValues } from '../../src/board/contract.js';
import { exitCodeOf, type CliError, type CliResult } from '../../src/cli/errors.js';

/**
 * The contract suite of the board connector (design 4.10). A connector passes it when it gives the same results as every other
 * connector for item add, update, move, close and list, track add and list, decision ask, doc link and a read of changes. The suite
 * holds no assertion that is true of one connector only: it reads results through the contract, and never a file or a service.
 * The suite has no decision read in this change.
 */

/** What a connector under test gives to the suite: the connector, and the names that its setup declares. */
export interface ContractSetup {
  readonly connector: BoardConnector;
  /** The states of the setup: the state of a new item, another state, and the closed state. */
  readonly states: { readonly first: string; readonly other: string; readonly closed: string };
  /** Two listed stages that an item can have: the stage of a new item, and a stage that a move can set after it. */
  readonly stages: { readonly first: string; readonly next: string };
  /** Values of the owner fields that a new item takes, and values for a change. */
  readonly fields: { readonly add: FieldValues; readonly update: FieldValues };
  /** The path of a file of the factory that an item can link. */
  readonly doc: string;
}

const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`expected a value, got: ${result.error.message}`);
  return result.value;
};

const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('expected an error');
  return result.error;
};

const exitOf = <T>(result: CliResult<T>): number => exitCodeOf[errorOf(result).kind];

const ITEM_ID = /^B-[0-9]+$/;
const DECISION_ID = /^D-[0-9]+$/;

const decision: DecisionAskInput = {
  title: 'Pick a plan',
  question: 'Which plan do we build?',
  options: [
    { key: 'a', text: 'Plan A', rec: true },
    { key: 'b', text: 'Plan B' },
  ],
};

/** Run the contract against the connector that `setup` makes. Each test gets a new setup, so no test depends on another. */
export const describeBoardContract = (name: string, setup: () => Promise<ContractSetup>): void => {
  describe(`the board connector contract: ${name}`, () => {
    it('M5-1b TP-21 gives the connector a kind', async () => {
      const { connector } = await setup();
      expect(connector.kind).not.toBe('');
    });

    describe('item add and list', () => {
      it('M5-1b TP-21 adds an item with an id, the first state and the first stage, and lists it', async () => {
        const { connector, states, stages, fields } = await setup();
        const item = valueOf(await connector.addItem({ title: 'First item', fields: fields.add }));
        expect(item.id).toMatch(ITEM_ID);
        expect([item.title, item.status, item.stage, item.track]).toEqual(['First item', states.first, stages.first, null]);
        const listed = valueOf(await connector.listItems({ all: false }));
        expect(listed.map((entry) => entry.id)).toEqual([item.id]);
      });

      it('M5-1b TP-21 gives each new item an id of its own', async () => {
        const { connector, fields } = await setup();
        const first = valueOf(await connector.addItem({ title: 'One', fields: fields.add }));
        const second = valueOf(await connector.addItem({ title: 'Two', fields: fields.add }));
        expect(second.id).not.toBe(first.id);
        const listed = valueOf(await connector.listItems({ all: false }));
        expect(listed.map((entry) => entry.title)).toEqual(['One', 'Two']);
      });

      it('M5-1b TP-21 adds an item to a listed track, and refuses an unknown track with exit 2', async () => {
        const { connector, fields } = await setup();
        valueOf(await connector.addTrack({ id: 'core', name: 'Core', roadmap: true }));
        const item = valueOf(await connector.addItem({ title: 'In a track', track: 'core', fields: fields.add }));
        expect(item.track).toBe('core');
        const refused = await connector.addItem({ title: 'Nowhere', track: 'missing', fields: fields.add });
        expect(exitOf(refused)).toBe(2);
        expect(valueOf(await connector.listItems({ all: true }))).toHaveLength(1);
      });

      it('M5-1b TP-21 lists the items of one track, and refuses an unknown track with exit 2', async () => {
        const { connector, fields } = await setup();
        valueOf(await connector.addTrack({ id: 'core', name: 'Core', roadmap: true }));
        valueOf(await connector.addItem({ title: 'Loose', fields: fields.add }));
        const inTrack = valueOf(await connector.addItem({ title: 'Tracked', track: 'core', fields: fields.add }));
        const listed = valueOf(await connector.listItems({ all: false, track: 'core' }));
        expect(listed.map((entry) => entry.id)).toEqual([inTrack.id]);
        expect(exitOf(await connector.listItems({ all: false, track: 'missing' }))).toBe(2);
      });
    });

    describe('item update', () => {
      it('M5-1b TP-21 changes the title and keeps the id, the state and the stage', async () => {
        const { connector, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'Old title', fields: fields.add }));
        const changed = valueOf(await connector.updateItem(added.id, { title: 'New title', text: 'More words', fields: fields.update }));
        expect([changed.id, changed.title, changed.status, changed.stage]).toEqual([added.id, 'New title', added.status, added.stage]);
        const listed = valueOf(await connector.listItems({ all: false }));
        expect(listed.map((entry) => entry.title)).toEqual(['New title']);
      });

      it('M5-1b TP-21 refuses an item that is not on the board with exit 2', async () => {
        const { connector } = await setup();
        expect(exitOf(await connector.updateItem('B-999', { title: 'Nothing' }))).toBe(2);
      });
    });

    describe('item move', () => {
      it('M5-1b TP-21 moves an item to another state, and keeps its stage', async () => {
        const { connector, states, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'Move me', fields: fields.add }));
        const moved = valueOf(await connector.moveItem(added.id, { state: states.other }));
        expect(moved).toEqual({ id: added.id, from: states.first, to: states.other, changed: true });
        const [listed] = valueOf(await connector.listItems({ all: false }));
        expect([listed?.status, listed?.stage]).toEqual([states.other, added.stage]);
      });

      it('M5-1b TP-21 reports no change when the item is in the state already', async () => {
        const { connector, states, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'Stay', fields: fields.add }));
        const moved = valueOf(await connector.moveItem(added.id, { state: states.first }));
        expect(moved).toEqual({ id: added.id, from: states.first, to: states.first, changed: false });
      });

      it('M5-1b TP-21 moves an item to another stage, and keeps its state', async () => {
        const { connector, states, stages, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'Stage me', fields: fields.add }));
        const moved = valueOf(await connector.moveItem(added.id, { stage: stages.next }));
        expect(moved).toEqual({ id: added.id, from: stages.first, to: stages.next, changed: true });
        const [listed] = valueOf(await connector.listItems({ all: false }));
        expect([listed?.status, listed?.stage]).toEqual([states.first, stages.next]);
      });

      it('M5-1b TP-21 refuses an unknown state, an unknown stage and an item that is not there with exit 2', async () => {
        const { connector, states, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'Refuse', fields: fields.add }));
        expect(exitOf(await connector.moveItem(added.id, { state: 'no-such-state' }))).toBe(2);
        expect(exitOf(await connector.moveItem(added.id, { stage: 'no-such-stage' }))).toBe(2);
        expect(exitOf(await connector.moveItem('B-999', { state: states.other }))).toBe(2);
      });
    });

    describe('item close', () => {
      it('M5-1b TP-21 closes an item with the closed state, and keeps its id and its stage', async () => {
        const { connector, states, stages, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'Close me', fields: fields.add }));
        valueOf(await connector.moveItem(added.id, { stage: stages.next }));
        const closed = valueOf(await connector.closeItem(added.id));
        expect([closed.id, closed.status, closed.stage]).toEqual([added.id, states.closed, stages.next]);
      });

      it('M5-1b TP-21 hides a closed item from the list, and shows it when the list asks for all', async () => {
        const { connector, fields } = await setup();
        const open = valueOf(await connector.addItem({ title: 'Open', fields: fields.add }));
        const done = valueOf(await connector.addItem({ title: 'Done', fields: fields.add }));
        valueOf(await connector.closeItem(done.id));
        const hidden = valueOf(await connector.listItems({ all: false }));
        expect(hidden.map((entry) => entry.id)).toEqual([open.id]);
        const shown = valueOf(await connector.listItems({ all: true }));
        expect(shown.map((entry) => entry.id)).toEqual([open.id, done.id]);
      });

      it('M5-1b TP-21 closes an item that is closed already without an error', async () => {
        const { connector, states, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'Twice', fields: fields.add }));
        valueOf(await connector.closeItem(added.id));
        expect(valueOf(await connector.closeItem(added.id)).status).toBe(states.closed);
      });

      it('M5-1b TP-21 refuses an item that is not there with exit 2', async () => {
        const { connector } = await setup();
        expect(exitOf(await connector.closeItem('B-999'))).toBe(2);
      });
    });

    describe('track add and list', () => {
      it('M5-1b TP-21 adds tracks and lists them in the order of the adds', async () => {
        const { connector } = await setup();
        expect(valueOf(await connector.listTracks())).toEqual([]);
        const added = valueOf(await connector.addTrack({ id: 'core', name: 'Core', roadmap: true }));
        expect(added).toEqual({ id: 'core', name: 'Core', roadmap: true });
        valueOf(await connector.addTrack({ id: 'docs', name: 'Documents', roadmap: false }));
        const listed = valueOf(await connector.listTracks());
        expect(listed.map((track) => [track.id, track.roadmap])).toEqual([
          ['core', true],
          ['docs', false],
        ]);
      });

      it('M5-1b TP-21 refuses a track id that exists, and an id that is not a track id, with exit 2', async () => {
        const { connector } = await setup();
        valueOf(await connector.addTrack({ id: 'core', name: 'Core', roadmap: true }));
        expect(exitOf(await connector.addTrack({ id: 'core', name: 'Again', roadmap: false }))).toBe(2);
        expect(exitOf(await connector.addTrack({ id: 'Upper', name: 'Bad id', roadmap: false }))).toBe(2);
        expect(valueOf(await connector.listTracks()).map((track) => track.id)).toEqual(['core']);
      });
    });

    describe('decision ask', () => {
      it('M5-1b TP-21 asks a decision and gives its id', async () => {
        const { connector } = await setup();
        expect(valueOf(await connector.askDecision(decision))).toMatch(DECISION_ID);
      });

      it('M5-1b TP-21 gives each decision an id of its own', async () => {
        const { connector } = await setup();
        const first = valueOf(await connector.askDecision(decision));
        const second = valueOf(await connector.askDecision(decision));
        expect(second).not.toBe(first);
      });

      it('M5-1b TP-21 refuses a decision with no option with exit 2', async () => {
        const { connector } = await setup();
        expect(exitOf(await connector.askDecision({ ...decision, options: [] }))).toBe(2);
      });
    });

    describe('doc link', () => {
      it('M5-1b TP-21 links a file of the factory to an item', async () => {
        const { connector, doc, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'With a doc', fields: fields.add }));
        const linked = valueOf(await connector.linkDoc({ id: added.id, path: doc }));
        expect(linked.id).toBe(added.id);
      });

      it('M5-1b TP-21 refuses an item that is not there, and a path that leaves the factory folder, with exit 2', async () => {
        const { connector, doc, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'Refuse a doc', fields: fields.add }));
        expect(exitOf(await connector.linkDoc({ id: 'B-999', path: doc }))).toBe(2);
        expect(exitOf(await connector.linkDoc({ id: added.id, path: '../outside.md' }))).toBe(2);
      });
    });

    describe('changes read', () => {
      it('M5-1b TP-21 reads the changes since a cursor as events with an author, and a cursor for the next read', async () => {
        const { connector } = await setup();
        const read = valueOf(await connector.readChanges(null));
        expect(Array.isArray(read.events)).toBe(true);
        for (const event of read.events) {
          expect([typeof event.at, typeof event.author, typeof event.text]).toEqual(['string', 'string', 'string']);
        }
        expect(read.cursor === null || typeof read.cursor === 'string').toBe(true);
      });
    });
  });
};
