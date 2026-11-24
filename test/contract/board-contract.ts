import { describe, expect, it } from 'vitest';
import type { BoardConnector, DecisionAskInput, FieldValues, ItemPlace } from '../../src/board/contract.js';
import { exitCodeOf, type CliError, type CliResult } from '../../src/cli/errors.js';
import { commandLines, commands, commandText, flagText, flags } from '../../src/names.js';

/**
 * The board contract covers item add, update, move, rank, note, close and list. It also covers track add and list, decision ask,
 * doc link and a read of changes. The suite reads results through the contract. It does not read a file or a service.
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

/** The ids of five items, in the order of the adds. */
type Five = readonly [string, string, string, string, string];

/** The input of a rank: the id of the item, and its new place. */
type Rank = readonly [string, ItemPlace];

/** A rank that the connector refuses, an id that the message names, and the command that the remedy names. */
interface Refusal {
  readonly rank: Rank;
  readonly named: string;
  readonly remedy: string;
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
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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
    it('gives the connector a kind', async () => {
      const { connector } = await setup();
      expect(connector.kind).not.toBe('');
    });

    describe('item add and list', () => {
      it('adds an item with an id, the first state and the first stage, and lists it', async () => {
        const { connector, states, stages, fields } = await setup();
        const item = valueOf(await connector.addItem({ title: 'First item', fields: fields.add }));
        expect(item.id).toMatch(ITEM_ID);
        expect([item.title, item.status, item.stage, item.track]).toEqual(['First item', states.first, stages.first, null]);
        const listed = valueOf(await connector.listItems({ all: false }));
        expect(listed.map((entry) => entry.id)).toEqual([item.id]);
      });

      it('gives each new item an id of its own', async () => {
        const { connector, fields } = await setup();
        const first = valueOf(await connector.addItem({ title: 'One', fields: fields.add }));
        const second = valueOf(await connector.addItem({ title: 'Two', fields: fields.add }));
        expect(second.id).not.toBe(first.id);
        const listed = valueOf(await connector.listItems({ all: false }));
        expect(listed.map((entry) => entry.title)).toEqual(['One', 'Two']);
      });

      it('adds an item to a listed track, and refuses an unknown track with exit 2', async () => {
        const { connector, fields } = await setup();
        valueOf(await connector.addTrack({ id: 'core', name: 'Core', roadmap: true }));
        const item = valueOf(await connector.addItem({ title: 'In a track', track: 'core', fields: fields.add }));
        expect(item.track).toBe('core');
        const refused = await connector.addItem({ title: 'Nowhere', track: 'missing', fields: fields.add });
        expect(exitOf(refused)).toBe(2);
        expect(valueOf(await connector.listItems({ all: true }))).toHaveLength(1);
      });

      it('lists the items of one track, and refuses an unknown track with exit 2', async () => {
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
      it('changes the title and keeps the id, the state and the stage', async () => {
        const { connector, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'Old title', fields: fields.add }));
        const changed = valueOf(await connector.updateItem(added.id, { title: 'New title', text: 'More words', fields: fields.update }));
        expect([changed.id, changed.title, changed.status, changed.stage]).toEqual([added.id, 'New title', added.status, added.stage]);
        const listed = valueOf(await connector.listItems({ all: false }));
        expect(listed.map((entry) => entry.title)).toEqual(['New title']);
      });

      it('refuses an item that is not on the board with exit 2', async () => {
        const { connector } = await setup();
        expect(exitOf(await connector.updateItem('B-999', { title: 'Nothing' }))).toBe(2);
      });
    });

    describe('item move', () => {
      it('moves an item to another state, and keeps its stage', async () => {
        const { connector, states, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'Move me', fields: fields.add }));
        const moved = valueOf(await connector.moveItem(added.id, { state: states.other }));
        expect(moved).toEqual({ id: added.id, from: states.first, to: states.other, changed: true });
        const [listed] = valueOf(await connector.listItems({ all: false }));
        expect([listed?.status, listed?.stage]).toEqual([states.other, added.stage]);
      });

