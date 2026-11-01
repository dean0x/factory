import { dirs } from '../names.js';

export const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const initialBoardText = (): string => jsonText({ merge: [], items: [] });

export const initialWaitingText = (): string => jsonText({ intro: '', groups: [], items: [] });

export const initialDecisionLogText = (): string => jsonText({ rows: [] });

/** The runtime folders and the backups are not part of the state repository. */
export const STATE_GITIGNORE: string = [dirs.runtime, dirs.locks, dirs.backups].map((dir) => `${dir}/\n`).join('');
