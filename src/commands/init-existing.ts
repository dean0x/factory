import { failure, safetyRefusal, usageError, type CliError, type CliResult } from '../cli/errors.js';
import type { CommandOutput, OutLine } from '../cli/output.js';
import { setApprovalText } from '../config/edit.js';
import { inspectSharedConfig, loadConfig, parseConfigTexts, readNodeIdentity, settleLocalMode } from '../config/load.js';
import type { FactoryConfig } from '../config/schema.js';
import { ACCEPT_ANSWER, type Deps } from '../core/deps.js';
import { inFactorySession } from '../core/factory-session.js';
import { commitPaths, hasIdentity, requireStateRepoReady, requireWorkTreeTop, statusOf, unstagePaths } from '../core/git.js';
import { entryProblemOf, markerProblemOf, reasonOf, rootRefusalOf } from '../core/home.js';
import { recordNode } from '../core/home-index.js';
import { effectiveModes } from '../core/owner-record.js';
import { err, ok } from '../core/result.js';
import {
  commands,
  commandText,
  dirs,
  files,
  flags,
  flagText,
  localFileModes,
  maxFileBytes,
  places,
  program,
  roles,
  schemaIds,
  values,
} from '../names.js';
import { ownerModes, recipes, type ApprovalModes, type ApprovalPoint } from '../recipes/index.js';
import { stagingDirOf, stateRel, type Layout } from '../state/layout.js';
import { STATE_LABEL } from '../state/load.js';
import { blockInputOf, blockTemplatesFor } from '../templates/index.js';
import type { SetupTexts } from '../templates/types.js';
import { recordAcceptance, stateFilesOf, workerTextOf, type InitOptions, type PlannedAcceptance, type StateFile } from './init.js';
import {
  approvalLines,
  approvalsFromFlags,
  askApprovals,
  initInTerminalWindow,
  recordApprovals,
  type ApprovalChoice,
} from './init-approval.js';
import { checkHomeOutsideRoots, leftoverTempFolders, nodeExists, tempFolderWarning } from './init-home.js';
import {
  acceptanceLines,
  checkReceivedRoot,
  collectSetup,
  declinedLines,
  decideAcceptance,
  plannedAcceptance,
  renderedTexts,
  sameIdWarnings,
  valueFlagsOf,
  withFirstQuestion,
  type AcceptanceDecision,
  type CollectedSetup,
  type ReceivedRoot,
} from './init-received.js';
import { makeStateFolder } from './init-state.js';

/**
 * `init` in a folder that holds both config files: a factory that `init` made or registered before, or a factory whose
 * folder moved. The files of the folder hold every value, so the value flags are usage errors. The checks of the tracked
 * paths and of the ignore rules are the checks of a received factory, and they come before the first question.
 *
 * The registration has three states. `registered`: the factory list has the entry with the same node id; the owner may set
 * the approval points again. `moved`: the list has no entry; `other-id`: the entry has another node id. Both ask the owner
 * to register the folder, and write the origin `received` (D-16). The state folder has three states too: it is right, its
 * marker is missing or broken (the marker is written again and committed), or the folder is absent (it is made as a
 * received factory makes it). The two states are independent.
 */

const MARKER_COMMIT_MESSAGE = `chore: restore the ${places.marker}`;
const [OWNER_MODE, DELEGATED_MODE] = values.approvalModes;

type Registration = 'registered' | 'moved' | 'other-id';

interface Standing {
  readonly registration: Registration;
  /** Why the factory list does not count the folder, or null for a registered folder. */
  readonly reason: string | null;
}

/** How the state folder stands: nothing to do, a marker to write again, or a folder to make. */
type Repair =
  | { readonly kind: 'none' }
  /** The text of the broken marker, or null when the marker is missing. */
  | { readonly kind: 'marker'; readonly previous: string | null }
  | { readonly kind: 'folder' };

