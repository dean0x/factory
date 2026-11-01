export const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const initialBoardText = (): string => jsonText({ merge: [], items: [] });

export const initialWaitingText = (): string => jsonText({ intro: '', groups: [], items: [] });

export const initialDecisionLogText = (): string => jsonText({ rows: [] });

export const STATE_GITIGNORE = 'state/\nlocks/\nbackups/\n';
