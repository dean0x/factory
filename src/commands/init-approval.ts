import { join } from 'node:path';
import { safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { recordDelegation, requireOwnerChannel } from '../core/owner-record.js';
import { ok } from '../core/result.js';
import {
  approvalQuestion,
  commands,
  commandText,
  dirs,
  files,
  flags,
  flagText,
  places,
  roles,
  values,
} from '../names.js';
import { ownerModes, type ApprovalMode, type ApprovalModes, type ApprovalPoint } from '../recipes/index.js';

const [OWNER_MODE, DELEGATED_MODE] = values.approvalModes;

/**
 * The mode of each approval point of the recipe, as `init` writes it into the local file, and the points whose mode the
 * owner set: by a flag or by an answer, in a terminal window outside a factory session. `init` records these points
 * through the owner record writer after its last write. Every other point is `owner` by default, and nothing records it.
 */
export interface ApprovalChoice {
  readonly modes: ApprovalModes;
  readonly set: readonly string[];
}

/** What the records leave: the mode that counts for each point, and the warnings for the records that were not written. */
export interface RecordedApprovals {
  readonly modes: ApprovalModes;
  readonly warnings: readonly string[];
}

/** No flag, no answer: the modes are the default, and nothing is set. */
export const NO_APPROVALS: ApprovalChoice = { modes: {}, set: [] };

/** The remedy line of every stop that only the owner in a terminal window, outside a factory session, can lift. */
export const initInTerminalWindow = (): string =>
  `Run "${commandText(commands.init)}" in a terminal window outside a ${places.session}.`;

/** True when the owner can set a mode here. The owner record writer has the same rule, and it refuses all the same. */
const ownerCanSet = (deps: Deps, yes: boolean): boolean => !yes && requireOwnerChannel(deps).ok;

/** One flag value, `POINT=MODE`. The message never repeats the value, because the value can hold any character. */
const parseFlag = (text: string, points: readonly ApprovalPoint[]): CliResult<readonly [string, ApprovalMode]> => {
  const flag = flagText(flags.approval);
  const [id, word, ...rest] = text.split('=');
  const mode = values.approvalModes.find((candidate) => candidate === word);
  if (id === undefined || id === '' || rest.length > 0 || mode === undefined) {
    return usageError(`${flag}: write POINT=MODE, with MODE one of: ${values.approvalModes.join(', ')}`);
  }
  if (!points.some((point) => point.id === id)) {
    return usageError(
      `${flag}: the point is not an approval point of the ${roles.recipe}. The points are: ${points.map((point) => point.id).join(', ')}`,
    );
  }
  return ok([id, mode]);
};

/** The flag values as a list of points with their modes. A point that two flags name is refused. */
const parseFlags = (texts: readonly string[], points: readonly ApprovalPoint[]): CliResult<ReadonlyMap<string, ApprovalMode>> => {
  const given = new Map<string, ApprovalMode>();
  for (const text of texts) {
    const parsed = parseFlag(text, points);
    if (!parsed.ok) return parsed;
    const [id, mode] = parsed.value;
    if (given.has(id)) return usageError(`${flagText(flags.approval)}: the point ${id} is named twice`);
    given.set(id, mode);
  }
  return ok(given);
};

/**
 * The choice that the flags make, before any question. All checks of the flags come here, so a bad value or a refused
 * choice stops the command before the first clone and before any write. A `delegated` choice with `--yes` is a usage
 * error (exit 2). A `delegated` choice that the owner record writer would refuse is a stop (exit 4): no terminal window,
 * or a factory session. A point that no flag names has its mode in `base`: `owner` for a new factory, the current mode
 * for a factory that is there already.
 */
export const approvalsFromFlags = (
  deps: Deps,
  yes: boolean,
  points: readonly ApprovalPoint[],
  texts: readonly string[],
  base: ApprovalModes = ownerModes(points),
): CliResult<ApprovalChoice> => {
  const given = parseFlags(texts, points);
  if (!given.ok) return given;
  const asked = points.find((point) => given.value.get(point.id) === DELEGATED_MODE);
  if (asked !== undefined) {
    if (yes) {
      return usageError(
        `${flagText(flags.yes)} cannot set the approval point ${asked.id} to ${DELEGATED_MODE}`,
        `Run "${commandText(commands.init)} ${flagText(flags.approval)} <point>=${DELEGATED_MODE}" in a terminal window, with no ${flagText(flags.yes)}.`,
      );
    }
    const channel = requireOwnerChannel(deps);
    if (!channel.ok) {
      return safetyRefusal(`the approval point ${asked.id} cannot be ${DELEGATED_MODE}: ${channel.error.message}`, initInTerminalWindow());
    }
  }
  const owner = ownerCanSet(deps, yes);
  return ok({
    modes: { ...base, ...Object.fromEntries(given.value) },
    set: owner ? points.filter((point) => given.value.has(point.id)).map((point) => point.id) : [],
  });
};

/** The mode that an answer means: the name of a mode or its first letters, in any letter case. An empty answer is the default. */
const modeOfAnswer = (answer: string, fallback: ApprovalMode): ApprovalMode | null => {
  const text = answer.trim().toLowerCase();
  if (text === '') return fallback;
  return values.approvalModes.find((mode) => mode.startsWith(text)) ?? null;
};

const askMode = async (deps: Deps, point: ApprovalPoint, fallback: ApprovalMode): Promise<CliResult<ApprovalMode>> => {
  const question = `Approval point ${point.id} (${point.label}): ${OWNER_MODE} or ${DELEGATED_MODE}? [${fallback}] `;
  for (let attempt = 0; attempt < approvalQuestion.maxAttempts; attempt += 1) {
    const answer = await deps.prompt(question);
    if (!answer.ok) return answer;
    const mode = modeOfAnswer(answer.value, fallback);
    if (mode !== null) return ok(mode);
  }
  return usageError(
    `no valid answer for the approval point ${point.id}`,
    `Run "${commandText(commands.init)}" again and type ${values.approvalModes.join(' or ')}, or pass ${flagText(flags.approval)} ${point.id}=MODE.`,
  );
};

/**
 * Ask the owner for each point that no flag names, in the order of the recipe. The default answer of a point is its mode
 * in the choice: `owner` for a new factory, the current mode for a factory that is there already. The question is for a
 * person who types in a terminal window outside a factory session, with no `--yes`. In every other case the choice stays
 * as the flags made it.
 */
export const askApprovals = async (
  deps: Deps,
  yes: boolean,
  points: readonly ApprovalPoint[],
  choice: ApprovalChoice,
): Promise<CliResult<ApprovalChoice>> => {
  if (!deps.stdoutIsTTY || !ownerCanSet(deps, yes)) return ok(choice);
  const modes: Record<string, ApprovalMode> = { ...choice.modes };
  const set = new Set(choice.set);
  for (const point of points) {
    if (set.has(point.id)) continue;
    const mode = await askMode(deps, point, choice.modes[point.id] ?? OWNER_MODE);
    if (!mode.ok) return mode;
    modes[point.id] = mode.value;
    set.add(point.id);
  }
  return ok({ modes, set: points.filter((point) => set.has(point.id)).map((point) => point.id) });
};

/**
 * The lines of the summary of `init`: the mode that counts for each point. After a recorded delegation on a new root the
 * text of the coordinator still names the owner, because `init` renders it before it records anything. The line names the
 * command that renders it again. A run that rendered the text after its records says nothing of the kind (`rendered`).
 */
export const approvalLines = (
  home: string,
  modes: ApprovalModes,
  rendered = false,
): readonly { readonly level: 'text'; readonly text: string }[] => [
  { level: 'text', text: `Approval points: ${Object.entries(modes).map(([id, mode]) => `${id} ${mode}`).join(', ')}.` },
  ...(!rendered && Object.values(modes).includes(DELEGATED_MODE)
    ? [
        {
          level: 'text' as const,
          text:
            `The text in ${join(dirs.coordinator, files.claudeMd)} still names the ${roles.owner} for each approval point. ` +
            `Run "${commandText(commands.upgrade)} ${flagText(flags.home)} ${home}" to render it again.`,
        },
      ]
    : []),
];

/**
 * Write the record of each point that the owner set, through the owner record writer. A record that cannot be written is
 * a warning that names the point. The point counts as `owner` then, as the table of the effective mode says: the local
 * file asks for `delegated`, and no record agrees. The result holds the mode that counts for each point.
 */
export const recordApprovals = async (
  deps: Deps,
  root: string,
  node: string,
  points: readonly ApprovalPoint[],
  choice: ApprovalChoice,
): Promise<RecordedApprovals> => {
  const warnings: string[] = [];
  const counted: Record<string, ApprovalMode> = {};
  for (const point of points) {
    const mode = choice.modes[point.id] ?? OWNER_MODE;
    counted[point.id] = OWNER_MODE;
    if (!choice.set.includes(point.id)) continue;
    const written = await recordDelegation(deps, { root, node, point: point.id, mode });
    if (written.ok) {
      counted[point.id] = mode;
    } else {
      warnings.push(
        `The approval record of the point ${point.id} was not written (${written.error.message}). The point counts as ${OWNER_MODE}. ` +
          initInTerminalWindow(),
      );
    }
  }
  return { modes: counted, warnings };
};