interface Checked {
  readonly root: ReceivedRoot;
  readonly config: FactoryConfig;
  readonly standing: Standing;
  readonly repair: Repair;
  readonly points: readonly ApprovalPoint[];
  readonly warnings: readonly string[];
}

const standingOf = async (deps: Deps, home: string): Promise<CliResult<Standing>> => {
  const problem = await entryProblemOf(deps, home, readNodeIdentity);
  if (!problem.ok) return problem;
  const found = problem.value;
  if (found === null) return ok({ registration: 'registered', reason: null });
  switch (found.kind) {
    case 'no-entry':
      return ok({ registration: 'moved', reason: reasonOf(home, found) });
    case 'other-id':
      return ok({ registration: 'other-id', reason: reasonOf(home, found) });
    default:
      return rootRefusalOf(home, found);
  }
};

/** The marker path is a file or it is absent, and the marker is not from a newer version. */
const repairOf = async (deps: Deps, layout: Layout): Promise<CliResult<Repair>> => {
  const state = await deps.fs.lstat(layout.stateDir);
  if (!state.ok) return state;
  if (state.value === null) return ok({ kind: 'folder' });
  const marker = await deps.fs.lstat(layout.nodeJson);
  if (!marker.ok) return marker;
  if (marker.value !== null && marker.value !== 'file') {
    return safetyRefusal(
      `${layout.nodeJson} is not a plain file, so ${program} does not write it`,
      `Move ${layout.nodeJson} away, then run "${commandText(commands.init)}" again.`,
    );
  }
  const problem = await markerProblemOf(deps, layout.home);
  if (!problem.ok) return problem;
  if (problem.value === null) return ok({ kind: 'none' });
  if (problem.value.kind !== 'marker') return rootRefusalOf(layout.home, problem.value);

  // The marker is written in the state repo, so the repo must be a work tree of its own, and its index must be clean.
  const top = await requireWorkTreeTop(deps, layout.stateDir, dirs.state);
  if (!top.ok) return top;
  const ready = await requireStateRepoReady(deps, layout.stateDir, [], commandText(commands.init), `Then run "${commandText(commands.init)}" again.`);
  if (!ready.ok) return ready;
  if (marker.value === null) return ok({ kind: 'marker', previous: null });
  const previous = await deps.fs.readTextLimited(layout.nodeJson, maxFileBytes);
  return previous.ok ? ok({ kind: 'marker', previous: previous.value }) : previous;
};

/** Every check that needs no answer and writes nothing. */
const checkExisting = async (
  deps: Deps,
  options: InitOptions,
  indexPath: string,
  home: string,
): Promise<CliResult<Checked>> => {
  if (inFactorySession(deps)) {
    return safetyRefusal(
      `"${commandText(commands.init)}" does not register or change a ${places.folder} in a ${places.session}`,
      initInTerminalWindow(),
    );
  }
  // A shared file that is not valid is the case of a node that exists: `doctor` names the problem.
  const shared = await inspectSharedConfig(deps, home);
  if (shared.kind !== 'valid') return nodeExists(home);

  const root = await checkReceivedRoot(deps, home, { keepState: true });
  if (!root.ok) return root;
  const config = await loadConfig(deps, home);
  if (!config.ok) return config;
  const given = [
    ...valueFlagsOf(options),
    ...(options.ownerName === undefined ? [] : [flagText(flags.ownerName)]),
    ...(options.ownerGithub === undefined ? [] : [flagText(flags.ownerGithub)]),
  ];
  if (given.length > 0) {
    return usageError(
      `${given.join(', ')}: the files of the ${places.folder} ${home} hold these values`,
      `Run the command again without ${given.length === 1 ? 'this flag' : 'these flags'}.`,
    );
  }
  const outside = await checkHomeOutsideRoots(deps, indexPath, home);
  if (!outside.ok) return outside;
  const leftover = await leftoverTempFolders(deps, home);
  if (!leftover.ok) return leftover;
  const standing = await standingOf(deps, home);
  if (!standing.ok) return standing;
  const repair = await repairOf(deps, root.value.layout);
  if (!repair.ok) return repair;

  return ok({
    root: root.value,
    config: config.value,
    standing: standing.value,
    repair: repair.value,
    points: recipes[config.value.recipe.id].approvalPoints,
    warnings: [
      ...root.value.warnings,
      ...(await sameIdWarnings(deps, indexPath, home, config.value.core.node.id)),
      ...leftover.value.map(tempFolderWarning),
    ],
  });
};

