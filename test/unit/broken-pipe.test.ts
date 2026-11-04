import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ignoreBrokenPipe } from '../../src/cli/broken-pipe.js';
import { isHookRoute } from '../../src/cli/run.js';
import { commands } from '../../src/names.js';

const withCode = (code: string): Error => Object.assign(new Error(`write ${code}`), { code });

describe('ignoreBrokenPipe', () => {
  it('ignores an EPIPE error on each stream', () => {
    const [out, err] = [new EventEmitter(), new EventEmitter()];
    ignoreBrokenPipe([out, err]);
    expect(() => out.emit('error', withCode('EPIPE'))).not.toThrow();
    expect(() => err.emit('error', withCode('EPIPE'))).not.toThrow();
  });

  it('keeps the listener for a second EPIPE error', () => {
    const stream = new EventEmitter();
    ignoreBrokenPipe([stream]);
    stream.emit('error', withCode('EPIPE'));
    expect(() => stream.emit('error', withCode('EPIPE'))).not.toThrow();
  });

  it.each(['EIO', 'ENOSPC', 'ERR_STREAM_DESTROYED'])('throws the error %s again, so it ends the process as before', (code) => {
    const stream = new EventEmitter();
    ignoreBrokenPipe([stream]);
    expect(() => stream.emit('error', withCode(code))).toThrow(`write ${code}`);
  });

  it('throws an error that has no code again', () => {
    const stream = new EventEmitter();
    ignoreBrokenPipe([stream]);
    expect(() => stream.emit('error', new Error('plain'))).toThrow('plain');
  });

  it('adds one listener to each stream and touches no other event', () => {
    const stream = new EventEmitter();
    ignoreBrokenPipe([stream]);
    expect(stream.listenerCount('error')).toBe(1);
    expect(stream.eventNames()).toEqual(['error']);
  });

  it('does nothing for no stream', () => {
    expect(() => ignoreBrokenPipe([])).not.toThrow();
  });
});

describe('isHookRoute', () => {
  it.each([[[commands.hook]], [[commands.hook, 'Stop']], [[commands.hook, 'statusline']], [[commands.hook, '--help']]])(
    'is true for %j',
    (argv) => {
      expect(isHookRoute(argv)).toBe(true);
    },
  );

  it.each([[[]], [[commands.help]], [['init', commands.hook]], [[`${commands.hook}s`]]])('is false for %j', (argv) => {
    expect(isHookRoute(argv)).toBe(false);
  });
});
