import { usageError } from '../../cli/errors.js';
import { foundHomeOption } from '../../cli/home-option.js';
import type { Command } from '../../cli/table.js';
import { commands, commandText, flags, flagText } from '../../names.js';
import type { RecipeHost } from '../entry.js';
import { runPrMerge } from './pr-merge.js';
import { runWatch } from './pr-watch.js';
import { prCommands, prFlags, prMergeCommand, prMergeWords, prWatchCommand, prWatchPoll } from './words.js';

const SUBCOMMANDS = Object.values(prCommands).join(', ');
const WATCH_LINE = `${prWatchCommand} PR`;
const MERGE_LINE = `${prMergeCommand} PR ${flagText(prFlags.head)} SHA`;
const PROJECT_AND_HOME = `[${flagText(flags.project)} ID] [${flagText(flags.home)} DIR]`;
const SUBCOMMAND_HINT = `Run "${WATCH_LINE}" or "${MERGE_LINE}".`;

/** The `pr` row of the command table. */
export const prCommandFor = (host: RecipeHost): Command => ({
  name: commands.pr,
  summary:
    `Watch the checks of one pull request at one head: up to ${prWatchPoll.reads} reads, ${prWatchPoll.intervalMs / 1000} seconds apart. ` +
    'Exit 0 means every check passed. It is no approval. Merge checks the pinned head and records the merge.',
  usage: [
    `${WATCH_LINE} [${flagText(prFlags.head)} SHA] ${PROJECT_AND_HOME}`,
    `${MERGE_LINE} ${PROJECT_AND_HOME} [${flagText(prFlags.admin)}] [${flagText(flags.json)}]`,
  ].join(`\n${' '.repeat('Usage: '.length)}`) + `\n\n${prMergeWords.terminal}`,
  positionals: true,
  options: {
    [flags.home]: foundHomeOption,
    [prFlags.head]: {
      type: 'string',
      placeholder: 'SHA',
      description: 'The head as 40 lowercase hex digits. Merge needs it. Watch uses the head of the first read by default.',
    },
    [prFlags.admin]: {
      type: 'boolean',
      description: 'With merge: ask GitHub to skip the branch rules.',
    },
    [flags.project]: {
      type: 'string',
      placeholder: 'ID',
      description: 'The project id. Give it if the config lists more than one project.',
    },
  },
  run: async (given, deps) => {
    const [subcommand, ...words] = given.positionals();
    if (subcommand === undefined) {
      return usageError(`${commandText(commands.pr)} needs a subcommand: ${SUBCOMMANDS}`, SUBCOMMAND_HINT);
    }
    switch (subcommand) {
      case prCommands.watch:
        if (given.bool(prFlags.admin)) {
          return usageError(`Unknown option '${flagText(prFlags.admin)}'`, `Run "${commandText(commands.pr)} ${flagText(flags.help)}".`);
        }
        return runWatch(host, deps, words, given);
      case prCommands.merge:
        return runPrMerge(host, deps, words, given);
      default:
        return usageError(`unknown subcommand ${JSON.stringify(subcommand)}. The subcommands are: ${SUBCOMMANDS}`, SUBCOMMAND_HINT);
    }
  },
});