/** The lines that the owner reads before the question to register the folder. */
const listingOf = (home: string, id: string, standing: Standing): readonly string[] => [
  `Folder: ${home}`,
  `${roles.node} id: ${id}`,
  `Reason: ${standing.reason ?? ''}`,
];

/** The owner agrees to register a folder that the factory list does not count. The yes flag agrees without a question. */
const askRegistration = async (asking: Deps, options: InitOptions, home: string): Promise<CliResult<void>> => {
  if (options.yes) return ok(undefined);
  if (!(asking.stdinIsTTY && asking.stdoutIsTTY)) {
    return usageError(
      `the ${places.folder} ${home} is not in the ${places.list}, and no terminal window can ask to register it`,
      `Run "${commandText(commands.init)}" in a terminal window, or pass ${flagText(flags.yes)}.`,
    );
  }
  const answer = await asking.prompt(`Register this ${places.folder} in the ${places.list}? [y/N] `);
  if (!answer.ok) return answer;
  return ACCEPT_ANSWER.test(answer.value.trim())
    ? ok(undefined)
    : usageError(`the ${places.folder} ${home} was not registered`, 'Nothing was changed.');
};

/**
 * The approval points of a registered folder. A flag sets one point. In a terminal window, the owner is asked for each
 * other point, and the current mode is the default answer. A moved folder or a folder with another node id sets no point:
 * its delegations end, so a flag is a usage error there.
 */
const approvalsOf = async (
  deps: Deps,
  options: InitOptions,
  checked: Checked,
): Promise<CliResult<ApprovalChoice>> => {
  const { config, points, standing } = checked;
  const current = { modes: config.core.approval, set: [] };
  if (standing.registration !== 'registered') {
    return options.approval.length === 0
      ? ok(current)
      : usageError(
          `${flagText(flags.approval)}: the points are set in a second run, after the ${places.folder} is registered`,
          `Run "${commandText(commands.init)}" again without ${flagText(flags.approval)}, then once more with it.`,
        );
  }
  const flagged = approvalsFromFlags(deps, options.yes, points, options.approval, config.core.approval);
  return flagged.ok ? askApprovals(deps, options.yes, points, flagged.value) : flagged;
};

/** The warning for a folder that is new to the list: each delegation of the local file ends. */
const delegationWarnings = (checked: Checked): readonly string[] => {
  const asked = checked.points.filter((point) => checked.config.core.approval[point.id] === DELEGATED_MODE);
  return checked.standing.registration === 'registered' || asked.length === 0
    ? []
    : [
        `A record of a delegation names the real path of the ${places.folder} and the ${roles.node} id, so each delegation ends. ` +
          `The local file asks for ${DELEGATED_MODE} at: ${asked.map((point) => point.id).join(', ')}. ` +
          `Each of these points counts as ${OWNER_MODE} now. ` +
          `To set a point again, run "${commandText(commands.init)}" in a terminal window outside a ${places.session}.`,
      ];
};

const sameModes = (points: readonly ApprovalPoint[], left: ApprovalModes, right: ApprovalModes): boolean =>
  points.every((point) => left[point.id] === right[point.id]);

/** The new text of the local file, and the text that it replaces. */
interface LocalChange {
  readonly text: string;
  readonly previous: string;
}

