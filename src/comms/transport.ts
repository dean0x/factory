import { inspectSharedConfig } from '../config/load.js';
import { CONFIG_SCHEMA_VERSION } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { childReasons, commands, commandText, files, keys, places, program } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { layoutOf } from '../state/layout.js';
import { checkFileAddress } from './address.js';
import { configAccessOf } from './config-access.js';
import { deliverToHome, type DeliverInput, type DeliverResult } from './deliver.js';
import { readChildReport, type ChildReportRead } from './report-read.js';

/** What a ping learns about a node. */
export type PingResult =
  | { readonly kind: 'known'; readonly id: string; readonly layer: number; readonly schema: number }
  | {
      readonly kind: 'unknown';
      readonly reason: string;
      /** The schema of the config, when the ping could read it and it is not the current one. */
      readonly schema?: number;
    };

/**
 * How to reach another node. The address says where it is. `ping` learns who answers there, `deliver` puts a message file in its
 * inbox, and `report` reads its report file. A node that cannot be read is `unknown`, never an error, and a delivery that fails is
 * a kind of `DeliverResult`, never a throw. `maxBytes` is the most that one `report` call reads.
 */
export interface Transport {
  ping(address: string): Promise<PingResult>;
  deliver(address: string, input: DeliverInput): Promise<DeliverResult>;
  report(address: string, maxBytes: number): Promise<ChildReportRead>;
}

const unknown = (reason: string, schema?: number): PingResult =>
  schema === undefined ? { kind: 'unknown', reason } : { kind: 'unknown', reason, schema };

const NO_CONFIG = `no ${files.config} found there`;
const CONFIG_UNREADABLE = `${files.config} could not be read`;

/**
 * Look at the shared config of the child before any read of its text (`configAccessOf`). The value is the answer that stops the
 * ping, or null when the config may be read. No entry, or an entry that is not a file, gives the answer of a missing config. A link,
 * another owner, and a write bit of a group or of others give the fixed reason of an unsafe config. A fault of the file system gives
 * a fixed reason too. No answer holds the text of the fault.
 */
const configFault = async (deps: Deps, path: string): Promise<PingResult | null> => {
  const access = await configAccessOf(deps, path);
  switch (access) {
    case 'safe':
      return null;
    case 'unsafe':
      return unknown(childReasons.configUnsafe);
    case 'missing':
      return unknown(NO_CONFIG);
    case 'unreadable':
      return unknown(CONFIG_UNREADABLE);
    default: {
      const unreachable: never = access;
      return unreachable;
    }
  }
};

/**
 * The transport for a `file://` address: a node home on this machine. The ping reads the shared config of that node
 * with the normal loader, after it checked that the file is no link, is of this account, and has no write bit for a group or for
 * others. It needs only the id and the layer, so it reads no local file of the other node. The delivery uses the same ping before
 * and after the write (see `deliverToHome`). The report is the report file of the node (see `readChildReport`).
 */
export const fileTransport = (deps: Deps, registry: RecipeRegistry): Transport => {
  const ping = async (address: string): Promise<PingResult> => {
    const checked = checkFileAddress(address);
    if (!checked.ok) return unknown(checked.error);

    const fault = await configFault(deps, layoutOf(checked.value).configFile);
    if (fault !== null) return fault;

    const state = await inspectSharedConfig(deps, checked.value, registry);
    switch (state.kind) {
      case 'valid':
        return { kind: 'known', id: state.value.core.node.id, layer: state.value.core.node.layer, schema: state.version };
      case 'missing':
        return unknown(NO_CONFIG);
      case 'unparsable':
        return unknown(`${files.config} does not parse: ${state.message}`);
      case 'invalid':
        return unknown(childReasons.configInvalid);
      case 'unsafe':
        return unknown(state.message);
      case 'older':
        return unknown(
          `${files.config} has ${keys.root.schema} ${state.version}: run "${commandText(commands.upgrade)}" in that ${places.folder}`,
          state.version,
        );
      case 'newer':
        return unknown(
          `${files.config} has ${keys.root.schema} ${state.version}, but this ${program} reads up to ${CONFIG_SCHEMA_VERSION}: upgrade ${program}`,
          state.version,
        );
      default: {
        const unreachable: never = state;
        return unreachable;
      }
    }
  };
  return {
    ping,
    deliver: (address, input) => deliverToHome(deps, ping, address, input),
    report: (address, maxBytes) => readChildReport(deps, address, maxBytes),
  };
};
