import type { Sink } from '../../src/cli/run.js';

export interface CapturedSink extends Sink {
  readonly out: string[];
  readonly errors: string[];
}

export const captureSink = (isTTY = false): CapturedSink => {
  const out: string[] = [];
  const errors: string[] = [];
  return {
    out,
    errors,
    isTTY,
    stdout: async (text) => void out.push(text),
    stderr: async (text) => void errors.push(text),
  };
};
