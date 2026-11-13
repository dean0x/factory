import { usageError, type CliResult } from '../cli/errors.js';
import { displayLine, tableLines, type CommandOutput, type OutLine } from '../cli/output.js';
import type { NodeReport, ReportChild } from '../comms/report-schema.js';
import { fileTransport } from '../comms/transport.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { commands, commandText, flags, flagText, reportWords } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { readNodeFacts, reportDocOf } from '../report/build.js';
import { writeReportFile } from '../report/outbox.js';
import type { WorkItemPort } from '../workers/work-items.js';
import { openBoard } from './board-open.js';

export interface ReportOptions {
  readonly home: string | undefined;
  /** The cursor of the flag `--since`. The report has no cursor yet, so any value ends the command with a usage error. */
  readonly since: string | undefined;
}

/** What the verdict line needs besides the document: the facts of the workers that the document does not hold. */
export interface ReportNotes {
  /** The folders of the worker registry that hold no valid record. */
  readonly notValid: number;
  /** True when reading the workers gave a warning. */
  readonly hasWarnings: boolean;
}

const summary = reportWords.summary;

const countOf = (word: string, count: number, note: string | null): string => `${word} ${count}${note === null ? '' : ` (${note})`}`;

/**
 * The first line of the text: the verdict word, the node and its layer, and the counts. The verdict is `CHECK:` when a worker record
 * is not valid, when the facts of the workers gave a warning, or when a child is not `ok`; else it is `OK:`. The rows and the warnings
 * below the line name each cause.
 */
const verdictLine = (report: NodeReport, notes: ReportNotes): OutLine => {
  const notOk = report.children.filter((child) => child.state !== reportWords.childStates.ok).length;
  const check = notes.notValid > 0 || notes.hasWarnings || notOk > 0;
  const counts = [
    countOf(summary.workers, report.workers.length, notes.notValid > 0 ? `${notes.notValid} ${summary.notValid}` : null),
    countOf(summary.inProgress, report.inProgress.length, null),
    countOf(summary.requests, report.requests.length, null),
    countOf(summary.children, report.children.length, notOk > 0 ? `${notOk} ${summary.notOk}` : null),
  ];
  const verdict = check ? reportWords.verdict.check : reportWords.verdict.ok;
  return { level: 'heading', text: `${verdict} ${displayLine(report.id)} (${summary.layer} ${report.layer}): ${counts.join(', ')}` };
};

const cellOf = (value: number | null, unit = ''): string => (value === null ? reportWords.empty : `${value}${unit}`);

const childCells = (child: ReportChild): readonly string[] =>
  [
    child.id,
    child.state,
    cellOf(child.counts?.workers ?? null),
    cellOf(child.counts?.inProgress ?? null),
    cellOf(child.counts?.requests ?? null),
    cellOf(child.counts?.children ?? null),
    cellOf(child.age, reportWords.ageUnit),
    child.reason ?? reportWords.empty,
  ].map((cell) => displayLine(cell));

/** The text of `report`: the verdict line, then one row for each child. A node with no child has the verdict line alone. */
export const reportLines = (report: NodeReport, notes: ReportNotes): readonly OutLine[] => [
  verdictLine(report, notes),
  ...(report.children.length === 0 ? [] : tableLines(Object.values(reportWords.columns), report.children.map(childCells))),
];

/**
 * `report`: the report of the node (design 5.4), as text with the verdict line first, or as the document with the flag `--json`. The
 * document is the one that the builder makes for `status` too. Each run writes it to the report file, and the file holds the same
 * text as `report --json`. The flag `--since` is not available yet (the report has no events), so it is a usage error. A node whose
 * board cannot be read has no report: the command fails with the error of the board and writes no file. Any fault of the write is an
 * error of the command, and a link is a security stop (exit 4).
 */
export const runReport = async (
  deps: Deps,
  options: ReportOptions,
  registry: RecipeRegistry,
  workItems: WorkItemPort,
): Promise<CliResult<CommandOutput>> => {
  if (options.since !== undefined) {
    return usageError(
      `${flagText(flags.since)} is not available yet: the report has no events and no cursor`,
      `Run "${commandText(commands.report)}" with no ${flagText(flags.since)} to read the whole report.`,
    );
  }
  const opened = await openBoard(deps, options.home, registry, commands.report);
  if (!opened.ok) return opened;
  const { home, config, connector } = opened.value;
  const read = await readNodeFacts(deps, { home, config, board: connector, workItems, transport: fileTransport(deps, registry) });
  if (!read.ok) return read;
  const document = reportDocOf(read.value);
  if (!document.ok) return document;
  const written = await writeReportFile(deps, home, document.value);
  if (!written.ok) return written;
  const { invalid, warnings } = read.value.status;
  return ok({
    lines: reportLines(document.value, { notValid: invalid.length, hasWarnings: warnings.length > 0 }),
    json: document.value,
    warnings,
    failed: false,
  });
};
