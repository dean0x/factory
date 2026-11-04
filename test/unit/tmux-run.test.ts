import { describe, expect, it } from 'vitest';
import { hasSessionArgs, killSessionArgs } from '../../src/launch/tmux.js';
import {
  coordinatorEnded,
  isSameHome,
  requireOwnSession,
  requireSession,
  sessionExists,
  tmuxCall,
  tmuxStep,
} from '../../src/launch/tmux-run.js';
import { createFakeDeps, exited } from '../helpers/fake-deps.js';
import { tmuxHandler, type TmuxFixture } from '../helpers/tmux-fake.js';

const HOME = '/w/node';

const make = (fixture?: TmuxFixture, links?: Readonly<Record<string, string>>) => {
  const { handler, log } = tmuxHandler(fixture);
  const deps = createFakeDeps({ run: handler, ...(links === undefined ? {} : { links }) });
  deps.seedDir(HOME);
  return { deps, log };
};

describe('the tmux call', () => {
  it('runs tmux with the environment of the process and a time limit', async () => {
    const { deps, log } = make();
    await tmuxCall(deps, hasSessionArgs('demo'));
    expect(log.calls[0]).toMatchObject({ command: 'tmux', args: ['has-session', '-t', '=demo'], inheritEnv: true, timeoutMs: 15_000 });
  });
});

describe('the tmux step', () => {
  it('gives the output of a call that works', async () => {
    const { deps } = make({ sessions: { demo: HOME } });
    expect(await tmuxStep(deps, ['show-options', '-q', '-v', '-t', '=demo:', '@factory_home'])).toEqual({ ok: true, value: `${HOME}\n` });
  });

  it('fails with the exit code and the first line of the error text', async () => {
    const { deps } = make({ sessions: { demo: HOME }, failing: 'kill-session' });
    const result = await tmuxStep(deps, killSessionArgs('demo'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('tmux kill-session failed (exit code 1): kill-session failed');
  });

  it('keeps at most 200 characters of the error text', async () => {
    const deps = createFakeDeps({ run: () => exited(2, '', `\n  ${'x'.repeat(500)}\nsecond line\n`) });
    const result = await tmuxStep(deps, ['list-sessions']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe(`tmux list-sessions failed (exit code 2): ${'x'.repeat(200)}`);
  });

  it('fails when tmux cannot run', async () => {
    const { deps } = make({ version: null });
    expect((await tmuxStep(deps, hasSessionArgs('demo'))).ok).toBe(false);
  });
});

describe('the session checks', () => {
  it('finds a session by its exact name', async () => {
    const { deps } = make({ sessions: { demo2: HOME } });
    expect(await sessionExists(deps, 'demo2')).toBe(true);
    expect(await sessionExists(deps, 'demo')).toBe(false);
  });

  it('counts a tmux that does not run as no session', async () => {
    const { deps } = make({ version: null, sessions: { demo: HOME } });
    expect(await sessionExists(deps, 'demo')).toBe(false);
  });

  it('knows whether the program of the coordinator has ended', async () => {
    const { deps } = make({ sessions: { demo: HOME, other: HOME }, endedCoordinators: ['demo'] });
    expect(await coordinatorEnded(deps, 'demo')).toBe(true);
    expect(await coordinatorEnded(deps, 'other')).toBe(false);
  });

  it('counts a pane that cannot be read as one that runs', async () => {
    const { deps } = make({ sessions: { demo: HOME }, endedCoordinators: ['demo'], failing: 'display-message' });
    expect(await coordinatorEnded(deps, 'demo')).toBe(false);
  });
});

describe('the home of a session', () => {
  it('is the same home for the same path, and for a link to it', async () => {
    const { deps } = make(undefined, { '/w/link': HOME });
    deps.seedDir('/w/link');
    expect(await isSameHome(deps, HOME, HOME)).toBe(true);
    expect(await isSameHome(deps, '/w/link', HOME)).toBe(true);
  });

  it('is another home for an empty option, another path, or a path that does not exist', async () => {
    const { deps } = make();
    deps.seedDir('/w/other');
    expect(await isSameHome(deps, '', HOME)).toBe(false);
    expect(await isSameHome(deps, '/w/other', HOME)).toBe(false);
    expect(await isSameHome(deps, '/w/gone', HOME)).toBe(false);
  });

  it('lets a session of this home pass', async () => {
    const { deps } = make({ sessions: { demo: HOME } });
    expect(await requireOwnSession(deps, 'demo', HOME)).toEqual({ ok: true, value: undefined });
  });

  it('refuses a session of another home with a safety stop that tells the fix', async () => {
    const { deps } = make({ sessions: { demo: '/w/other' } });
    const result = await requireOwnSession(deps, 'demo', HOME);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('safety');
      expect(result.error.message).toContain('belongs to another');
      expect(result.error.hint).toContain('stop the other session');
    }
  });

  it('refuses a session that has no home option', async () => {
    const { deps } = make({ sessions: { demo: null } });
    expect((await requireOwnSession(deps, 'demo', HOME)).ok).toBe(false);
  });
});

describe('the session that a command needs', () => {
  it('lets a session of this home pass', async () => {
    const { deps } = make({ sessions: { demo: HOME } });
    expect(await requireSession(deps, 'demo', HOME, 'factory layout')).toEqual({ ok: true, value: undefined });
  });

  it('gives exit 3 for no session, names factory start, and names the command to run again', async () => {
    const { deps } = make();
    const result = await requireSession(deps, 'demo', HOME, 'factory layout');
    expect(!result.ok && result.error.kind).toBe('not-ready');
    expect(!result.ok && result.error.message).toContain('demo');
    expect(!result.ok && result.error.hint).toContain('"factory start"');
    expect(!result.ok && result.error.hint).toContain('"factory layout"');
  });

  it('gives exit 3 when tmux does not run at all', async () => {
    const { deps } = make({ version: null });
    const result = await requireSession(deps, 'demo', HOME, 'factory layout');
    expect(!result.ok && result.error.kind).toBe('not-ready');
  });

  it('gives a safety stop for a session of another home', async () => {
    const { deps } = make({ sessions: { demo: '/w/other' } });
    const result = await requireSession(deps, 'demo', HOME, 'factory layout');
    expect(!result.ok && result.error.kind).toBe('safety');
  });
});
