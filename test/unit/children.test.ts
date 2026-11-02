import { describe, expect, it } from 'vitest';
import { probeChildren } from '../../src/comms/children.js';
import type { PingResult, Transport } from '../../src/comms/transport.js';

const transportOf = (answers: Record<string, PingResult>): { transport: Transport; pinged: string[] } => {
  const pinged: string[] = [];
  return {
    pinged,
    transport: {
      ping: async (address) => {
        pinged.push(address);
        return answers[address] ?? { kind: 'unknown', reason: 'no answer' };
      },
    },
  };
};

describe('probe the children', () => {
  it('gives no row for no child, and pings nobody', async () => {
    const { transport, pinged } = transportOf({});
    expect(await probeChildren(transport, [])).toEqual([]);
    expect(pinged).toEqual([]);
  });

  it('gives the layer of a child that answers with its own id', async () => {
    const { transport } = transportOf({ 'file:///a': { kind: 'known', id: 'a', layer: 1, schema: 2 } });
    expect(await probeChildren(transport, [{ id: 'a', address: 'file:///a' }])).toEqual([
      { id: 'a', address: 'file:///a', layer: 1, status: 'ok', reason: null },
    ]);
  });

  it('marks a child that does not answer as unknown, with the reason', async () => {
    const { transport } = transportOf({ 'file:///b': { kind: 'unknown', reason: 'no factory.yaml found there' } });
    expect(await probeChildren(transport, [{ id: 'b', address: 'file:///b' }])).toEqual([
      { id: 'b', address: 'file:///b', layer: null, status: 'unknown', reason: 'no factory.yaml found there' },
    ]);
  });

  it('marks a child that answers with another id as unknown', async () => {
    const { transport } = transportOf({ 'file:///c': { kind: 'known', id: 'other', layer: 1, schema: 2 } });
    const [row] = await probeChildren(transport, [{ id: 'c', address: 'file:///c' }]);
    expect(row).toMatchObject({ status: 'unknown', layer: null });
    expect(row?.reason).toBe('that home holds the id other, not c');
  });

  it('keeps the order of the config and pings each child once', async () => {
    const { transport, pinged } = transportOf({
      'file:///a': { kind: 'known', id: 'a', layer: 1, schema: 2 },
      'file:///b': { kind: 'known', id: 'b', layer: 1, schema: 2 },
    });
    const rows = await probeChildren(transport, [
      { id: 'b', address: 'file:///b' },
      { id: 'a', address: 'file:///a' },
    ]);
    expect(rows.map((row) => row.id)).toEqual(['b', 'a']);
    expect(pinged).toEqual(['file:///b', 'file:///a']);
  });
});
