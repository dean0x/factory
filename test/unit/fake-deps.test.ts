import { describe, expect, it } from 'vitest';
import { createFakeDeps } from '../helpers/fake-deps.js';

describe('fake deps: run with the terminal', () => {
  it('records the options and the extra environment of each call, and no options for a call that gave none', async () => {
    const deps = createFakeDeps();
    await deps.runAttached('tmux', ['attach']);
    await deps.runAttached('npm', ['test'], { held: true, maxMs: 1000, killGraceMs: 10, extraEnv: { TOKEN: 't-1' } });
    expect(deps.attached).toEqual([
      { command: 'tmux', args: ['attach'] },
      { command: 'npm', args: ['test'], options: { held: true, maxMs: 1000, killGraceMs: 10, extraEnv: { TOKEN: 't-1' } } },
    ]);
    expect(deps.attached[0]).not.toHaveProperty('options');
  });

  it('ends with exit code 0 by default', async () => {
    expect(await createFakeDeps().runAttached('tmux', [])).toEqual({ kind: 'code', code: 0 });
  });

  it('returns a scripted signal end as it is, and hands the call to the script', async () => {
    const seen: string[] = [];
    const deps = createFakeDeps({
      runAttached: (call) => {
        seen.push(call.command);
        return { kind: 'signal', signal: 'SIGTERM', number: 15 };
      },
    });
    expect(await deps.runAttached('npm', ['test'], { held: true })).toEqual({ kind: 'signal', signal: 'SIGTERM', number: 15 });
    expect(seen).toEqual(['npm']);
  });
});
