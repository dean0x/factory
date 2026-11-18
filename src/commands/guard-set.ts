import { sha256Hex } from '../blocks/managed.js';
import { failure, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import { displayLineCore, removedByDisplay, visibleTextCore, type CommandOutput } from '../cli/output.js';
import { setGuardText } from '../config/edit.js';
import { parseConfigTexts, readNodeIdentity } from '../config/load.js';
import type { FactoryConfig } from '../config/schema.js';
import { ACCEPT_ANSWER, type Deps } from '../core/deps.js';
import { readGuardState, recordGuards, recordPrefix, requireGuardChannel, type GuardRecordWrite } from '../core/guard-records.js';
import { locateHomeFolder } from '../core/home.js';
import { ok } from '../core/result.js';
import { guardsFor } from '../guards/registry.js';
import type { Guard, GuardValue } from '../guards/types.js';
import { commandLines, commands, files, flags, guardConfirmWords, guardRecordWords, guardSetWords, guardValues, harmMark, localFileModes, maxFileBytes, schemaIds } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { layoutOf } from '../state/layout.js';

export interface GuardSetOptions {
  readonly home: string | undefined;
  readonly words: readonly string[];
  readonly all: boolean;
  readonly json: boolean;
  readonly family: string | undefined;
}

export interface GuardConfirmOptions {
  readonly home: string | undefined;
  readonly words: readonly string[];
  readonly json: boolean;
  readonly all: boolean;
  readonly family: string | undefined;
}

interface ParsedSet {
  readonly id: string | null;
  readonly value: GuardValue;
}

interface GuardConfig {
  readonly home: string;
  readonly shared: string;
  readonly local: string;
  readonly config: FactoryConfig;
}

const parseGuardSet = (options: GuardSetOptions, registry: RecipeRegistry): CliResult<ParsedSet> => {
  if (options.json) return usageError(guardSetWords.noJson(commandLines.guardSet));
  if (options.family !== undefined) return usageError(guardSetWords.listOnly(flags.family));
  if (options.all && options.words.length > 1) return usageError(guardSetWords.idWithAll);
  if (options.words.length !== (options.all ? 1 : 2)) return usageError(guardSetWords.argumentsError);
  const id = options.all ? null : options.words[0] ?? '';
  if (id !== null) {
    const guard = registry.flatMap(guardsFor).find((item) => item.id === id);
    if (guard === undefined) return usageError(guardSetWords.unknownId(displayLineCore(id)));
    if (!guard.wired) return usageError(guardSetWords.notSettable(id));
  }
  const value = options.words.at(-1);
  return value === guardValues.on || value === guardValues.off ? ok({ id, value }) : usageError(guardSetWords.badValue);
};

/** Config reads use the always-on file core, just like the record store. */
const readGuardConfigText = async (deps: Deps, path: string): Promise<CliResult<string>> => {
  if (deps.fs.openCheckedCore === undefined) return failure(guardRecordWords.adapterRequired);
  const read = await deps.fs.openCheckedCore(path, { uid: deps.uid, maxBytes: maxFileBytes, decode: 'fatal' });
  if (!read.ok) return read;
  if (read.value.state === 'link' || read.value.state === 'refused') return safetyRefusal(guardSetWords.unsafeFile(path), guardSetWords.unsafeFileRemedy);
  return read.value.state === 'opened' && read.value.text !== null ? ok(read.value.text) : failure(guardSetWords.unreadableFile(path));
};

const loadGuardConfig = async (deps: Deps, homeFlag: string | undefined, registry: RecipeRegistry): Promise<CliResult<GuardConfig>> => {
  const located = await locateHomeFolder(deps, homeFlag, (readDeps, home) => readNodeIdentity(readDeps, home, registry), commands.guard);
  if (!located.ok) return located;
  const home = located.value.home;
  const layout = layoutOf(home);
  const shared = await readGuardConfigText(deps, layout.configFile);
  if (!shared.ok) return shared;
  const local = await readGuardConfigText(deps, layout.localConfigFile);
  if (!local.ok) return local;
  const config = parseConfigTexts(shared.value, local.value, registry);
  return config.ok ? ok({ home, shared: shared.value, local: local.value, config: config.value }) : config;
};

/** Compare both files again. No edit made at the question can be lost. */
const requireCurrentGuardConfig = async (deps: Deps, loaded: GuardConfig, registry: RecipeRegistry): Promise<CliResult<void>> => {
  const layout = layoutOf(loaded.home);
  const shared = await readGuardConfigText(deps, layout.configFile);
  if (!shared.ok) return shared;
  const local = await readGuardConfigText(deps, layout.localConfigFile);
  if (!local.ok) return local;
  if (local.value !== loaded.local) return failure(guardSetWords.changedFile(files.localConfig));
  if (shared.value !== loaded.shared) return failure(guardSetWords.changedFile(files.config));
  const config = parseConfigTexts(shared.value, local.value, registry);
  return config.ok ? ok(undefined) : config;
};

const writeGuardLocal = async (deps: Deps, loaded: GuardConfig, text: string, registry: RecipeRegistry): Promise<CliResult<void>> => {
  const current = await requireCurrentGuardConfig(deps, loaded, registry);
  if (!current.ok) return current;
  if (deps.fs.writeTextAtomicCore === undefined) return failure(guardRecordWords.adapterRequired);
  return deps.fs.writeTextAtomicCore(layoutOf(loaded.home).localConfigFile, text, loaded.home, localFileModes.private);
};

const guardWriteOutput = (schema: string, text: string, written: GuardRecordWrite): CommandOutput => ({
  lines: [{ level: 'text', text }],
  json: { schema },
  warnings: written.warning === null ? [] : [written.warning],
  failed: false,
});

const askGuardOff = async (deps: Deps, guards: readonly Guard[], excluded: number | null): Promise<CliResult<void>> => {
  const lines = [
    ...guards.map((guard) => `${guard.id}${guard.harm ? ` ${harmMark}` : ''}`),
    ...(excluded === null ? [] : [guardSetWords.skipped(excluded)]),
    guardSetWords.nextStart,
  ];
  const shown = await deps.writeStdout(`${lines.join('\n')}\n`);
  if (!shown.ok) return shown;
  const answer = await deps.prompt(guardSetWords.offQuestion);
  if (!answer.ok) return answer;
  return ACCEPT_ANSWER.test(answer.value.trim()) ? ok(undefined) : usageError(guardSetWords.declined);
};

/** Off writes the local value first. On writes its record first and still writes local on after a record failure. */
export const runGuardSet = async (deps: Deps, options: GuardSetOptions, registry: RecipeRegistry): Promise<CliResult<CommandOutput>> => {
  const parsed = parseGuardSet(options, registry);
  if (!parsed.ok) return parsed;
  const channel = requireGuardChannel(deps, commandLines.guardSet);
  if (!channel.ok) return channel;
  const loaded = await loadGuardConfig(deps, options.home, registry);
  if (!loaded.ok) return loaded;
  const { id, value } = parsed.value;
  const allGuards = guardsFor(loaded.value.config.entry);
  const guards = allGuards.filter((guard) => guard.wired && (id === null || guard.id === id));
  if (id !== null && guards.length === 0) return usageError(guardSetWords.unknownId(displayLineCore(id)));
  const excluded = id === null ? allGuards.length - guards.length : null;
  const edited = setGuardText(loaded.value.local, Object.fromEntries(guards.map((guard) => [guard.id, value])));
  if (!edited.ok) return failure(edited.error);
  const config = parseConfigTexts(loaded.value.shared, edited.value, registry);
  if (!config.ok) return config;
  if (value === guardValues.off) {
    const answer = await askGuardOff(deps, guards, excluded);
    if (!answer.ok) return answer;
    const local = await writeGuardLocal(deps, loaded.value, edited.value, registry);
    if (!local.ok) return local;
  } else {
    const current = await requireCurrentGuardConfig(deps, loaded.value, registry);
    if (!current.ok) return current;
  }
  const recorded = await recordGuards(deps, {
    root: loaded.value.home, node: loaded.value.config.core.node.id, change: guards.map((guard) => ({ guard, value })),
  });
  if (value === guardValues.on) {
    const local = await writeGuardLocal(deps, loaded.value, edited.value, registry);
    if (!local.ok) return recorded.ok ? local : failure(`${recorded.error.message}\n${local.error.message}`);
    if (!recorded.ok) return failure(`${recorded.error.message}\n${guardSetWords.recordFailedOn}`);
  }
  if (!recorded.ok) {
    // An older off record must not make a failed off change take effect.
    const onText = setGuardText(edited.value, Object.fromEntries(guards.map((guard) => [guard.id, guardValues.on])));
    if (!onText.ok) return failure(`${recorded.error.message}\n${onText.error}`);
    const restored = await writeGuardLocal(deps, { ...loaded.value, local: edited.value }, onText.value, registry);
    return failure(`${recorded.error.message}${restored.ok ? '' : `\n${restored.error.message}`}`);
  }
  const output = guardWriteOutput(schemaIds.guardSet, guardSetWords.set(guards.length, value), recorded.value);
  return ok({ ...output, lines: [
    ...output.lines,
    ...(value === guardValues.on ? [{ level: 'text' as const, text: guardSetWords.nextStart }] : []),
    ...(value === guardValues.on && excluded !== null ? [{ level: 'text' as const, text: guardSetWords.skipped(excluded) }] : []),
  ] });
};

/** Show the full exact prefix on stdout. The prompt port writes its question on stderr. */
export const runGuardConfirm = async (deps: Deps, options: GuardConfirmOptions, registry: RecipeRegistry): Promise<CliResult<CommandOutput>> => {
  if (options.json) return usageError(guardSetWords.noJson(commandLines.guardConfirm));
  if (options.family !== undefined) return usageError(guardSetWords.listOnly(flags.family));
  if (options.all || options.words.length !== 0) return usageError(guardConfirmWords.argumentsError);
  const channel = requireGuardChannel(deps, commandLines.guardConfirm);
  if (!channel.ok) return channel;
  const loaded = await loadGuardConfig(deps, options.home, registry);
  if (!loaded.ok) return loaded;
  const prefix = loaded.value.config.core.owner.prefix;
  const shown = await deps.writeStdout(`${guardConfirmWords.prefixLabel}\n${visibleTextCore(prefix)}\n`);
  if (!shown.ok) return shown;
  if (removedByDisplay(prefix)) return usageError(guardRecordWords.badPrefix);
  const state = await readGuardState(deps, loaded.value.home, loaded.value.config, 'always');
  if (state.fault !== null) return failure(state.fault);
  if (state.prefix !== null && state.prefix.hash !== sha256Hex(prefix)) {
    const differs = await deps.writeStdout(`${guardConfirmWords.differs}\n`);
    if (!differs.ok) return differs;
  }
  const answer = await deps.prompt(guardConfirmWords.question);
  if (!answer.ok) return answer;
  if (!ACCEPT_ANSWER.test(answer.value.trim())) return usageError(guardSetWords.declined);
  const current = await requireCurrentGuardConfig(deps, loaded.value, registry);
  if (!current.ok) return current;
  const recorded = await recordPrefix(deps, { root: loaded.value.home, node: loaded.value.config.core.node.id, prefix });
  return recorded.ok ? ok(guardWriteOutput(schemaIds.guardConfirm, guardConfirmWords.confirmed, recorded.value)) : recorded;
};