/** The local file with the new modes, or null when no mode changes. The new files are checked as one config. */
const localChangeOf = async (
  deps: Deps,
  checked: Checked,
  modes: ApprovalModes,
): Promise<CliResult<LocalChange | null>> => {
  const { config, points, root } = checked;
  if (sameModes(points, config.core.approval, modes)) return ok(null);
  const shared = await deps.fs.readTextLimited(root.layout.configFile, maxFileBytes);
  if (!shared.ok) return shared;
  const local = await deps.fs.readTextLimited(root.layout.localConfigFile, maxFileBytes);
  if (!local.ok) return local;
  const edited = setApprovalText(local.value, modes);
  if (!edited.ok) return failure(`${files.localConfig}: ${edited.error}`);
  const parsed = parseConfigTexts(shared.value, edited.value);
  return parsed.ok ? ok({ text: edited.value, previous: local.value }) : parsed;
};

/** The text of the marker, from the same templates that make a new state folder. */
const stateFilesFor = (config: FactoryConfig, rendered: SetupTexts, points: readonly ApprovalPoint[]): CliResult<readonly StateFile[]> => {
  const templates = blockTemplatesFor(blockInputOf(config, rendered, ownerModes(points)));
  const worker = workerTextOf(templates);
  return worker.ok ? stateFilesOf(templates, worker.value) : worker;
};

const markerTextOf = (stateFiles: readonly StateFile[]): CliResult<string> => {
  const marker = stateFiles.find((file) => file.rel === stateRel.nodeJson);
  return marker === undefined ? failure(`the ${roles.node} state holds no marker`) : ok(marker.text);
};

/** What the run writes. Nothing is written before the plan is complete. */
interface Plan {
  readonly local: LocalChange | null;
  readonly stateFiles: readonly StateFile[];
  readonly marker: string | null;
  readonly approvals: ApprovalChoice;
  readonly acceptance: PlannedAcceptance | null;
}

const planOf = async (
  deps: Deps,
  checked: Checked,
  approvals: ApprovalChoice,
  decision: AcceptanceDecision,
  setup: CollectedSetup,
): Promise<CliResult<Plan>> => {
  const { config, points, repair, root } = checked;
  const local = checked.standing.registration === 'registered' ? await localChangeOf(deps, checked, approvals.modes) : ok(null);
  if (!local.ok) return local;
  let stateFiles: readonly StateFile[] = [];
  let marker: string | null = null;
  if (repair.kind !== 'none') {
    const made = stateFilesFor(config, renderedTexts(decision, setup), points);
    if (!made.ok) return made;
    stateFiles = made.value;
    if (repair.kind === 'marker') {
      const text = markerTextOf(made.value);
      if (!text.ok) return text;
      marker = text.value;
    }
  }
  return ok({
    local: local.value,
    stateFiles,
    marker,
    approvals,
    acceptance: plannedAcceptance(decision, { home: root.layout.home, node: config.core.node.id, setup }),
  });
};

interface Applied {
  readonly committed: boolean;
  readonly warnings: readonly string[];
  readonly accepted: boolean;
  readonly approval: ApprovalModes;
}

/**
 * Commit the marker that was written again. A marker with the text that git holds has no change, so nothing is committed.
 * A commit that fails is a warning: the marker is in place.
 */
const commitMarker = async (deps: Deps, layout: Layout): Promise<{ readonly committed: boolean; readonly warnings: readonly string[] }> => {
  const notCommitted = (reason: string): { readonly committed: false; readonly warnings: readonly string[] } => ({
    committed: false,
    warnings: [`${STATE_LABEL} was written and not committed (${reason}). Commit it in ${dirs.state}.`],
  });
  const status = await statusOf(deps, layout.stateDir);
  if (!status.ok) return notCommitted(status.error.message);
  if (!status.value.some((entry) => entry.path === stateRel.nodeJson)) return { committed: false, warnings: [] };
  if (!(await hasIdentity(deps, layout.stateDir))) {
    return {
      committed: false,
      warnings: [`No git identity: ${STATE_LABEL} was not committed. Set user.name and user.email, then commit there.`],
    };
  }
  const paths = { present: [stateRel.nodeJson], gone: [] };
  const committed = await commitPaths(deps, layout.stateDir, paths, MARKER_COMMIT_MESSAGE);
  if (committed.ok) return { committed: true, warnings: [] };
  await unstagePaths(deps, layout.stateDir, paths);
  return notCommitted(committed.error.message);
};

