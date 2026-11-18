import { describe, expect, it } from 'vitest';
import { renderBlock } from '../../src/blocks/managed.js';
import { exitCodeFor, failure, type CliResult } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ownSettingsEntries } from '../../src/core/claude-settings.js';
import { recordGuards, recordPrefix } from '../../src/core/guard-records.js';
import { ok } from '../../src/core/result.js';
import { allOn } from '../../src/guards/effective.js';
import { guardsFor } from '../../src/guards/registry.js';
import type { GuardValues } from '../../src/guards/types.js';
import { blockNames, files } from '../../src/names.js';
import { layoutOf, workerPathsOf } from '../../src/state/layout.js';
import { blockInputOf, blockTemplatesFor } from '../../src/templates/index.js';
import { writeLastSeen } from '../../src/workers/last-seen.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { noSetupTexts } from '../helpers/blocks.js';
import { createFakeDeps, exited, registerRoot, withFailingWrites, type FakeDeps } from '../helpers/fake-deps.js';
import { DEFAULT_GIT_VERSION, withoutStateWords } from '../helpers/git-fake.js';
import { runReboot, runRestart, runStart, runWorker } from '../helpers/package-registry.js';
import { countReadsOf } from '../helpers/read-count.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { tmuxHandler } from '../helpers/tmux-fake.js';
import { startsSessions, withProgram } from '../helpers/worker-program.js';

const HOME = '/w/node';
const STORE = `/state/factory/${files.guardRecords}`;
const SESSION = '0b9f3c1e-5d2a-4e7b-9c10-a1b2c3d4e5f6';
const COPY = `${HOME}/work-copies/web/alpha`;
const origins = ['own', 'received'] as const;
const launches = ['start', 'reboot', 'restart', 'worker new', 'worker resume'] as const;
type Launch = (typeof launches)[number];
const launch = (deps: FakeDeps, command: Launch, dryRun = false): Promise<CliResult<CommandOutput>> => {
  if (command === 'start') return runStart(deps, { home: HOME, dryRun, yes: true });
  if (command === 'reboot') return runReboot(deps, { home: HOME });
  if (command === 'restart') return runRestart(deps, { home: HOME, words: ['alpha'] });
  return runWorker(deps, {
    home: HOME, words: command === 'worker new' ? ['new', 'beta'] : ['resume', 'alpha'],
    project: 'web', yes: true, duration: undefined,
  });
};
const must = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const templates = (config: FactoryConfig, guards: GuardValues = allOn) =>
  blockTemplatesFor(blockInputOf(config, noSetupTexts, config.core.approval, guards));
