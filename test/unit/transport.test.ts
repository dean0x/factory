import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import type { NodeReport } from '../../src/comms/report-schema.js';
import type { PingResult, Transport } from '../../src/comms/transport.js';
import type { Deps } from '../../src/core/deps.js';
import { fileTransport } from '../helpers/package-registry.js';
import { renderConfig } from '../../src/config/render.js';
import { childReasons, layers, reportLimits, schemaIds } from '../../src/names.js';
import { createFakeDeps, withFsWatch, type FakeDeps } from '../helpers/fake-deps.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { STATE_GITIGNORE } from '../../src/state/files.js';
import { layoutOf } from '../../src/state/layout.js';

const CHILD = '/srv/web-factory';
const CONFIG = layoutOf(CHILD).configFile;
const OTHER_USER = 2000;

const withConfig = (
  text: string | null,
  options: Parameters<typeof createFakeDeps>[0] = {},
): { deps: FakeDeps; transport: Transport } => {
  const deps = createFakeDeps({ cwd: '/w', ...options });
  deps.seedDir(CHILD);
  if (text !== null) deps.seed(CONFIG, text);
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

  it('gives the fixed reason, with the remedy, and no key or value of the file, when the config is not valid', async () => {
    const { transport } = withConfig(childConfig().replace('effort: high', 'effort: wild'));
    const result = await transport.ping(`file://${CHILD}`);
    expect(result).toEqual({ kind: 'unknown', reason: childReasons.configInvalid });
    if (result.kind === 'unknown') {
      expect(result.reason).toContain('factory doctor');
      expect(result.reason).not.toContain('session.effort');
      expect(result.reason).not.toContain('wild');
    }
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

describe('file transport: ping, the checks of the config file', () => {
  const pingWatched = async (deps: FakeDeps): Promise<{ result: PingResult; touched: string[] }> => {
    const touched: string[] = [];
    const watched = withFsWatch(deps, (method, path) => {
      if (path === CONFIG) touched.push(method);
    });
    return { result: await fileTransport(watched).ping(`file://${CHILD}`), touched };
  };

  it('is unknown, and reads no text, when the config is a link', async () => {
    const { deps } = withConfig(childConfig(), { links: { [CONFIG]: '/elsewhere/factory.yaml' } });
    const { result, touched } = await pingWatched(deps);
    expect(result).toEqual({ kind: 'unknown', reason: childReasons.configUnsafe });
    expect(touched).toEqual(['openChecked']);
  });

  it('is unknown, and reads no text, when another account owns the config', async () => {
    const { deps } = withConfig(childConfig());
    deps.owners.set(CONFIG, OTHER_USER);
    const { result, touched } = await pingWatched(deps);
    expect(result).toEqual({ kind: 'unknown', reason: childReasons.configUnsafe });
    expect(touched).not.toContain('readTextLimited');
  });

  it.each([
    ['a group', 0o664],
    ['other users', 0o646],
  ])('is unknown, and reads no text, when %s can write the config', async (_who, mode) => {
    const { deps } = withConfig(childConfig());
    deps.modes.set(CONFIG, mode);
    const { result, touched } = await pingWatched(deps);
    expect(result).toEqual({ kind: 'unknown', reason: childReasons.configUnsafe });
    expect(touched).not.toContain('readTextLimited');
  });

  it('answers for a config that a group and other users can read but not write', async () => {
    const { deps } = withConfig(childConfig());
    deps.modes.set(CONFIG, 0o644);
    expect((await pingWatched(deps)).result.kind).toBe('known');
  });

  it('gives the reason of a missing config for a folder at the config path', async () => {
    const { deps, transport } = withConfig(null);
    deps.seedDir(CONFIG);
    expect(await transport.ping(`file://${CHILD}`)).toEqual({ kind: 'unknown', reason: 'no factory.yaml found there' });
  });

  it('gives a fixed reason, and no text of the fault, when the look at the config fails', async () => {
    const { deps } = withConfig(childConfig());
    const failing: Deps = { ...deps, fs: { ...deps.fs, openChecked: async () => failure('cannot look at /secret/path: EACCES') } };
    const result = await fileTransport(failing).ping(`file://${CHILD}`);
    expect(result).toEqual({ kind: 'unknown', reason: 'factory.yaml could not be read' });
    if (result.kind === 'unknown') expect(result.reason).not.toContain('secret');
  });
});

describe('file transport: report', () => {
  const REPORT_FILE = layoutOf(CHILD).reportFile;
  const REPORT: NodeReport = {
    schema: schemaIds.report,
    schemaVersion: reportLimits.schemaVersion,
    id: 'web',
    layer: layers.coordinator,
    factoryVersion: '1.0.0',
    cursor: null,
    workers: [],
    board: { states: [], statesOmitted: 0, fields: [] },
    inProgress: [],
    requests: [],
    events: [],
    children: [],
  };
  const withReport = (text: string | null): Transport => {
    const { deps, transport } = withConfig(childConfig());
    deps.seedDir(layoutOf(CHILD).stateDir);
    deps.seedDir(layoutOf(CHILD).outboxDir);
    if (text !== null) deps.seed(REPORT_FILE, text);
    return transport;
  };
  const REPORT_TEXT = `${JSON.stringify(REPORT, null, 2)}\n`;

  it('reads the report file of the node at the address', async () => {
    const result = await withReport(REPORT_TEXT).report(`file://${CHILD}`, reportLimits.maxBytes);
    expect(result).toMatchObject({ state: 'read', report: REPORT, source: REPORT_FILE });
  });

  it('gives an unknown value with a fixed reason for a node with no report file', async () => {
    const result = await withReport(null).report(`file://${CHILD}`, reportLimits.maxBytes);
    expect(result).toMatchObject({ state: 'unknown', reason: childReasons.noReport, source: REPORT_FILE });
  });

  it('gives an unknown value with a fixed reason for an address that is not valid', async () => {
    const result = await withReport(REPORT_TEXT).report('ssh://owner@host/srv/web-factory', reportLimits.maxBytes);
    expect(result).toMatchObject({ state: 'unknown', reason: childReasons.addressInvalid, source: null });
  });

  it('reads at most the bytes that the caller gives', async () => {
    const result = await withReport(REPORT_TEXT).report(`file://${CHILD}`, 10);
    expect(result).toMatchObject({ state: 'unknown', reason: childReasons.reportTooLarge, bytes: 0 });
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
