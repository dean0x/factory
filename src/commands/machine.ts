import type { CliResult } from '../cli/errors.js';
import type { CommandOutput, LineLevel, OutLine } from '../cli/output.js';
import { loadConfig, readNodeIdentity } from '../config/load.js';
import type { Deps } from '../core/deps.js';
import { locateHomeFolder } from '../core/home.js';
import { ok } from '../core/result.js';
import { capitalize, commands, schemaIds } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import {
  factText,
  gatherMachine,
  machineVerdict,
  type FactVerdict,
  type MachineReport,
} from '../workers/machine.js';

export interface MachineOptions {
  readonly home: string | undefined;
}

const LEVEL_OF: Readonly<Record<FactVerdict, LineLevel>> = { ok: 'ok', fail: 'fail', unknown: 'warn' };

const countOf = (report: MachineReport, verdict: FactVerdict): number =>
  report.filter((fact) => fact.verdict === verdict).length;

/** The verdict on the first line, then one line for each fact. A failed limit or an unknown fact does not fail the command. */
export const machineOutput = (home: string, report: MachineReport): CommandOutput => {
  const verdict = machineVerdict(report);
  const counts = `${countOf(report, 'ok')} ok, ${countOf(report, 'fail')} fail, ${countOf(report, 'unknown')} unknown`;
  const width = Math.max(...report.map((fact) => fact.name.length));
  const lines: readonly OutLine[] = [
    { level: LEVEL_OF[verdict], text: `${capitalize(commands.machine)}: ${verdict} (${counts})` },
    ...report.map((fact) => ({ level: LEVEL_OF[fact.verdict], text: `${fact.name.padEnd(width)}  ${factText(fact)}` })),
  ];
  return { lines, json: { schema: schemaIds.machine, home, verdict, facts: report }, warnings: [], failed: false };
};

export const runMachine = async (
  deps: Deps,
  options: MachineOptions,
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  const located = await locateHomeFolder(
    deps,
    options.home,
    (readDeps, folder) => readNodeIdentity(readDeps, folder, registry),
    commands.machine,
  );
  if (!located.ok) return located;
  const home = located.value.home;
  const config = await loadConfig(deps, home, registry);
  if (!config.ok) return config;
  return ok(machineOutput(home, await gatherMachine(deps, home, config.value.core.limits)));
};