const seedBlocks = (deps: FakeDeps, config: FactoryConfig, guards: GuardValues = allOn): void => {
  const blocks = templates(config, guards);
  for (const target of ['claudeFile', 'workerFile'] as const) {
    const path = target === 'claudeFile' ? layoutOf(HOME).claudeMd : layoutOf(HOME).workerMd;
    deps.seed(path, `${blocks.filter((block) => block.target === target).map((block) => must(renderBlock(block))).join('\n\n')}\n`);
  }
};
const make = async (origin: (typeof origins)[number], config = sampleConfig(), running = true) => {
  const { handler, log } = tmuxHandler({ sessions: running ? { demo: HOME } : {} });
  const base = createFakeDeps({
    cwd: '/w', env: { PATH: '/bin', XDG_STATE_HOME: '/state' }, stdinIsTTY: true, stdoutIsTTY: true,
    run: (call) => {
      if (call.command !== 'git') return handler(call);
      if (call.args[0] === '--version') return exited(0, DEFAULT_GIT_VERSION);
      const command = withoutStateWords(call.args).slice(2).join(' ');
      if (command === 'rev-parse --is-inside-work-tree --show-prefix') return exited(0, 'true\n\n');
      if (command === 'config user.name' || command === 'config user.email') return exited(0, 'Git User\n');
      if (command.startsWith('worktree add ')) base.seedDir(`${HOME}/work-copies/web/beta`);
      if (command.startsWith('rev-parse --verify --quiet refs/heads/')) return exited(1);
      if (command === 'rev-parse --git-common-dir') return exited(0, '.git\n');
      if (command === 'ls-files -z') return exited(0, '');
      return exited(0);
    },
  });
  const deps = withProgram(base, log, startsSessions(HOME, { [SESSION]: 'alpha' }));
  for (const tool of ['tmux', 'claude']) deps.seed(`/bin/${tool}`, '');
  seedConfig(deps, HOME, config);
  seedBlocks(deps, config);
  deps.seedDir(`${HOME}/.factory/.git`);
  deps.seedDir(`${HOME}/web/.git`);
  deps.seed(`${HOME}/coordinator/.claude/settings.local.json`, JSON.stringify(ownSettingsEntries));
  deps.seed(`${COPY}/.claude/settings.local.json`, JSON.stringify(ownSettingsEntries));
  registerRoot(deps, HOME, 'demo', [], origin);
  must(await writeWorkerRecord(deps, HOME, { id: 'alpha', project: 'web', workCopy: COPY, branch: 'worker/alpha' }));
  deps.seed(workerPathsOf(HOME, 'alpha').lastSessionFile, `${SESSION}\n`);
  must(await writeLastSeen(deps, HOME, SESSION, { kind: 'event', event: 'Stop' }, 'alpha'));
  deps.warned.splice(0);
  return { deps, tmux: log, config };
};
const recordValues = (deps: FakeDeps, config: FactoryConfig) => recordGuards(deps, {
  root: HOME, node: 'demo', change: guardsFor(config.entry).filter((guard) => config.core.guards[guard.id] !== undefined)
    .map((guard) => ({ guard, value: config.core.guards[guard.id] ?? 'on' })),
});
const confirm = async (deps: FakeDeps, config: FactoryConfig): Promise<void> => {
  must(await recordPrefix(deps, { root: HOME, node: 'demo', prefix: config.core.owner.prefix }));
};
const editRole = (deps: FakeDeps, config: FactoryConfig, removeGuard: boolean, target: string = blockNames.coordinator): void => {
  const path = target === blockNames.worker ? layoutOf(HOME).workerMd : layoutOf(HOME).claudeMd;
  const text = deps.files.get(path) ?? '';
  const block = templates(config).find((entry) => entry.name === target);
  if (block === undefined) throw new Error('role block is absent');
  const off = templates(config, { ...allOn, [target === blockNames.worker ? 'install-rules' : 'approval-merge']: 'off' }).find((entry) => entry.name === target);
  deps.seed(path, text.replace(block.body, `${removeGuard ? off?.body : block.body}\nCustom role text.\n`));
};
const expectRefusal = (result: CliResult<CommandOutput>, remedy: string): void => {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(exitCodeFor(result.error)).toBe(4);
  expect(`${result.error.message} ${result.error.hint}`).toContain(remedy);
};
const fileSnapshot = (deps: FakeDeps) => [deps.files.get(layoutOf(HOME).claudeMd), deps.files.get(layoutOf(HOME).workerMd)];
const paneStarts = (tmux: ReturnType<typeof tmuxHandler>['log']) =>
  tmux.calls.filter((call) => call.args[0] === 'new-session' || call.args[0] === 'split-window');

