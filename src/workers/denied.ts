import { join } from 'node:path';
import { z } from 'zod';
import { safetyRefusal, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { requireNoLinks } from '../core/root-paths.js';
import { commandLines, commandText, deniedList, dirs, files } from '../names.js';
import { layoutOf } from '../state/layout.js';
import { parseJsonText } from '../state/load.js';

const deniedEntry = z.string().min(1).max(deniedList.maxChars).refine((entry) => !/[^ -~]/.test(entry));
const deniedSchema = z.strictObject({ schema: z.literal(1), denied: z.array(deniedEntry).max(deniedList.maxEntries) });
const remedy = `Check ${dirs.state}/${files.denied}. Use a plain file with the required format. Then retry with "${commandText(commandLines.workerRelay)}".`;

/** Read the optional list. Only an absent file means no entries without a valid list. */
export const readDeniedList = async (deps: Deps, home: string): Promise<CliResult<readonly string[]>> => {
  const { stateDir } = layoutOf(home);
  const path = join(stateDir, files.denied);
  const linked = await requireNoLinks(deps, home, [path], remedy);
  if (!linked.ok) return safetyRefusal('the denied list path cannot be used', remedy);

  const opened = await deps.fs.openChecked(path, { uid: deps.uid, maxBytes: deniedList.maxBytes, decode: 'fatal' });
  if (opened.ok && opened.value.state === 'absent') {
    // The checked open also reports absence when a parent is not a directory.
    const parent = await deps.fs.lstat(stateDir);
    return parent.ok && (parent.value === 'dir' || parent.value === null)
      ? ok([])
      : safetyRefusal('the denied list path cannot be used', remedy);
  }
  if (!opened.ok || opened.value.state !== 'opened' || opened.value.text === null) {
    return safetyRefusal('the denied list cannot be read', remedy);
  }

  const json = parseJsonText(opened.value.text);
  if (!json.ok) return safetyRefusal('the denied list is not valid JSON', remedy);
  const parsed = deniedSchema.safeParse(json.value);
  return parsed.success
    ? ok(parsed.data.denied)
    : safetyRefusal('the denied list does not have the required format', remedy);
};

const fold = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ');

/** Find the first entry that matches one request field. Return its one-based number, or null. */
export const deniedMatchOf = (
  entries: readonly string[],
  texts: readonly [title: string, question: string, optionText: string],
): number | null => {
  const foldedTexts = texts.map(fold);
  const index = entries.findIndex((entry) => {
    const needle = fold(entry);
    return foldedTexts.some((text) => text.includes(needle));
  });
  return index === -1 ? null : index + 1;
};
