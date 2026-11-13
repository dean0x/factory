import type { LinkConfig } from '../config/schema.js';
import { childReasons } from '../names.js';
import type { Transport } from './transport.js';

/** One child as the commands show it: the entry of the config, and what a ping learns. */
export interface ChildRow {
  readonly id: string;
  readonly address: string;
  /** The layer of the child, or null when the child is not ok. */
  readonly layer: number | null;
  /** `unknown`: the child does not answer. `mismatch`: the child answers with another id than the config lists. */
  readonly status: 'ok' | 'unknown' | 'mismatch';
  /** Why the child is not ok, as a fixed text of this program, or null. */
  readonly reason: string | null;
}

const problemRow = (link: LinkConfig, status: 'unknown' | 'mismatch', reason: string): ChildRow => ({
  id: link.id,
  address: link.address,
  layer: null,
  status,
  reason,
});

/**
 * Ping each child once, in the order of the config. A child that does not answer is `unknown`. A child that answers with another
 * id is a `mismatch`, and its row holds a fixed reason, never the id that it showed. The list is the validated `children` of the
 * config, so it has at most 200 entries.
 */
export const probeChildren = async (
  transport: Transport,
  children: readonly LinkConfig[],
): Promise<readonly ChildRow[]> => {
  const rows: ChildRow[] = [];
  for (const link of children) {
    const answer = await transport.ping(link.address);
    if (answer.kind === 'unknown') {
      rows.push(problemRow(link, 'unknown', answer.reason));
    } else if (answer.id !== link.id) {
      rows.push(problemRow(link, 'mismatch', childReasons.otherId));
    } else {
      rows.push({ id: link.id, address: link.address, layer: answer.layer, status: 'ok', reason: null });
    }
  }
  return rows;
};
