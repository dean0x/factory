import { z } from 'zod';
import { slug } from '../config/primitives.js';
import { err, ok, type Result } from '../core/result.js';
import { describeIssues } from '../core/zod.js';
import { layers, lastSeen, reportKeys, reportLimits, reportWords, schemaIds } from '../names.js';
import { MAX_ADDRESS_LENGTH } from './address.js';

/**
 * The report of a node (design 5.4) as a contract between two nodes. This one schema has two jobs. A node writes only a
 * document that passes it, so the schema is the list of fields that may leave the node: every object is strict, so a key that is
 * not in the list (an owner prefix, a proxy, a session id, a pane, an approval value) can not enter a report. A parent node
 * reads the report file of a child with the same schema, so the file of a child is data to check and never a thing to trust.
 * Every text and every list has a cap, so a file of a child can not grow without a bound.
 *
 * The child row is final in this version of the report: `id`, `address`, `state`, `reason`, `counts` and `age`. A later change
 * of the reader or of the tree view adds no key to it, so the schema version stays 1.
 */

const doc = reportKeys.doc;
const workerKeys = reportKeys.worker;
const boardKeys = reportKeys.board;
const tallyKeys = reportKeys.tally;
const fieldKeys = reportKeys.field;
const itemKeys = reportKeys.item;
const requestKeys = reportKeys.request;
const childKeys = reportKeys.child;
const countKeys = reportKeys.counts;

const text = z.string().max(reportLimits.maxTextChars);
const name = z.string().min(1).max(reportLimits.maxTextChars);
const count = z.number().int().min(0).max(reportLimits.maxNumber);

const workerSchema = z.strictObject({
  [workerKeys.id]: slug,
  [workerKeys.project]: name,
  [workerKeys.state]: z.enum(reportWords.workerStates),
  [workerKeys.contextPct]: z.number().min(lastSeen.minPercent).max(lastSeen.maxPercent).nullable(),
  [workerKeys.activityAt]: z.iso.datetime().nullable(),
  [workerKeys.workItem]: text.nullable(),
  [workerKeys.idle]: z.boolean(),
});

const tallySchema = z.strictObject({ [tallyKeys.name]: name, [tallyKeys.count]: count });

const tallies = z.array(tallySchema).max(reportLimits.maxCountRows);

const fieldSchema = z.strictObject({ [fieldKeys.field]: name, [fieldKeys.values]: tallies });

const boardSchema = z.strictObject({
  [boardKeys.states]: tallies,
  [boardKeys.fields]: z.array(fieldSchema).max(reportLimits.maxCountRows),
});

const itemSchema = z.strictObject({
  [itemKeys.id]: name,
  [itemKeys.title]: text,
  [itemKeys.state]: name,
  [itemKeys.track]: text.nullable(),
  [itemKeys.stage]: text.nullable(),
});

const requestSchema = z.strictObject({
  [requestKeys.id]: name,
  [requestKeys.title]: text.nullable(),
  [requestKeys.origin]: name,
});

const countsSchema = z.strictObject({
  [countKeys.workers]: count,
  [countKeys.inProgress]: count,
  [countKeys.requests]: count,
  [countKeys.children]: count,
});

const childSchema = z.strictObject({
  [childKeys.id]: slug,
  [childKeys.address]: z.string().min(1).max(MAX_ADDRESS_LENGTH),
  [childKeys.state]: z.enum([reportWords.childStates.ok, reportWords.childStates.unknown, reportWords.childStates.mismatch]),
  [childKeys.reason]: text.nullable(),
  [childKeys.counts]: countsSchema.nullable(),
  [childKeys.age]: count.nullable(),
});

/**
 * The report document. The version of the schema is 1. The cursor is null and the list of events is empty in this version: the
 * event file comes later, and a version that sets them has a higher schema version.
 */
export const reportSchema = z.strictObject({
  [doc.schema]: z.literal(schemaIds.report),
  [doc.schemaVersion]: z.literal(reportLimits.schemaVersion),
  [doc.id]: slug,
  [doc.layer]: z.number().int().min(layers.coordinator).max(layers.max),
  [doc.factoryVersion]: z.string().min(1).max(reportLimits.maxVersionChars),
  [doc.cursor]: z.null(),
  [doc.workers]: z.array(workerSchema).max(reportLimits.maxWorkers),
  [doc.board]: boardSchema,
  [doc.inProgress]: z.array(itemSchema).max(reportLimits.maxItems),
  [doc.requests]: z.array(requestSchema).max(reportLimits.maxRequests),
  [doc.events]: z.tuple([]),
  [doc.children]: z.array(childSchema).max(reportLimits.maxChildren),
});

/** The report document of one node. */
export type NodeReport = z.infer<typeof reportSchema>;
export type ReportWorker = NodeReport[typeof doc.workers][number];
export type ReportBoard = NodeReport[typeof doc.board];
export type ReportItem = NodeReport[typeof doc.inProgress][number];
export type ReportRequest = NodeReport[typeof doc.requests][number];
/** The row of one direct child of the node. */
export type ReportChild = NodeReport[typeof doc.children][number];
/** The counts of a child row, from the report of that child. */
export type ReportCounts = NonNullable<ReportChild[typeof childKeys.counts]>;

/**
 * Check a value against the report schema. The error is the key path and the broken rule of each fault, at most five. It never
 * repeats a rejected value, and a key that looks like a token is hidden. The check never throws, and it does not change the input.
 */
export const parseReport = (input: unknown): Result<NodeReport, string> => {
  const parsed = reportSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err(describeIssues(parsed.error));
};
