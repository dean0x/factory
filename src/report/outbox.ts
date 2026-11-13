import type { CliResult } from '../cli/errors.js';
import type { NodeReport } from '../comms/report-schema.js';
import type { Deps, LinkKind } from '../core/deps.js';
import { ok } from '../core/result.js';
import { writeInFolder } from '../core/safe-write.js';
import { files, privateFile } from '../names.js';
import { layoutOf } from '../state/layout.js';
import { checkReport, reportTextOf } from './build.js';

/**
 * What a call of `writeReportFile` did: it wrote the report file, or it wrote nothing because the node has no factory folder.
 */
export type ReportWrite = 'written' | 'skipped';

/**
 * An event folder that exists gets the folder mode too: the write sets that mode only for a folder that it makes. A link is never
 * followed here, so a link at the factory folder or at the event folder is left to the write, which refuses it.
 */
const tightenEventFolder = async (deps: Deps, stateKind: LinkKind | null, folder: string): Promise<CliResult<void>> => {
  if (stateKind !== 'dir') return ok(undefined);
  const kind = await deps.fs.lstat(folder);
  if (!kind.ok) return kind;
  return kind.value === 'dir' ? deps.fs.chmod(folder, privateFile.folderMode) : ok(undefined);
};

/**
 * Write the report of the node to its report file in the event folder of the factory folder. The file has mode 600 and the folder
 * mode 700, also when the folder exists already: a folder that cannot get that mode is a failure, and nothing is written. The write
 * is atomic: a reader sees the old file or the new file, never a part. A node with no factory folder gets no file, and the folder
 * is never made (`skipped`). The document is checked again here (`checkReport`), so no text leaves the node unless it passes the
 * list of the allowed fields and the byte cap. A link at the factory folder, at the event folder or at the file, and a real path
 * outside the factory folder, are a security stop (exit 4). Any other fault is a failure (exit 1), and the older file stays as it
 * was.
 */
export const writeReportFile = async (deps: Deps, home: string, report: NodeReport): Promise<CliResult<ReportWrite>> => {
  const layout = layoutOf(home);
  const state = await deps.fs.lstat(layout.stateDir);
  if (!state.ok) return state;
  if (state.value === null) return ok('skipped');
  const checked = checkReport(report);
  if (!checked.ok) return checked;
  const tightened = await tightenEventFolder(deps, state.value, layout.outboxDir);
  if (!tightened.ok) return tightened;
  const written = await writeInFolder(
    deps,
    { parent: layout.stateDir, folder: layout.outboxDir, name: files.report, mode: privateFile.fileMode, folderMode: privateFile.folderMode },
    reportTextOf(checked.value),
  );
  return written.ok ? ok('written') : written;
};
