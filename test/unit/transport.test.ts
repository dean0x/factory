import { describe, expect, it } from 'vitest';
import type { Transport } from '../../src/comms/transport.js';
import { fileTransport } from '../helpers/package-registry.js';
import { renderConfig } from '../../src/config/render.js';
import { createFakeDeps, type FakeDeps } from '../helpers/fake-deps.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { STATE_GITIGNORE } from '../../src/state/files.js';

const CHILD = '/srv/web-factory';

const withConfig = (text: string | null): { deps: FakeDeps; transport: Transport } => {
  const deps = createFakeDeps({ cwd: '/w' });
  deps.seedDir(CHILD);
  if (text !== null) deps.seed(`${CHILD}/factory.yaml`, text);
  return { deps, transport: fileTransport(deps) };
};

const childConfig = (change: (config: ReturnType<typeof sampleConfig>) => unknown = (config) => config): string =>
  renderConfig(change(sampleConfig()) as ReturnType<typeof sampleConfig>).shared;

describe('file transport: ping', () => {
  it('gives the id, the layer and the schema of a child that has a valid config', async () => {
    const { transport } = withConfig(
      childConfig((config) => ({ ...config, core: { ...config.core, node: { id: 'web', layer: 1 } } })),
    );
    expect(await transport.ping(`file://${CHILD}`)).toEqual({ kind: 'known', id: 'web', layer: 1, schema: 2 });
  });

  it('needs no local file of the child: a ping reads only the shared file', async () => {
    const { deps, transport } = withConfig(childConfig());
    expect(deps.files.has(`${CHILD}/factory.local.yaml`)).toBe(false);
    expect((await transport.ping(`file://${CHILD}`)).kind).toBe('known');
  });

  it('accepts an address with a trailing slash', async () => {
    const { transport } = withConfig(childConfig());
    expect((await transport.ping(`file://${CHILD}/`)).kind).toBe('known');
  });

  it('is unknown, with a reason, when the home does not exist', async () => {
    const { transport } = withConfig(null);
    expect(await transport.ping('file:///srv/nowhere')).toEqual({ kind: 'unknown', reason: 'no factory.yaml found there' });
  });

  it('is unknown when the home has no config', async () => {
    const { transport } = withConfig(null);
    expect(await transport.ping(`file://${CHILD}`)).toEqual({ kind: 'unknown', reason: 'no factory.yaml found there' });
  });

  it('is unknown, and names the key, when the config is not valid', async () => {
    const { transport } = withConfig(childConfig().replace('effort: high', 'effort: wild'));
    const result = await transport.ping(`file://${CHILD}`);
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') expect(result.reason).toContain('session.effort');
  });

  it('is unknown when the config does not parse', async () => {
    const { transport } = withConfig('a: [1\n');
    const result = await transport.ping(`file://${CHILD}`);
    expect(result).toMatchObject({ kind: 'unknown' });
    if (result.kind === 'unknown') expect(result.reason).toContain('factory.yaml does not parse');
  });

  it('is unknown, and says that the file is too large, for a config over the size limit', async () => {
    const { transport } = withConfig(`${childConfig()}# ${'x'.repeat(1_048_577)}\n`);
    const result = await transport.ping(`file://${CHILD}`);
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') expect(result.reason).toContain('larger than 1048576 bytes');
  });

  it('is unknown for a newer schema, reports the schema, and says that this factory needs the upgrade', async () => {
    const { transport } = withConfig('schema: 3\n');
    const result = await transport.ping(`file://${CHILD}`);
    expect(result).toMatchObject({ kind: 'unknown', schema: 3 });
    if (result.kind === 'unknown') {
      expect(result.reason).toContain('schema 3');
      expect(result.reason).toContain('upgrade factory');
      expect(result.reason).not.toContain('"factory upgrade"');
    }
  });

  it('is unknown for an older schema, reports the schema, and says that the child needs the upgrade', async () => {
    const { transport } = withConfig('schema: 1\n');
    const result = await transport.ping(`file://${CHILD}`);
    expect(result).toMatchObject({ kind: 'unknown', schema: 1 });
    if (result.kind === 'unknown') {
      expect(result.reason).toContain('schema 1');
      expect(result.reason).toContain('run "factory upgrade" in that factory folder');
    }
  });

  it.each([
    ['ssh', 'ssh://owner@host/srv/web-factory'],
    ['https', 'https://example.com/x'],
    ['a relative path', 'web-factory'],
    ['a host', 'file://host/srv/web-factory'],
  ])('is unknown for %s, and reads no file', async (_name, address) => {
    const { deps } = withConfig(childConfig());
    let reads = 0;
    const watched = {
      ...deps,
      fs: {
        ...deps.fs,
        stat: async (path: string) => {
          reads += 1;
          return deps.fs.stat(path);
        },
      },
    };
    const result = await fileTransport(watched).ping(address);
    expect(result.kind).toBe('unknown');
    expect(reads).toBe(0);
  });

  it('never repeats a value of the config in the reason', async () => {
    const { transport } = withConfig(childConfig().replace('id: demo', 'id: SECRET-VALUE'));
    const result = await transport.ping(`file://${CHILD}`);
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') expect(result.reason).not.toContain('SECRET');
  });
});

describe('file transport: deliver', () => {
  const input = { senderId: 'root', senderAddress: 'file:///srv/root', targetId: 'web', targetLayer: 1, body: 'Do the task.\n' };

  it('writes the message file into the inbox of a child that answers with the target id and layer', async () => {
    const { deps, transport } = withConfig(
      childConfig((config) => ({ ...config, core: { ...config.core, node: { id: 'web', layer: 1 } } })),
    );
    deps.seed(`${CHILD}/.factory/.gitignore`, STATE_GITIGNORE);
    const result = await transport.deliver(`file://${CHILD}`, input);
    expect(result).toEqual({ kind: 'written', path: `${CHILD}/.factory/inbox/2030-01-02T03-04-05-678Z-root-00000001.md` });
    expect(deps.files.get(result.kind === 'written' ? result.path : '')).toContain('Target node id: web');
  });

  it('gives notAnswering for a home that has no config', async () => {
    const { transport } = withConfig(null);
    expect(await transport.deliver(`file://${CHILD}`, input)).toEqual({ kind: 'notAnswering' });
  });
});