/**
 * Write the plan: the local file, the state folder or the marker, then the entry in the factory list. A step that fails
 * undoes the steps before it. The marker commit, the approval records and the setup acceptance come after the entry in the
 * factory list, so a run that fails leaves none of them. A commit, a record or an acceptance that fails is a warning.
 */
const applyExisting = async (
  deps: Deps,
  checked: Checked,
  plan: Plan,
  indexPath: string,
): Promise<CliResult<Applied>> => {
  const { config, points, repair, root, standing } = checked;
  const { layout } = root;
  const id = config.core.node.id;
  const undo: (() => Promise<CliResult<void>>)[] = [];
  const rollback = async (cause: CliError): Promise<CliResult<never>> => {
    const problems: string[] = [];
    for (const step of [...undo].reverse()) {
      const result = await step();
      if (!result.ok) problems.push(result.error.message);
    }
    return err({
      ...cause,
      message:
        problems.length === 0
          ? `${cause.message} (nothing was changed)`
          : `${cause.message}. These steps of the undo failed, so some changes stay: ${problems.join('; ')}.`,
    });
  };

  const modeNotes = await settleLocalMode(deps, layout.home, true);
  if (!modeNotes.ok) return modeNotes;

  if (plan.local !== null) {
    const { text, previous } = plan.local;
    const written = await deps.fs.writeTextAtomic(layout.localConfigFile, text, layout.home, localFileModes.private);
    if (!written.ok) return rollback(written.error);
    undo.push(() => deps.fs.writeTextAtomic(layout.localConfigFile, previous, layout.home, localFileModes.private));
  }

  let committed = false;
  const warnings: string[] = [...modeNotes.value];
  if (repair.kind === 'marker' && plan.marker !== null) {
    const written = await deps.fs.writeTextAtomic(layout.nodeJson, plan.marker, layout.stateDir);
    if (!written.ok) return rollback(written.error);
    const { previous } = repair;
    undo.push(() =>
      previous === null
        ? deps.fs.remove(layout.nodeJson)
        : deps.fs.writeTextAtomic(layout.nodeJson, previous, layout.stateDir),
    );
  }
  if (repair.kind === 'folder') {
    const staging = stagingDirOf(layout.home, deps.pid);
    undo.push(() => deps.fs.remove(staging));
    const made = await makeStateFolder(deps, layout, staging, plan.stateFiles);
    if (!made.ok) return rollback(made.error);
    undo.push(() => deps.fs.remove(layout.stateDir));
    committed = made.value.committed;
    if (!committed) {
      warnings.push(`No git identity: the first commit of ${dirs.state} was not made. Set user.name and user.email, then commit there.`);
    }
  }

  const recorded = await recordNode(deps, indexPath, {
    home: layout.home,
    id,
    projects: config.recipe.projects.map((project) => project.path),
    // A folder that the list did not count is received, whatever its old entry says (D-16).
    origin: standing.registration === 'registered' ? 'own' : 'received',
  });
  if (!recorded.ok) {
    return rollback(
      failure(recorded.error, `Fix the cause, then run "${commandText(commands.init)}" again. A second run works in the same folder.`).error,
    );
  }

  if (repair.kind === 'marker') {
    const marker = await commitMarker(deps, layout);
    committed = marker.committed;
    warnings.push(...marker.warnings);
  }
  const records =
    standing.registration === 'registered'
      ? await recordApprovals(deps, layout.home, id, points, plan.approvals)
      : { modes: plan.approvals.modes, warnings: [] };
  const accepted = await recordAcceptance(deps, plan.acceptance);
  // The mode that counts for each point comes from the records, so a delegation that no record backs counts as `owner`.
  const approval = await effectiveModes(deps, layout.home, {
    ...config,
    core: { ...config.core, approval: plan.approvals.modes },
  });
  return ok({
    committed,
    accepted: accepted.accepted,
    approval,
    warnings: [...warnings, ...records.warnings, ...accepted.warnings],
  });
};

