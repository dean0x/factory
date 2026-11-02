import type { LinkConfig } from '../config/schema.js';
import type { Transport } from './transport.js';

/** One child as the commands show it: the entry of the config, and what a ping learns. */
export interface ChildRow {
  readonly id: string;
  readonly address: string;
  /** The layer of the child, or null when the child is unknown. */
  readonly layer: number | null;
  readonly status: 'ok' | 'unknown';
  /** Why the child is unknown, or null. */
  readonly reason: string | null;
}

const unknownRow = (link: LinkConfig, reason: string): ChildRow => ({
  id: link.id,
  address: link.address,
  layer: null,
  status: 'unknown',
  reason,
});

/**
 * Ping each child once, in the order of the config. A child that does not answer, or answers with another id,
 * is `unknown`. The list is the validated `children` of the config, so it has at most 200 entries.
 */
export const probeChildren = async (
  transport: Transport,
  children: readonly LinkConfig[],
): Promise<readonly ChildRow[]> => {
  const rows: ChildRow[] = [];
  for (const link of children) {
    const answer = await transport.ping(link.address);
    if (answer.kind === 'unknown') {
      rows.push(unknownRow(link, answer.reason));
    } else if (answer.id !== link.id) {
      rows.push(unknownRow(link, `that home holds the id ${answer.id}, not ${link.id}`));
    } else {
      rows.push({ id: link.id, address: link.address, layer: answer.layer, status: 'ok', reason: null });
    }
  }
  return rows;
};