for (const origin of origins) {
  describe(`guard launch in the ${origin} folder`, () => {
    for (const command of launches) {
      it(`${command} refuses a changed prefix in the ${origin} folder before any block write or pane`, async () => {
        const { deps, tmux, config } = await make(origin);
        await confirm(deps, config);
        seedConfig(deps, HOME, { ...config, core: { ...config.core, owner: { ...config.core.owner, prefix: '[Changed {owner} {node} {date}]' } } });
        const before = fileSnapshot(deps);
        expectRefusal(await launch(deps, command), 'factory guard confirm');
        expect(fileSnapshot(deps)).toEqual(before);
        expect(paneStarts(tmux)).toEqual([]);
      });
      for (const fault of ['invalid', 'link', 'unreadable'] as const) {
        it(`${command} refuses an ${fault} guard store in the ${origin} folder`, async () => {
          const { deps, tmux, config } = await make(origin);
          await confirm(deps, config);
          if (fault === 'invalid') deps.seed(STORE, '{broken');
          const checked = { ...deps, fs: { ...deps.fs,
            lstatInfo: async (path: string) => path === STORE && fault === 'link'
              ? ok({ kind: 'link' as const, target: '/other/records' }) : deps.fs.lstatInfo(path),
            openCheckedCore: async (path: string, request: Parameters<typeof deps.fs.openChecked>[1]) => path === STORE && fault === 'unreadable'
              ? failure('cannot read guard store') : deps.fs.openChecked(path, request),
          } };
          const before = fileSnapshot(deps);
          expectRefusal(await launch(checked, command), 'factory doctor');
          expect(fileSnapshot(deps)).toEqual(before);
          expect(paneStarts(tmux)).toEqual([]);
        });
      }
      it(`${command} refuses a linked worker role file in the ${origin} folder without a read`, async () => {
        const { deps, tmux, config } = await make(origin);
        await confirm(deps, config);
        const counted = countReadsOf(deps, layoutOf(HOME).workerMd);
        const linked = { ...counted.deps, fs: { ...counted.deps.fs,
          lstat: async (path: string) => path === layoutOf(HOME).workerMd
            ? ok('link' as const) : counted.deps.fs.lstat(path),
        } };
        expectRefusal(await launch(linked, command), 'link');
        expect(counted.count()).toBe(0);
        expect(paneStarts(tmux)).toEqual([]);
      });
      for (const target of [blockNames.coordinator, blockNames.worker]) {
        it(`${command} refuses an edited ${target} without on guard text in the ${origin} folder`, async () => {
          const { deps, tmux, config } = await make(origin);
          await confirm(deps, config);
          editRole(deps, config, true, target);
          expectRefusal(await launch(deps, command), `--overwrite ${target}`);
          expect(paneStarts(tmux)).toEqual([]);
        });
      }
    }
    for (const command of ['start', 'reboot'] as const) {
      it(`${command} renders intact role blocks after a guard change in the ${origin} folder`, async () => {
        const base = sampleConfig();
        const config = { ...base, core: { ...base.core, guards: { 'install-rules': 'off' as const, 'resume-routines': 'off' as const, 'approval-merge': 'off' as const, 'approval-release': 'off' as const } } };
        const { deps } = await make(origin, config, false);
        must(await recordValues(deps, config));
        const counted = countReadsOf(deps, STORE);
        must(await launch(counted.deps, command));
        for (const template of templates(config, { ...allOn, ...config.core.guards })) {
          const path = template.target === 'claudeFile' ? layoutOf(HOME).claudeMd : layoutOf(HOME).workerMd;
          expect(deps.files.get(path)).toContain(template.body);
        }
        expect(deps.warned.filter((line) => line.includes('guard change'))).toHaveLength(1);
        expect(counted.count()).toBe(1);
      });
      it(`${command} exits 1 with no pane after a block write fails in the ${origin} folder`, async () => {
        const config = sampleConfig();
        const { deps, tmux } = await make(origin, config, false);
        await confirm(deps, config);
        const changed = { ...config, core: { ...config.core, guards: { 'install-rules': 'off' as const } } };
        seedConfig(deps, HOME, changed);
        must(await recordValues(deps, changed));
        const result = await launch(withFailingWrites(deps, (path) => path === layoutOf(HOME).workerMd), command);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(exitCodeFor(result.error)).toBe(1);
        expect(paneStarts(tmux)).toEqual([]);
      });
    }
    it(`start dry run refuses a changed prefix before a block read in the ${origin} folder`, async () => {
      const { deps, config } = await make(origin);
      await confirm(deps, config);
      seedConfig(deps, HOME, { ...config, core: { ...config.core, owner: { ...config.core.owner, prefix: '[Changed {owner} {node} {date}]' } } });
      const counted = countReadsOf(deps, layoutOf(HOME).claudeMd);
      expectRefusal(await launch(counted.deps, 'start', true), 'factory guard confirm');
      expect(counted.count()).toBe(0);
    });
    for (const command of launches) {
      it(`${command} keeps edited role text with each on guard in the ${origin} folder`, async () => {
        const { deps, config } = await make(origin);
        await confirm(deps, config);
        editRole(deps, config, false);
        const before = fileSnapshot(deps);
        must(await launch(deps, command));
        expect(fileSnapshot(deps)).toEqual(before);
        expect(deps.warned.filter((line) => line.includes(`--overwrite ${blockNames.coordinator}`))).toHaveLength(1);
      });
      for (const record of ['absent', 'no prefix'] as const) {
        it(`${command} launches with ${record} record in the ${origin} folder`, async () => {
          const { deps } = await make(origin);
          if (record === 'no prefix') must(await recordGuards(deps, { root: HOME, node: 'demo', change: [] }));
          const result = must(await launch(deps, command));
          expect(result.failed).toBe(false);
        });
      }
      it(`${command} refuses a malformed worker role file in the ${origin} folder`, async () => {
        const { deps, tmux, config } = await make(origin);
        await confirm(deps, config);
        deps.seed(layoutOf(HOME).workerMd, '<!-- factory:begin worker broken -->\n');
        expectRefusal(await launch(deps, command), `--overwrite ${blockNames.worker}`);
        expect(paneStarts(tmux)).toEqual([]);
      });
    }
    for (const command of ['restart', 'worker new', 'worker resume'] as const) {
      it(`${command} writes no role block and notes stale text in the ${origin} folder`, async () => {
        const { deps, config } = await make(origin);
        await confirm(deps, config);
        const changed = { ...config, core: { ...config.core, guards: { 'install-rules': 'off' as const } } };
        seedConfig(deps, HOME, changed);
        must(await recordValues(deps, changed));
        const before = fileSnapshot(deps);
        const counted = countReadsOf(deps, STORE);
        must(await launch(counted.deps, command));
        expect(fileSnapshot(deps)).toEqual(before);
        expect(deps.warned.filter((line) => line.includes('role blocks') && line.includes('out of date'))).toHaveLength(1);
        expect(counted.count()).toBe(1);
      });
    }
    it(`reboot inside the session writes no role block in the ${origin} folder`, async () => {
      const { deps, tmux, config } = await make(origin);
      const changed = { ...config, core: { ...config.core, guards: { 'install-rules': 'off' as const } } };
      seedConfig(deps, HOME, changed);
      must(await recordValues(deps, changed));
      const counted = countReadsOf(deps, STORE);
      const before = fileSnapshot(deps);
      const pane = tmux.panes().find((entry) => entry.session === 'demo');
      if (pane === undefined) throw new Error('coordinator pane is absent');
      must(await launch({ ...counted.deps, env: { ...counted.deps.env, TMUX_PANE: pane.id } }, 'reboot'));
      expect(fileSnapshot(deps)).toEqual(before);
      expect(deps.warned.filter((line) => line.includes('role blocks') && line.includes('out of date'))).toHaveLength(1);
      expect(counted.count()).toBe(1);
    });
    it(`start renders manager role blocks after a guard change in the ${origin} folder`, async () => {
      const base = sampleConfig();
      const config = { ...base, core: { ...base.core, node: { ...base.core.node, layer: 2 } } };
      const off = { ...allOn, 'approval-merge': 'off' as const, 'approval-release': 'off' as const, 'resume-routines': 'off' as const };
      const { deps } = await make(origin, config);
      seedBlocks(deps, config, off);
      await confirm(deps, config);
      must(await launch(deps, 'start'));
      for (const template of templates(config)) {
        const path = template.target === 'claudeFile' ? layoutOf(HOME).claudeMd : layoutOf(HOME).workerMd;
        expect(deps.files.get(path)).toContain(template.body);
      }
      expect(deps.warned.filter((line) => line.includes('guard change'))).toHaveLength(1);
    });
    it(`start reads no worker block without a node guard record in the ${origin} folder`, async () => {
      const { deps, config } = await make(origin);
      editRole(deps, config, true);
      const counted = countReadsOf(deps, layoutOf(HOME).workerMd);
      must(await launch(counted.deps, 'start'));
      expect(counted.count()).toBe(0);
    });
    for (const missing of ['block', 'file'] as const) {
      it(`start warns once for a missing role ${missing} in the ${origin} folder`, async () => {
        const { deps, config } = await make(origin);
        await confirm(deps, config);
        if (missing === 'file') deps.files.delete(layoutOf(HOME).workerMd);
        else deps.seed(layoutOf(HOME).workerMd, 'No block here.\n');
        must(await launch(deps, 'start'));
        expect(deps.warned.filter((line) => line.includes(blockNames.worker) && line.includes('missing'))).toHaveLength(1);
      });
    }
    it(`start leaves an older role block for upgrade in the ${origin} folder`, async () => {
      const { deps, config } = await make(origin);
      await confirm(deps, config);
      const template = templates(config).find((block) => block.name === blockNames.coordinator);
      if (template === undefined) throw new Error('role block is absent');
      const old = must(renderBlock({ ...template, version: template.version - 1, body: 'Older role text.\n' }));
      deps.seed(layoutOf(HOME).claudeMd, (deps.files.get(layoutOf(HOME).claudeMd) ?? '').replace(must(renderBlock(template)), old));
      const before = fileSnapshot(deps);
      must(await launch(deps, 'start'));
      expect(fileSnapshot(deps)).toEqual(before);
    });
    it(`start refuses an edited safety block with a record in the ${origin} folder`, async () => {
      const { deps, tmux, config } = await make(origin);
      await confirm(deps, config);
      const path = layoutOf(HOME).claudeMd;
      deps.seed(path, (deps.files.get(path) ?? '').replace('# Safety rules', '# Changed rules'));
      expectRefusal(await launch(deps, 'start'), '--overwrite safety');
      expect(paneStarts(tmux)).toEqual([]);
    });
    it(`start reads the guard store once with all guards on in the ${origin} folder`, async () => {
      const { deps, config } = await make(origin);
      await confirm(deps, config);
      const counted = countReadsOf(deps, STORE);
      must(await launch(counted.deps, 'start'));
      expect(counted.count()).toBe(1);
    });
    it(`start keeps unmatched local off values on in the ${origin} folder`, async () => {
      const config = sampleConfig();
      const { deps } = await make(origin, { ...config, core: { ...config.core, guards: { 'install-rules': 'off' } } });
      await confirm(deps, config);
      const before = fileSnapshot(deps);
      must(await launch(deps, 'start'));
      expect(fileSnapshot(deps)).toEqual(before);
    });
  });
}
