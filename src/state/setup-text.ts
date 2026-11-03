import { relative } from 'node:path';
import { holdsBlockMarker } from '../blocks/managed.js';
import { failure, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { requireNoLinks } from '../core/root-paths.js';
import { ok } from '../core/result.js';
import { maxSetupTextBytes } from '../names.js';
import type { SetupTexts } from '../templates/types.js';
import type { Layout } from './layout.js';

/** A control character other than the line end and the tab. Plain text holds none of them. */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const again = 'then run the command again.';

/**
 * The text of one setup file, or null when the file is absent. The caller gets the text with LF line ends. The read is
 * bounded, the text must be plain text, and it must hold no managed-block marker, because a marker in the body of a
 * block would break the parse of the block. A link in the path is a security stop (exit 4). Any other problem is an
 * error (exit 1) with a remedy line.
 */
export const readSetupFile = async (deps: Deps, layout: Layout, path: string): Promise<CliResult<string | null>> => {
  const linked = await requireNoLinks(deps, layout.home, [path]);
  if (!linked.ok) return linked;
  const shown = relative(layout.home, path);
  const kind = await deps.fs.stat(path);
  if (!kind.ok) return kind;
  if (kind.value === null) return ok(null);
  if (kind.value !== 'file') return failure(`${shown} is not a file`, `Move it away, ${again}`);

  const read = await deps.fs.readTextLimited(path, maxSetupTextBytes);
  if (!read.ok) {
    return read.error.message.includes('larger than')
      ? failure(`${shown} is larger than ${maxSetupTextBytes} bytes`, `Shorten ${shown}, ${again}`)
      : read;
  }
  if (CONTROL_CHARACTER.test(read.value)) {
    return failure(`${shown} is not plain text: it holds a control character`, `Remove the control characters from ${shown}, ${again}`);
  }
  if (holdsBlockMarker(read.value)) {
    return failure(`${shown} holds a line that starts a managed block`, `Remove the marker lines from ${shown}, ${again}`);
  }
  return ok(read.value.replace(/\r\n?/g, '\n'));
};

/** The text for a block: null when the file is absent or holds nothing but white space. */
export const renderableSetupText = (text: string | null): string | null => (text === null || text.trim() === '' ? null : text);

/** The setup texts of a factory folder as the blocks need them. A file that is absent or empty gives null. */
export const readSetupTexts = async (deps: Deps, layout: Layout): Promise<CliResult<SetupTexts>> => {
  const coordinator = await readSetupFile(deps, layout, layout.setupCoordinatorFile);
  if (!coordinator.ok) return coordinator;
  const worker = await readSetupFile(deps, layout, layout.setupWorkerFile);
  if (!worker.ok) return worker;
  return ok({ coordinator: renderableSetupText(coordinator.value), worker: renderableSetupText(worker.value) });
};