      it('reports no change when the item is in the state already', async () => {
        const { connector, states, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'Stay', fields: fields.add }));
        const moved = valueOf(await connector.moveItem(added.id, { state: states.first }));
        expect(moved).toEqual({ id: added.id, from: states.first, to: states.first, changed: false });
      });

      it('moves an item to another stage, and keeps its state', async () => {
        const { connector, states, stages, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'Stage me', fields: fields.add }));
        const moved = valueOf(await connector.moveItem(added.id, { stage: stages.next }));
        expect(moved).toEqual({ id: added.id, from: stages.first, to: stages.next, changed: true });
        const [listed] = valueOf(await connector.listItems({ all: false }));
        expect([listed?.status, listed?.stage]).toEqual([states.first, stages.next]);
      });

      it('refuses an unknown state, an unknown stage and an item that is not there with exit 2', async () => {
        const { connector, states, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'Refuse', fields: fields.add }));
        expect(exitOf(await connector.moveItem(added.id, { state: 'no-such-state' }))).toBe(2);
        expect(exitOf(await connector.moveItem(added.id, { stage: 'no-such-stage' }))).toBe(2);
        expect(exitOf(await connector.moveItem('B-999', { state: states.other }))).toBe(2);
      });
    });

    describe('item rank', () => {
      /**
       * A setup with five items in the order of the adds. The second item has another state and the third item is closed, so a rank
       * from one end of the list to the other passes an item of another state and a closed item.
       */
      const fiveItems = async (): Promise<ContractSetup & { readonly ids: Five }> => {
        const made = await setup();
        const add = async (title: string): Promise<string> => valueOf(await made.connector.addItem({ title, fields: made.fields.add })).id;
        const ids: Five = [await add('One'), await add('Two'), await add('Three'), await add('Four'), await add('Five')];
        valueOf(await made.connector.moveItem(ids[1], { state: made.states.other }));
        valueOf(await made.connector.closeItem(ids[2]));
        return { ...made, ids };
      };

      const orderOf = async (connector: BoardConnector): Promise<readonly string[]> =>
        valueOf(await connector.listItems({ all: true })).map((entry) => entry.id);

      const PLACES: readonly (readonly [string, (ids: Five) => Rank, (ids: Five) => readonly string[]])[] = [
        ['after an item lower in the list', ([one, , , four]) => [one, { after: four }], ([one, two, three, four, five]) => [two, three, four, one, five]],
        ['after an item higher in the list', ([one, , , , five]) => [five, { after: one }], ([one, two, three, four, five]) => [one, five, two, three, four]],
        ['at the start of the list', ([, , , four]) => [four, { edge: flags.first }], ([one, two, three, four, five]) => [four, one, two, three, five]],
        ['at the end of the list', ([one]) => [one, { edge: flags.last }], ([one, two, three, four, five]) => [two, three, four, five, one]],
      ];

      it.each(PLACES)('puts an item %s, past an item of another state and a closed item', async (_name, rank, order) => {
        const { connector, ids } = await fiveItems();
        const [id, place] = rank(ids);
        expect(valueOf(await connector.rankItem(id, place))).toEqual({ id, place, changed: true });
        expect(await orderOf(connector)).toEqual(order(ids));
      });

      it('puts an item after an item of another state, and keeps the state of each item', async () => {
        const { connector, states, ids } = await fiveItems();
        const [one, two, three, four, five] = ids;
        expect(valueOf(await connector.rankItem(four, { after: two })).changed).toBe(true);
        const listed = valueOf(await connector.listItems({ all: true }));
        expect(listed.map((entry) => [entry.id, entry.status])).toEqual([
          [one, states.first],
          [two, states.other],
          [four, states.first],
          [three, states.closed],
          [five, states.first],
        ]);
      });

      const LIST_REMEDY = `${commandText(commands.board)} ${flagText(flags.json)}`;
      const openRemedy = (id: string): string => `${commandText(commandLines.itemMove)} ${id} ${flagText(flags.state)}`;

      /** Each row breaks one property of a valid rank: the fourth item after the first item. */
      const REFUSALS: readonly (readonly [string, (ids: Five) => Refusal])[] = [
        ['a subject that is not on the board', ([one]) => ({ rank: ['B-999', { after: one }], named: 'B-999', remedy: LIST_REMEDY })],
        ['a target that is not on the board', ([, , , four]) => ({ rank: [four, { after: 'B-999' }], named: 'B-999', remedy: LIST_REMEDY })],
        ['a closed subject', ([one, , three]) => ({ rank: [three, { after: one }], named: three, remedy: openRemedy(three) })],
        ['a closed target', ([, , three, four]) => ({ rank: [four, { after: three }], named: three, remedy: openRemedy(three) })],
      ];

      it.each(REFUSALS)('refuses %s with exit 2, a message and a remedy, and keeps the order', async (_name, refusal) => {
        const { connector, ids } = await fiveItems();
        const [one, , , four] = ids;
        const before = await orderOf(connector);
        const { rank, named, remedy } = refusal(ids);
        const error = errorOf(await connector.rankItem(...rank));
        expect(exitCodeOf[error.kind]).toBe(2);
        expect(error.message).toContain(named);
        expect(error.hint).toContain(remedy);
        expect(await orderOf(connector)).toEqual(before);
        expect(valueOf(await connector.rankItem(four, { after: one })).changed).toBe(true);
      });

      const SAME_PLACES: readonly (readonly [string, (ids: Five) => Rank])[] = [
        ['after the item that is before it', ([one, two]) => [two, { after: one }]],
        ['at the start, where it is', ([one]) => [one, { edge: flags.first }]],
        ['at the end, where it is', ([, , , , five]) => [five, { edge: flags.last }]],
      ];

      it.each(SAME_PLACES)('reports no change for a rank %s, and keeps the order', async (_name, rank) => {
        const { connector, ids } = await fiveItems();
        const [id, place] = rank(ids);
        expect(valueOf(await connector.rankItem(id, place))).toEqual({ id, place, changed: false });
        expect(await orderOf(connector)).toEqual(ids);
      });

      it('reports no change for a second run of the same rank', async () => {
        const { connector, ids } = await fiveItems();
        const [one, , , four] = ids;
        expect(valueOf(await connector.rankItem(four, { after: one })).changed).toBe(true);
        const ranked = await orderOf(connector);
        expect(valueOf(await connector.rankItem(four, { after: one }))).toEqual({ id: four, place: { after: one }, changed: false });
        expect(await orderOf(connector)).toEqual(ranked);
      });

      it('keeps the new order through the other item writes, and an add puts the new item at the end', async () => {
        const { connector, states, stages, fields, ids } = await fiveItems();
        const [one, two, three, four, five] = ids;
        valueOf(await connector.rankItem(five, { edge: flags.first }));
        const ranked = [five, one, two, three, four];
        expect(await orderOf(connector)).toEqual(ranked);
        valueOf(await connector.moveItem(one, { state: states.other }));
        valueOf(await connector.moveItem(two, { stage: stages.next }));
        valueOf(await connector.updateItem(five, { title: 'Changed' }));
        valueOf(await connector.noteItem(one, 'Work started'));
        valueOf(await connector.closeItem(four));
        expect(await orderOf(connector)).toEqual(ranked);
        const added = valueOf(await connector.addItem({ title: 'Six', fields: fields.add }));
        expect(await orderOf(connector)).toEqual([...ranked, added.id]);
      });

      it('lists the open items in the new order after a rank', async () => {
        const { connector, ids } = await fiveItems();
        const [one, two, , four, five] = ids;
        valueOf(await connector.rankItem(one, { edge: flags.last }));
        const open = valueOf(await connector.listItems({ all: false }));
        expect(open.map((entry) => entry.id)).toEqual([two, four, five, one]);
      });
    });

    describe('item note', () => {
      it('refuses an absent item and preserves the other items', async () => {
        const { connector, fields } = await setup();
        const item = valueOf(await connector.addItem({ title: 'Keep this item', fields: fields.add }));
        const absent = 'B-999';
        const error = errorOf(await connector.noteItem(absent, 'Work started'));
        expect(exitCodeOf[error.kind]).toBe(2);
        expect(error.message).toContain(absent);
        expect(valueOf(await connector.listItems({ all: true }))).toEqual([item]);
      });

      it.each(['note', 'close'])('refuses an empty %s text and preserves the item', async (action) => {
        const { connector, fields } = await setup();
        const item = valueOf(await connector.addItem({ title: 'Keep this item', fields: fields.add }));
        const error = errorOf<unknown>(action === 'note' ? await connector.noteItem(item.id, '') : await connector.closeItem(item.id, ''));
        expect(exitCodeOf[error.kind]).toBe(2);
        expect(error.message).toContain('is empty');
        expect(valueOf(await connector.listItems({ all: true }))).toEqual([item]);
      });

      it.each(['open', 'closed'])('adds a note to a %s item without other changes', async (state) => {
        const { connector, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'Keep this item', fields: fields.add }));
        const before = state === 'closed' ? valueOf(await connector.closeItem(added.id)) : added;
        const { item, note } = valueOf(await connector.noteItem(added.id, '  Work can continue  '));
        expect(note).toEqual({ text: 'Work can continue', at: expect.stringMatching(UTC_TIME) });
        expect(item).toEqual({ ...before, record: { ...before.record, notes: [note] } });
        expect(valueOf(await connector.listItems({ all: true }))).toEqual([item]);
      });
    });

    describe('item close', () => {
      it('closes an item with the closed state, and keeps its id and its stage', async () => {
        const { connector, states, stages, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'Close me', fields: fields.add }));
        valueOf(await connector.moveItem(added.id, { stage: stages.next }));
        const closed = valueOf(await connector.closeItem(added.id));
        expect([closed.id, closed.status, closed.stage]).toEqual([added.id, states.closed, stages.next]);
      });

      it('hides a closed item from the list, and shows it when the list asks for all', async () => {
        const { connector, fields } = await setup();
        const open = valueOf(await connector.addItem({ title: 'Open', fields: fields.add }));
        const done = valueOf(await connector.addItem({ title: 'Done', fields: fields.add }));
        valueOf(await connector.closeItem(done.id));
        const hidden = valueOf(await connector.listItems({ all: false }));
        expect(hidden.map((entry) => entry.id)).toEqual([open.id]);
        const shown = valueOf(await connector.listItems({ all: true }));
        expect(shown.map((entry) => entry.id)).toEqual([open.id, done.id]);
      });

      it('closes an item that is closed already without an error', async () => {
        const { connector, states, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'Twice', fields: fields.add }));
        valueOf(await connector.closeItem(added.id));
        expect(valueOf(await connector.closeItem(added.id)).status).toBe(states.closed);
      });

      it('closes an open item and appends the reason after its earlier note', async () => {
        const { connector, states, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'Close with a reason', fields: fields.add }));
        const { item, note } = valueOf(await connector.noteItem(added.id, 'Work started'));
        const closed = valueOf(await connector.closeItem(added.id, '  Work is complete  '));
        const reason = { text: 'Work is complete', at: expect.stringMatching(UTC_TIME) };
        expect(closed).toEqual({ ...item, status: states.closed, record: { ...item.record, status: states.closed, notes: [note, reason] } });
        expect(valueOf(await connector.listItems({ all: true }))).toEqual([closed]);
      });

      it('refuses a reason after a plain close and gives the command to add a note', async () => {
        const { connector, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'Close once', fields: fields.add }));
        const closed = valueOf(await connector.closeItem(added.id));
        const error = errorOf(await connector.closeItem(added.id, 'Work is complete'));
        expect(exitCodeOf[error.kind]).toBe(2);
        expect(error.message).toContain(`the item ${added.id} is closed already`);
        expect(error.hint).toContain(`factory item note ${added.id} TEXT`);
        expect(valueOf(await connector.listItems({ all: true }))).toEqual([closed]);
      });

      it('refuses an item that is not there with exit 2', async () => {
        const { connector } = await setup();
        expect(exitOf(await connector.closeItem('B-999'))).toBe(2);
      });
    });

    describe('track add and list', () => {
      it('adds tracks and lists them in the order of the adds', async () => {
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

      it('refuses a track id that exists, and an id that is not a track id, with exit 2', async () => {
        const { connector } = await setup();
        valueOf(await connector.addTrack({ id: 'core', name: 'Core', roadmap: true }));
        expect(exitOf(await connector.addTrack({ id: 'core', name: 'Again', roadmap: false }))).toBe(2);
        expect(exitOf(await connector.addTrack({ id: 'Upper', name: 'Bad id', roadmap: false }))).toBe(2);
        expect(valueOf(await connector.listTracks()).map((track) => track.id)).toEqual(['core']);
      });
    });

    describe('decision ask', () => {
      it('asks a decision and gives its id', async () => {
        const { connector } = await setup();
        expect(valueOf(await connector.askDecision(decision))).toMatch(DECISION_ID);
      });

      it('gives each decision an id of its own', async () => {
        const { connector } = await setup();
        const first = valueOf(await connector.askDecision(decision));
        const second = valueOf(await connector.askDecision(decision));
        expect(second).not.toBe(first);
      });

      it('refuses a decision with no option with exit 2', async () => {
        const { connector } = await setup();
        expect(exitOf(await connector.askDecision({ ...decision, options: [] }))).toBe(2);
      });
    });

    describe('doc link', () => {
      it('links a file of the factory to an item', async () => {
        const { connector, doc, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'With a doc', fields: fields.add }));
        const linked = valueOf(await connector.linkDoc({ id: added.id, path: doc }));
        expect(linked.item.id).toBe(added.id);
        expect(linked.changed).toBe(true);
      });

      it('refuses an item that is not there, and a path that leaves the factory folder, with exit 2', async () => {
        const { connector, doc, fields } = await setup();
        const added = valueOf(await connector.addItem({ title: 'Refuse a doc', fields: fields.add }));
        expect(exitOf(await connector.linkDoc({ id: 'B-999', path: doc }))).toBe(2);
        expect(exitOf(await connector.linkDoc({ id: added.id, path: '../outside.md' }))).toBe(2);
      });
    });

    describe('changes read', () => {
      it('reads the changes since a cursor as events with an author, and a cursor for the next read', async () => {
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