const writtenNames = (plan: Plan, repair: Repair): readonly string[] => {
  const names = { none: [], marker: [STATE_LABEL], folder: [`${dirs.state}/`] };
  return [...(plan.local === null ? [] : [files.localConfig]), ...names[repair.kind]];
};

const existingOf = (standing: Standing, repair: Repair): string => {
  if (standing.registration !== 'registered') return standing.registration;
  return repair.kind === 'none' ? 'registered' : repair.kind;
};

/**
 * `init` for a folder that holds both config files. Every check comes before the first question, and every question comes
 * before the first write. The run changes nothing else than what the state of the folder needs: it never writes
 * `factory.yaml`, the root `.gitignore`, the setup texts or the coordinator text.
 */
export const runExisting = async (
  deps: Deps,
  options: InitOptions,
  indexPath: string,
  home: string,
): Promise<CliResult<CommandOutput>> => {
  const checked = await checkExisting(deps, options, indexPath, home);
  if (!checked.ok) return checked;
  const { config, root, standing } = checked.value;
  const id = config.core.node.id;
  const received = standing.registration !== 'registered';

  const setup = await collectSetup(deps, home, root.set);
  if (!setup.ok) return setup;
  const listing = received ? listingOf(home, id, standing) : [];
  const asking = received ? withFirstQuestion(deps, listing.join('\n')) : deps;
  if (received) {
    const agreed = await askRegistration(asking, options, home);
    if (!agreed.ok) return agreed;
  }
  const approvals = await approvalsOf(deps, options, checked.value);
  if (!approvals.ok) return approvals;
  const decision = await decideAcceptance(asking, { home, node: id, yes: options.yes, setup: setup.value });
  if (!decision.ok) return decision;
  const plan = await planOf(deps, checked.value, approvals.value, decision.value, setup.value);
  if (!plan.ok) return plan;

  const applied = await applyExisting(deps, checked.value, plan.value, indexPath);
  if (!applied.ok) return applied;

  const written = writtenNames(plan.value, checked.value.repair);
  const warnings = [...checked.value.warnings, ...delegationWarnings(checked.value), ...applied.value.warnings];
  const headline = received
    ? `Registered the ${roles.node} "${id}" in ${home}.`
    : `The ${roles.node} "${id}" in ${home} is registered.`;
  const lines: readonly OutLine[] = [
    { level: 'text', text: headline },
    ...listing.map((line): OutLine => ({ level: 'text', text: line })),
    ...written.map((name): OutLine => ({ level: 'text', text: `  ${name}` })),
    ...(received ? [] : approvalLines(home, applied.value.approval)),
    ...(plan.value.acceptance === null ? [] : acceptanceLines(plan.value.acceptance, applied.value.accepted)),
    ...(decision.value.kind === 'declined' ? declinedLines() : []),
    { level: 'text', text: `Next: run "${commandText(commands.doctor)} ${flagText(flags.home)} ${home}".` },
  ];
  return ok({
    lines,
    json: {
      schema: schemaIds.init,
      home,
      nodeId: id,
      existing: existingOf(standing, checked.value.repair),
      files: written,
      committed: applied.value.committed,
      rootCommitted: false,
      approval: applied.value.approval,
      accepted: applied.value.accepted,
      warnings,
    },
    warnings,
    failed: false,
  });
};
