import { env, places } from '../names.js';
import type { FlagOption } from './table.js';

/**
 * The flag that sets the folder of the node for a command that reads a node. The command table and the commands that a recipe adds
 * share it. It lives apart from the command table, so a recipe can import it with no run-time import of the table.
 */
export const foundHomeOption: FlagOption = {
  type: 'string',
  placeholder: 'DIR',
  description:
    `The ${places.folder}. Default: ${env.home}, which stops when the current folder is in another listed ${places.folder}, ` +
    `else the folder of the nearest config file ` +
    `above the current folder, else the ${places.folder} that the ${places.list} gives for the current folder.`,
};
