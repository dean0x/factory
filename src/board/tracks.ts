import { failure, type CliResult } from '../cli/errors.js';
import { ok } from '../core/result.js';
import { isRecord } from '../migrate/inspect.js';
import { boardKeys, files, trackLimits } from '../names.js';
import type { BoardTrack } from './contract.js';

/**
 * The tracks of the board file. `tracks` is an optional top key: a list of tracks, each with an id, a name and a roadmap flag.
 * An absent key is an empty list. The same rules for an id and a name serve a read (exit 1) and the `track` command (exit 2).
 */

const FILE = files.board;

/** A control character: a line break, a tab and the other characters that a line of text can not hold. */
const CONTROL = /\p{Cc}/u;

/** The value when it is text, else the empty text, which no id and no name accepts. */
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Why a text can not be a track id, or null when it can. The reason never repeats the text. */
export const trackIdIssue = (id: string): string | null => {
  if (!trackLimits.idPattern.test(id)) {
    return 'an id starts with a lowercase letter and holds lowercase letters, digits and hyphens';
  }
  return id.length > trackLimits.maxIdChars ? `an id has at most ${trackLimits.maxIdChars} characters` : null;
};

/** Why a text can not be a track name, or null when it can. The reason never repeats the text. */
export const trackNameIssue = (name: string): string | null => {
  if (name.trim() === '') return 'a name is text that is not empty';
  if (CONTROL.test(name)) return 'a name is one line';
  return name.length > trackLimits.maxNameChars ? `a name has at most ${trackLimits.maxNameChars} characters` : null;
};

const trackOf = (entry: unknown, at: number): CliResult<BoardTrack> => {
  const place = `${FILE}: track ${at + 1}`;
  if (!isRecord(entry)) return failure(`${place} is not an object`);
  const id = textOf(entry[boardKeys.id]);
  const idIssue = trackIdIssue(id);
  if (idIssue !== null) return failure(`${place} has a bad id: ${idIssue}`);
  const name = textOf(entry[boardKeys.name]);
  const nameIssue = trackNameIssue(name);
  if (nameIssue !== null) return failure(`${place} (${id}) has a bad name: ${nameIssue}`);
  const roadmap = entry[boardKeys.roadmap];
  if (typeof roadmap !== 'boolean') return failure(`${place} (${id}) has a roadmap value that is not true or false`);
  return ok({ id, name, roadmap });
};

/**
 * The tracks of the top object of the board file, in the order of the file. A value that is not a list, a track that is not an
 * object, a bad id, a bad name, a roadmap value that is not a boolean and a repeated id are failures (exit 1) that name the file.
 */
export const tracksOf = (top: Readonly<Record<string, unknown>>): CliResult<readonly BoardTrack[]> => {
  if (!Object.hasOwn(top, boardKeys.tracks)) return ok([]);
  const list = top[boardKeys.tracks];
  if (!Array.isArray(list)) return failure(`${FILE}: "${boardKeys.tracks}" is not a list`);
  const tracks: BoardTrack[] = [];
  const seen = new Set<string>();
  for (const [at, entry] of list.entries()) {
    const track = trackOf(entry, at);
    if (!track.ok) return track;
    if (seen.has(track.value.id)) return failure(`${FILE}: the track id ${track.value.id} is used twice`);
    seen.add(track.value.id);
    tracks.push(track.value);
  }
  return ok(tracks);
};
