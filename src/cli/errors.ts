import { err, type Err, type Result } from '../core/result.js';

export type CliErrorKind = 'usage' | 'failure' | 'not-ready' | 'safety';

export interface CliError {
  readonly kind: CliErrorKind;
  readonly message: string;
  readonly hint?: string;
}

export type CliResult<T> = Result<T, CliError>;

export const exitCodeOf: Readonly<Record<CliErrorKind, number>> = {
  failure: 1,
  usage: 2,
  'not-ready': 3,
  safety: 4,
};

const make = (kind: CliErrorKind, message: string, hint: string | undefined): CliError =>
  hint === undefined ? { kind, message } : { kind, message, hint };

export const failure = (message: string, hint?: string): Err<CliError> =>
  err(make('failure', message, hint));

export const usageError = (message: string, hint?: string): Err<CliError> =>
  err(make('usage', message, hint));

export const safetyRefusal = (message: string, hint?: string): Err<CliError> =>
  err(make('safety', message, hint));
