import { inspectSharedConfig } from '../config/load.js';
import { CONFIG_SCHEMA_VERSION } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { commands, commandText, files, keys, places, program } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { checkFileAddress } from './address.js';
import { deliverToHome, type DeliverInput, type DeliverResult } from './deliver.js';

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
 * How to reach another node. The address says where it is. `ping` learns who answers there, and `deliver` puts a message
 * file in its inbox. `report` comes with the reports. A node that cannot be read is `unknown`, never an error, and a delivery
 * that fails is a kind of `DeliverResult`, never a throw.
 */
export interface Transport {
  ping(address: string): Promise<PingResult>;
  deliver(address: string, input: DeliverInput): Promise<DeliverResult>;
}

const unknown = (reason: string, schema?: number): PingResult =>
  schema === undefined ? { kind: 'unknown', reason } : { kind: 'unknown', reason, schema };

/**
 * The transport for a `file://` address: a node home on this machine. The ping reads the shared config of that node
 * with the normal loader. It needs only the id and the layer, so it reads no local file of the other node. The delivery uses
 * the same ping before and after the write (see `deliverToHome`).
 */
export const fileTransport = (deps: Deps, registry: RecipeRegistry): Transport => {
  const ping = async (address: string): Promise<PingResult> => {
    const checked = checkFileAddress(address);
    if (!checked.ok) return unknown(checked.error);

    const state = await inspectSharedConfig(deps, checked.value, registry);
    switch (state.kind) {
      case 'valid':
        return { kind: 'known', id: state.value.core.node.id, layer: state.value.core.node.layer, schema: state.version };
      case 'missing':
        return unknown(`no ${files.config} found there`);
      case 'unparsable':
        return unknown(`${files.config} does not parse: ${state.message}`);
      case 'invalid':
        return unknown(`${files.config} is invalid: ${state.message}`);
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
  return { ping, deliver: (address, input) => deliverToHome(deps, ping, address, input) };
};
