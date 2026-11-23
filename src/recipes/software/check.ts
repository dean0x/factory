import { exitCodeOf, usageError, type CliResult } from '../../cli/errors.js';
import { foundHomeOption } from '../../cli/home-option.js';
import type { CommandOutput } from '../../cli/output.js';
import type { Command, Given } from '../../cli/table.js';
import type { Deps } from '../../core/deps.js';
import { ok } from '../../core/result.js';
import { isGuardOn } from '../../guards/effective.js';
import { commands, commandText, flags, flagText, workLookupReasons } from '../../names.js';
import type { RecipeHost } from '../entry.js';
import { mergeCheck, parsePrNumber } from './github-pr.js';
import { softwareGuardIds } from './guard-parts.js';
import { readinessFor, type Readiness } from './merge-ready.js';
import { checkPrRulesOff, checkReasons, checkRemedies, checkRollupReason, checkSchemaId, checkWords, readinessKinds } from './words.js';

const CHECK_LINE = `${commandText(commands.check)} PR`;
const USAGE_HINT = `Run "${commandText(commands.check)} ${flagText(flags.help)}".`;
const MAX_LINES = 20;
const fixedReasons: ReadonlySet<string> = new Set([...Object.values(checkReasons), checkRollupReason]);
const lookupReasons: ReadonlySet<string> = new Set(Object.values(workLookupReasons));

interface CheckOutcome {
  readonly result: keyof typeof checkWords;
  readonly exitCode: number;
  readonly reasons: readonly string[];
  readonly remedy: string | null;
  readonly head?: string;
}

const notReady = (reasons: readonly string[], remedy: string, head?: string): CheckOutcome => ({
  result: readinessKinds.notReady, exitCode: exitCodeOf['not-ready'], reasons, remedy,
  ...(head === undefined ? {} : { head }),
});

const unreadable = (reason: string, remedy: string): CheckOutcome => ({
  result: readinessKinds.unreadable, exitCode: exitCodeOf.failure, reasons: [reason], remedy,
});

/** Do not pass local record text, raw responses or their errors to the output. */
const outcomeOf = (read: Readiness): CheckOutcome => {
  switch (read.kind) {
    case readinessKinds.ready:
      return { result: read.kind, exitCode: 0, reasons: [], remedy: null, head: read.pr.headRefOid };
    case readinessKinds.notReady: {
      const reasons = read.reasons.map((reason) => fixedReasons.has(reason) ? reason : checkReasons.headConflict);
      if (reasons.includes(checkReasons.openRequest)) return notReady(reasons, checkRemedies.request);
      if (reasons.includes(checkReasons.headConflict)) return notReady(reasons, checkRemedies.board);
      return notReady(reasons, checkRemedies.again);
    }
    case readinessKinds.lookup:
      return notReady([lookupReasons.has(read.cause) ? read.cause : checkReasons.boardUnreadable], checkRemedies.board);
    case readinessKinds.headMoved:
      return { ...notReady([checkReasons.headMoved], checkRemedies.head, read.head), result: read.kind };
    case readinessKinds.mergedAtPin:
      return notReady([checkReasons.merged], checkRemedies.again, read.pr.headRefOid);
    case readinessKinds.unreadable:
      if (read.cause === checkReasons.viewUnreadable || read.cause === checkReasons.compareUnreadable || read.cause === checkReasons.noMergeTime) {
        return unreadable(read.cause, checkRemedies.github);
      }
      if (read.cause === checkReasons.unsupportedRepo || read.cause === checkReasons.noDefaultBranch) {
        return unreadable(read.cause, checkRemedies.node);
      }
      return unreadable(checkReasons.boardUnreadable, checkRemedies.board);
    default: return read satisfies never;
  }
};

const outputOf = ({ result, exitCode, reasons, remedy, head }: CheckOutcome, pr: number, prRulesOff = false): CommandOutput => {
  const shown = reasons.slice(0, MAX_LINES - 1 - Number(remedy !== null) - Number(prRulesOff));
  const lines = [checkWords[result], ...shown, ...(remedy === null ? [] : [remedy]), ...(prRulesOff ? [checkPrRulesOff] : [])];
  return {
    lines: lines.map((text) => ({ level: 'text', text })),
    json: { schema: checkSchemaId, result, pr, head: head ?? null, reasons: shown, remedy, offGuards: prRulesOff ? [softwareGuardIds.prRules] : [] },
    warnings: [],
    failed: exitCode !== 0,
    exitCode,
  };
};

/** Check the argument form before any host read. The command runs no caller check and writes nothing. */
const run = async (host: RecipeHost, given: Given, deps: Deps): Promise<CliResult<CommandOutput>> => {
  const [text, extra] = given.positionals();
  if (text === undefined || extra !== undefined) return usageError(`${commandText(commands.check)} needs exactly one PR number`, USAGE_HINT);
  const number = parsePrNumber(text, 'PR number');
  if (!number.ok) return usageError(number.error.message, USAGE_HINT);
  const head = given.string(flags.head);
  if (head !== undefined && !mergeCheck.shaPattern.test(head)) {
    return usageError(`${flagText(flags.head)}: must be a full commit id of 40 lowercase hex digits`, USAGE_HINT);
  }
  const nodeFault = (prRulesOff = false) => ok(outputOf(unreadable(checkReasons.nodeUnreadable, checkRemedies.node), number.value, prRulesOff));
  const home = await host.locateNode(deps, given.string(flags.home), commands.check);
  if (!home.ok) return home.error.kind === 'usage' ? home : nodeFault();
  const work = await host.openWork(deps, home.value, commands.check);
  if (!work.ok) return work.error.kind === 'usage' ? work : nodeFault();
  const prRulesOff = !isGuardOn(work.value.guards, softwareGuardIds.prRules);
  const project = await host.loadProject(deps, home.value, given.string(flags.project), commands.check);
  if (!project.ok) return project.error.kind === 'usage' ? project : nodeFault(prRulesOff);
  const read = await readinessFor(deps, work.value, { pr: number.value, head, project: project.value });
  return ok(outputOf(outcomeOf(read), number.value, prRulesOff));
};

/** The top-level check row of the software recipe. */
export const checkCommandFor = (host: RecipeHost): Command => ({
  name: commands.check,
  summary: 'Check if a pull request is ready. The result is no approval.',
  usage: `${CHECK_LINE} [${flagText(flags.head)} SHA] [${flagText(flags.project)} ID] [${flagText(flags.home)} DIR] [${flagText(flags.json)}]`,
  positionals: true,
  options: {
    [flags.home]: foundHomeOption,
    [flags.head]: { type: 'string', placeholder: 'SHA', description: 'The head to check, as 40 lowercase hex digits.' },
    [flags.project]: { type: 'string', placeholder: 'ID', description: 'The project id. Give it if the config lists more than one project.' },
  },
  run: (given, deps) => run(host, given, deps),
});
