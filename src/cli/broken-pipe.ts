/**
 * A write to a pipe whose reader has gone fails with the code EPIPE, and the stream then emits an `error` event. A stream
 * with no listener for that event ends the process with exit 1 and a stack trace. The hook of Claude Code never fails the
 * session that runs it, and Claude Code can close the pipes early, so the hook route ignores this one error.
 */

const BROKEN_PIPE_CODE = 'EPIPE';

/** The part of a stream that this module uses. */
export interface ErrorSource {
  on(event: 'error', listener: (error: Error) => void): unknown;
}

const isBrokenPipe = (error: Error): boolean => 'code' in error && error.code === BROKEN_PIPE_CODE;

/**
 * Ignore an EPIPE error on each stream. Any other error is thrown again, so it ends the process as before. The listeners
 * stay until the process ends: the caller exits right after the route.
 */
export const ignoreBrokenPipe = (streams: readonly ErrorSource[]): void => {
  for (const stream of streams) {
    stream.on('error', (error) => {
      if (!isBrokenPipe(error)) throw error;
    });
  }
};
