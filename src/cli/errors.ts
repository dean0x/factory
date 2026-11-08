import { err, type Err, type Result } from '../core/result.js';

export type CliErrorKind = 'usage' | 'failure' | 'not-ready' | 'safety';

/**
 * An error of a command. The text after the reason is the remedy line: one line that names the fix. A security stop
 * has one always, so a stop with no remedy does not compile.
 */
export type CliError =
  | { readonly kind: 'safety'; readonly message: string; readonly hint: string }
  | { readonly kind: Exclude<CliErrorKind, 'safety'>; readonly message: string; readonly hint?: string; readonly code?: FailureCode };

/** The failure code of a git config list that can not be read. */
export const gitConfigUnreadable = 'git-config-unreadable';

/** A failure that a caller can tell apart from the other failures without its text. */
export type FailureCode = typeof gitConfigUnreadable;

export type CliResult<T> = Result<T, CliError>;

export const exitCodeOf: Readonly<Record<CliErrorKind, number>> = {
  failure: 1,
  usage: 2,
  'not-ready': 3,
  safety: 4,
};

const make = (kind: Exclude<CliErrorKind, 'safety'>, message: string, hint: string | undefined): CliError =>
  hint === undefined ? { kind, message } : { kind, message, hint };

export const failure = (message: string, remedy?: string): Err<CliError> =>
  err(make('failure', message, remedy));

/** A failure (exit 1) that carries a code, so a caller can act on this failure alone. */
export const codedFailure = (code: FailureCode, message: string, remedy?: string): Err<CliError> =>
  err({ kind: 'failure', message, ...(remedy === undefined ? {} : { hint: remedy }), code });

/** True when the error is a failure that carries `code`. */
export const hasCode = (error: CliError, code: FailureCode): boolean => error.kind !== 'safety' && error.code === code;

export const usageError = (message: string, remedy?: string): Err<CliError> =>
  err(make('usage', message, remedy));

/** A command that cannot run yet (exit 3). The remedy line is required: it names the command or the step that makes it ready. */
export const notReady = (message: string, remedy: string): Err<CliError> =>
  err({ kind: 'not-ready', message, hint: remedy });

/** A security stop (exit 4). The remedy line is required: it names the command or the step that fixes the cause. */
export const safetyRefusal = (message: string, remedy: string): Err<CliError> =>
  err({ kind: 'safety', message, hint: remedy });
