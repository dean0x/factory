import { usageError } from '../../cli/errors.js';
import { foundHomeOption } from '../../cli/home-option.js';
import type { Command } from '../../cli/table.js';
import { commands, commandText, flags, flagText } from '../../names.js';
import type { RecipeHost } from '../entry.js';
import { runWatch } from './pr-watch.js';
import { prCommands, prFlags, prWatchCommand, prWatchPoll } from './words.js';

const SUBCOMMANDS = Object.values(prCommands).join(', ');
const WATCH_LINE = `${prWatchCommand} PR`;
const SUBCOMMAND_HINT = `Run "${WATCH_LINE}" with the number of a PR.`;

/** The `pr` row of the command table. */
export const prCommandFor = (host: RecipeHost): Command => ({
  name: commands.pr,
  summary:
    `Watch the checks of one pull request at one head: up to ${prWatchPoll.reads} reads, ${prWatchPoll.intervalMs / 1000} seconds apart. ` +
    'Exit 0 means every check passed. It is no approval.',
  usage: `${WATCH_LINE} [${flagText(prFlags.head)} SHA] [${flagText(flags.project)} ID] [${flagText(flags.home)} DIR]`,
  positionals: true,
  options: {
    [flags.home]: foundHomeOption,
    [prFlags.head]: {
      type: 'string',
      placeholder: 'SHA',
      description: 'With watch: the full commit id of the head to watch, 40 lowercase hex digits. Default: the head of the first read.',
    },
    [flags.project]: {
      type: 'string',
      placeholder: 'ID',
      description: 'With watch: the id of the project that the PR belongs to. It is needed when the config lists more than one project.',
    },
  },
  run: async (given, deps) => {
    const [subcommand, ...words] = given.positionals();
    if (subcommand === undefined) {
      return usageError(`${commandText(commands.pr)} needs a subcommand: ${SUBCOMMANDS}`, SUBCOMMAND_HINT);
    }
    if (subcommand !== prCommands.watch) {
      return usageError(`unknown subcommand ${JSON.stringify(subcommand)}. The subcommand is: ${SUBCOMMANDS}`, SUBCOMMAND_HINT);
    }
    return runWatch(host, deps, words, given);
  },
});
