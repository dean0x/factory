import { describe, expect, it } from 'vitest';
import { renderBlock } from '../../src/blocks/managed.js';
import { exitCodeFor, failure, type CliResult } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runCli } from '../../src/cli/run.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ownSettingsEntries } from '../../src/core/claude-settings.js';
import { recordGuards, recordPrefix } from '../../src/core/guard-records.js';
import { ok } from '../../src/core/result.js';
import { allOn } from '../../src/guards/effective.js';
import { guardsFor } from '../../src/guards/registry.js';
import type { GuardValues } from '../../src/guards/types.js';
import { blockNames, env, files, guardDenyWords, guardIds, guardValues } from '../../src/names.js';
import { layoutOf, workerPathsOf } from '../../src/state/layout.js';
import { blockInputOf, blockTemplatesFor } from '../../src/templates/index.js';
import { writeLastSeen } from '../../src/workers/last-seen.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { noSetupTexts } from '../helpers/blocks.js';
import { createFakeDeps, exited, registerRoot, withFailingWrites, type FakeDeps } from '../helpers/fake-deps.js';
import { DEFAULT_GIT_VERSION, withoutStateWords } from '../helpers/git-fake.js';
import { guardStoreText } from '../helpers/guarded-node.js';
import { runReboot, runRestart, runStart, runWorker } from '../helpers/package-registry.js';
import { countReadsOf } from '../helpers/read-count.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { captureSink } from '../helpers/sink.js';
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
const recordValues = (deps: FakeDeps, config: FactoryConfig, root = HOME) => recordGuards(deps, {
  root, node: 'demo', change: guardsFor(config.entry).filter((guard) => config.core.guards[guard.id] !== undefined)
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
/** The three states of one guard: on, off with the matching owner record, and off with no record. Only the second turns it off. */
const guardStates = ['on', 'off with a matching record', 'off with no record'] as const;
/** A node in one state of the guard `id`. */
const makeIn = async (origin: (typeof origins)[number], id: string, state: (typeof guardStates)[number], running = true) => {
  const base = sampleConfig();
  const config = state === 'on' ? base : { ...base, core: { ...base.core, guards: { [id]: guardValues.off } } };
  const made = await make(origin, config, running);
  if (state === 'off with a matching record') made.deps.seed(STORE, guardStoreText('demo', HOME, [id], made.deps.now()));
  return { ...made, on: state !== 'off with a matching record' };
};
/** The result of a launch that a guard that counts as on refuses, and that goes on while the guard is off. */
const expectOnlyOnRefusal = (result: CliResult<CommandOutput>, on: boolean, remedy: string): void => {
  if (on) expectRefusal(result, remedy);
  else expect(must(result).failed).toBe(false);
};
/** Put a safety block of the next version in the coordinator file, with a hash that matches its text or, when edited, not. */
const seedNewerSafety = (deps: FakeDeps, config: FactoryConfig, edited: boolean): number => {
  const template = templates(config).find((block) => block.name === blockNames.safety);
  if (template === undefined) throw new Error('safety block is absent');
  const newer = must(renderBlock({ ...template, version: template.version + 1, body: 'Newer safety text.\n' }));
  const path = layoutOf(HOME).claudeMd;
  deps.seed(path, (deps.files.get(path) ?? '').replace(must(renderBlock(template)), edited ? newer.replace('Newer safety', 'Edited safety') : newer));
  return template.version + 1;
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
      it(`${command} names the state-folder step for a store place fault in the ${origin} folder`, async () => {
        const { deps, tmux } = await make(origin);
        const changed = { ...deps, env: { ...deps.env, [env.stateHome]: HOME } };
        registerRoot(changed, HOME, 'demo', [], origin);
        const before = fileSnapshot(deps);
        expectRefusal(await launch(changed, command), 'Set XDG_STATE_HOME to another absolute folder');
        expect(fileSnapshot(deps)).toEqual(before);
        expect(paneStarts(tmux)).toEqual([]);
      });
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
      for (const target of [blockNames.coordinator, blockNames.workRules, blockNames.worker]) {
        it(`${command} refuses a missing ${target} with an on guard in the ${origin} folder`, async () => {
          const { deps, tmux, config } = await make(origin);
          await confirm(deps, config);
          const template = templates(config).find((entry) => entry.name === target);
          if (template === undefined) throw new Error('role block is absent');
          const path = template.target === 'claudeFile' ? layoutOf(HOME).claudeMd : layoutOf(HOME).workerMd;
          deps.seed(path, (deps.files.get(path) ?? '').replace(must(renderBlock(template)), ''));
          const before = fileSnapshot(deps);
          expectRefusal(await launch(deps, command), `--overwrite ${target}`);
          expect(fileSnapshot(deps)).toEqual(before);
          expect(paneStarts(tmux)).toEqual([]);
        });
      }
      it(`${command} refuses a missing worker role file with an on guard in the ${origin} folder`, async () => {
        const { deps, tmux, config } = await make(origin);
        await confirm(deps, config);
        deps.files.delete(layoutOf(HOME).workerMd);
        const before = fileSnapshot(deps);
        expectRefusal(await launch(deps, command), `--overwrite ${blockNames.worker}`);
        expect(fileSnapshot(deps)).toEqual(before);
        expect(paneStarts(tmux)).toEqual([]);
      });
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
    for (const record of ['absent', 'lost', 'previous folder'] as const) {
      for (const dryRun of [false, true]) {
        it(`start${dryRun ? ' dry run' : ''} refuses off role text when the record is ${record} in the ${origin} folder`, async () => {
          const base = sampleConfig();
          const config = { ...base, core: { ...base.core, guards: { 'install-rules': 'off' as const, 'resume-routines': 'off' as const, 'approval-merge': 'off' as const, 'approval-release': 'off' as const } } };
          const { deps, tmux } = await make(origin, config, false);
          const off = { ...allOn, ...config.core.guards };
          seedBlocks(deps, config, off);
          if (record === 'lost') {
            must(await recordValues(deps, config));
            deps.files.delete(STORE);
          } else if (record === 'previous folder') {
            must(await deps.fs.rename(HOME, '/w/previous-node'));
            must(await recordValues(deps, config, '/w/previous-node'));
            must(await deps.fs.rename('/w/previous-node', HOME));
          }
          const before = fileSnapshot(deps);
          expectRefusal(await launch(deps, 'start', dryRun), `--overwrite ${blockNames.coordinator}`);
          expect(fileSnapshot(deps)).toEqual(before);
          expect(paneStarts(tmux)).toEqual([]);
        });
      }
    }
    for (const command of launches) {
      for (const target of [blockNames.coordinator, blockNames.worker]) {
        it(`${command} accepts edited ${target} text with no off text or record in the ${origin} folder`, async () => {
          const { deps, tmux, config } = await make(origin, sampleConfig(), command !== 'start');
          const template = templates(config).find((block) => block.name === target);
          if (template === undefined) throw new Error('role block is absent');
          const path = template.target === 'claudeFile' ? layoutOf(HOME).claudeMd : layoutOf(HOME).workerMd;
          deps.seed(path, (deps.files.get(path) ?? '').replace(template.body, 'Custom role text.\n'));
          const before = fileSnapshot(deps);
          const result = await launch(deps, command);
          expect(result.ok ? 0 : exitCodeFor(result.error)).toBe(0);
          expect(must(result).failed).toBe(false);
          expect(fileSnapshot(deps)).toEqual(before);
          expect(paneStarts(tmux).length).toBeGreaterThan(0);
        });
      }
      for (const guard of ['approval-merge', 'approval-release']) {
        for (const state of ['intact', 'edited', 'mixed'] as const) {
          it(`${command} refuses ${state} ${guard} off text without a record in the ${origin} folder`, async () => {
            const { deps, tmux, config } = await make(origin);
            const template = templates(config).find((block) => block.name === blockNames.coordinator);
            const off = templates(config, { ...allOn, [guard]: 'off' }).find((block) => block.name === blockNames.coordinator);
            if (template === undefined || off === undefined) throw new Error('role block is absent');
            const body = state === 'mixed' ? `${template.body}\n${off.body}` : off.body;
            const replacement = state === 'intact' ? must(renderBlock(off)) : must(renderBlock(template)).replace(template.body, `${body}\nCustom role text.\n`);
            const path = layoutOf(HOME).claudeMd;
            deps.seed(path, (deps.files.get(path) ?? '').replace(must(renderBlock(template)), replacement));
            const before = fileSnapshot(deps);
            expectRefusal(await launch(deps, command), `--overwrite ${blockNames.coordinator}`);
            expect(fileSnapshot(deps)).toEqual(before);
            expect(paneStarts(tmux)).toEqual([]);
          });
        }
      }
      for (const target of [blockNames.coordinator, blockNames.workRules, blockNames.worker]) {
        it(`${command} accepts a removed ${target} block with no record in the ${origin} folder`, async () => {
          const { deps, tmux, config } = await make(origin, sampleConfig(), command !== 'start');
          const template = templates(config).find((block) => block.name === target);
          if (template === undefined) throw new Error('role block is absent');
          const path = template.target === 'claudeFile' ? layoutOf(HOME).claudeMd : layoutOf(HOME).workerMd;
          deps.seed(path, (deps.files.get(path) ?? '').replace(must(renderBlock(template)), ''));
          const before = fileSnapshot(deps);
          const result = await launch(deps, command);
          expect(result.ok ? 0 : exitCodeFor(result.error)).toBe(0);
          expect(must(result).failed).toBe(false);
          expect(fileSnapshot(deps)).toEqual(before);
          expect(deps.warned.some((line) => line.includes(`--overwrite ${target}`))).toBe(true);
          expect(paneStarts(tmux).length).toBeGreaterThan(0);
        });
      }
    }
    it(`start warns once for a missing role block without on guard text in the ${origin} folder`, async () => {
      const base = sampleConfig();
      const guards = Object.fromEntries([
        guardIds.installRules, guardIds.fileLinkSafety, guardIds.setupText, guardIds.boardEdits, guardIds.workConduct, guardIds.ownerGo,
      ].map((id) => [id, guardValues.off] as const));
      const config = { ...base, core: { ...base.core, guards } };
      const { deps } = await make(origin, config);
      must(await recordValues(deps, config));
      const template = templates(config).find((block) => block.name === blockNames.workRules);
      if (template === undefined) throw new Error('role block is absent');
      const path = layoutOf(HOME).claudeMd;
      deps.seed(path, (deps.files.get(path) ?? '').replace(must(renderBlock(template)), ''));
      must(await launch(deps, 'start'));
      expect(deps.warned.filter((line) => line.includes(blockNames.workRules) && line.includes('missing'))).toHaveLength(1);
      expect(deps.files.get(path)).not.toContain('<!-- factory:begin work-rules');
    });
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
    it(`worker resume refuses a record whose work copy is not the folder of its worker in the ${origin} folder`, async () => {
      const { deps, tmux } = await make(origin);
      const other = `${HOME}/work-copies/web/gamma`;
      deps.seed(`${other}/.claude/settings.local.json`, JSON.stringify(ownSettingsEntries));
      deps.files.delete(workerPathsOf(HOME, 'alpha').recordFile);
      must(await writeWorkerRecord(deps, HOME, { id: 'alpha', project: 'web', workCopy: other, branch: 'worker/alpha' }));
      expectRefusal(await launch(deps, 'worker resume'), 'is not the record that factory wrote');
      expect(paneStarts(tmux)).toEqual([]);
    });
    for (const state of guardStates) {
      for (const command of ['start', 'worker resume'] as const) {
        it(`${command} refuses an edited safety block only while the safety block guard counts as on, in the ${origin} folder: ${state}`, async () => {
          const { deps, tmux, on } = await makeIn(origin, guardIds.safetyBlock, state, command !== 'start');
          const path = layoutOf(HOME).claudeMd;
          deps.seed(path, (deps.files.get(path) ?? '').replace('# Safety rules', '# Changed rules'));
          const before = fileSnapshot(deps);
          expectOnlyOnRefusal(await launch(deps, command), on, '--overwrite safety');
          expect(fileSnapshot(deps)[0]).toEqual(before[0]);
          expect(paneStarts(tmux).length > 0).toBe(!on);
        });
      }
      it(`worker resume refuses a changed prefix only while the safety block guard counts as on, in the ${origin} folder: ${state}`, async () => {
        const { deps, tmux, config, on } = await makeIn(origin, guardIds.safetyBlock, state);
        await confirm(deps, config);
        seedConfig(deps, HOME, { ...config, core: { ...config.core, owner: { ...config.core.owner, prefix: '[Changed {owner} {node} {date}]' } } });
        expectOnlyOnRefusal(await launch(deps, 'worker resume'), on, 'factory guard confirm');
        expect(paneStarts(tmux).length > 0).toBe(!on);
      });
      it(`worker resume refuses an edited coordinator block that lacks on guard text only while the safety block guard counts as on, in the ${origin} folder: ${state}`, async () => {
        const { deps, tmux, config, on } = await makeIn(origin, guardIds.safetyBlock, state);
        await confirm(deps, config);
        editRole(deps, config, true);
        const before = fileSnapshot(deps);
        expectOnlyOnRefusal(await launch(deps, 'worker resume'), on, `--overwrite ${blockNames.coordinator}`);
        expect(fileSnapshot(deps)).toEqual(before);
        expect(paneStarts(tmux).length > 0).toBe(!on);
      });
      for (const edited of [false, true]) {
        for (const command of ['start', 'worker resume'] as const) {
          it(`${command} refuses a${edited ? 'n edited' : 'n intact'} safety block of a newer version with every safety block guard value and keeps its bytes, in the ${origin} folder: ${state}`, async () => {
            const { deps, tmux, config } = await makeIn(origin, guardIds.safetyBlock, state, command !== 'start');
            const version = seedNewerSafety(deps, config, edited);
            const before = fileSnapshot(deps);
            const result = await launch(deps, command);
            expect(result.ok ? 0 : exitCodeFor(result.error), result.ok ? '' : result.error.message).toBe(1);
            if (!result.ok) expect(result.error.message).toContain(`has version ${version}`);
            expect(fileSnapshot(deps)).toEqual(before);
            expect(paneStarts(tmux)).toEqual([]);
          });
        }
      }
    }
    for (const state of guardStates) {
      it(`worker resume refuses a work copy with no hook settings file with every setup text guard value, in the ${origin} folder: ${state}`, async () => {
        const { deps, tmux } = await makeIn(origin, guardIds.setupText, state);
        deps.files.delete(`${COPY}/.claude/settings.local.json`);
        const result = await launch(deps, 'worker resume');
        expect(result.ok ? 0 : exitCodeFor(result.error), result.ok ? '' : result.error.message).toBe(3);
        expect(paneStarts(tmux)).toEqual([]);
      });
      it(`worker resume refuses a work copy whose settings lack the role hooks only while the setup text guard counts as on, in the ${origin} folder: ${state}`, async () => {
        const { deps, tmux, on } = await makeIn(origin, guardIds.setupText, state);
        const hooks = Object.fromEntries(Object.entries(ownSettingsEntries.hooks).filter(([event]) => event !== 'SessionStart'));
        deps.seed(`${COPY}/.claude/settings.local.json`, JSON.stringify({ ...ownSettingsEntries, hooks }));
        const result = await launch(deps, 'worker resume');
        expect(result.ok ? 0 : exitCodeFor(result.error), result.ok ? '' : result.error.message).toBe(on ? 3 : 0);
        expect(paneStarts(tmux).length > 0).toBe(!on);
        if (!on) expect(deps.warned).toContain(`${guardDenyWords.missing} ${guardDenyWords.remedy}`);
      });
    }
    for (const [id, rule] of [
      ['merge-quality', 'Merge only at the full head SHA'],
      [guardIds.workConduct, 'Decide from the decision profile.'],
    ] as const) {
      it.each(guardStates)(`start keeps the ${id} rule unless the owner record turns it off in the ${origin} folder: %s`, async (state) => {
        const { deps, on, config } = await makeIn(origin, id, state, false);
        if (!on) await confirm(deps, config);
        const sink = captureSink();
        expect(await runCli(['start', '--home', HOME, '--yes'], deps, sink), sink.errors.join('')).toBe(0);
        const role = deps.files.get(layoutOf(HOME).claudeMd);
        expect(role).toContain('## Role');
        expect(role?.includes(rule)).toBe(on);
      });
    }
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
