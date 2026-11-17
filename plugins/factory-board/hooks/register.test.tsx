import type { On, ProcessRunResult, RenderSurface, UiPane } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import { boardTextFixture } from '../test/board';

const PANE = {
  plugin: 'factory-board', component: 'Pane', requestId: 'factory-board',
  props: {
    title: 'Factory board', isFocused: false, bodyColumns: 100,
    placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {},
  },
} as const;
const OPEN = {
  command: 'board', args: '', origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
} as const;
const success = (stdout = boardTextFixture): ProcessRunResult => ({
  exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
});

const setup = (on: On) => {
  const clock = mock.clock(on, { now: Date.parse('2030-01-02T03:04:00Z') });
  let panes: readonly UiPane[] = [];
  let registrations = 0;
  on('command.register', () => { registrations += 1; return { value: { command: 'board' } }; });
  on('command.run', () => ({ text: '' }));
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('session.end', () => ({ sessionId: 'demo' }));
  on('ui.open', () => {
    panes = [{ id: 'factory-board', title: 'Factory board', isShown: true, isPlaced: true, isFocused: false }];
    return { value: { isPlaced: true } };
  });
  on('ui.panes', () => ({ value: panes }));
  on('session.usage', () => ({ value: {
    startedAt: 0, context: { window: 200000, percent: 23 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 42 }, { kind: 'seven_day', percentUsed: 17 }],
  } }));
  return { clock, registrations: () => registrations, panes: () => panes, hide: (placed = true) => {
    panes = panes.map(pane => ({ ...pane, isShown: false, isPlaced: placed }));
  } };
};
const start = ($: Engine, surface: RenderSurface) => $.session.start({ cwd: '/demo', surface, isInteractive: true });

for (const surface of ['terminal', 'desktop'] as const) {
  test(`board opens and draws the shared text on ${surface}`, async ($, on) => {
    const host = setup(on);
    on('process.run', () => ({ value: success() }));
    await start($, surface);
    expect(host.registrations()).toBe(1);
    expect(host.panes()).toHaveLength(0);
    await $.command.run(OPEN);
    expect(host.panes()).toHaveLength(1);
    const ui = await $.ui.mount({ ...PANE, surface });
    await host.clock.advance(10000);
    const rows = (await ui.findAll({ type: 'Text' })).map(row => row.text);
    expect(rows.slice(1)).toEqual(boardTextFixture.trimEnd().split('\n'));
    expect(rows[0]).toMatch(/^context 23% · 5h 42% · 7d 17% · updated \d{2}:\d{2}:\d{2}$/);
    expect(await ui.find({ type: 'Box' })).toBeDefined();
    await ui.unmount();
  });

  test(`auto opens at session start on ${surface}`, { options: { open: 'auto' } }, async ($, on) => {
    const host = setup(on);
    await start($, surface);
    expect(host.panes()).toHaveLength(1);
  });

  test(`hidden and unplaced panes do not run on ${surface}`, async ($, on) => {
    const host = setup(on);
    let runs = 0;
    on('process.run', () => { runs += 1; return { value: success() }; });
    await start($, surface);
    await host.clock.advance(10000);
    expect(runs).toBe(0);
    await $.command.run(OPEN);
    await host.clock.advance(10000);
    expect(runs).toBe(1);
    host.hide();
    await host.clock.advance(10000);
    host.hide(false);
    await host.clock.advance(10000);
    expect(runs).toBe(1);
  });

  test(`one run stays open at a time on ${surface}`, async ($, on) => {
    const host = setup(on);
    let runs = 0;
    on('process.run', async () => {
      runs += 1;
      await host.clock.sleep(25000);
      return { value: success() };
    });
    await start($, surface);
    await $.command.run(OPEN);
    const ui = await $.ui.mount({ ...PANE, surface });
    await host.clock.advance(30000);
    expect(runs).toBe(1);
    await host.clock.advance(5000);
    expect(await ui.find({ type: 'Text', text: 'Requests' })).toBeDefined();
    await ui.unmount();
  });

  test(`a missing program gives an option hint on ${surface}`, async ($, on) => {
    const host = setup(on);
    on('process.run', () => ({ deny: 'spawn factory ENOENT' }));
    await start($, surface);
    await $.command.run(OPEN);
    const ui = await $.ui.mount({ ...PANE, surface });
    await host.clock.advance(10000);
    expect((await ui.find({ type: 'Text', text: /not found/ }))?.text).toBe('Factory command not found. Set the command option.');
    await ui.unmount();
  });

  test(`an exit fault keeps the last good text and its time on ${surface}`, async ($, on) => {
    const host = setup(on);
    let runs = 0;
    on('process.run', () => ({ value: ++runs === 1 ? success() : {
      ...success(), exitCode: 1, stderr: '\u001b[31mRead failed\u001b[0m\nprivate second line',
    } }));
    await start($, surface);
    await $.command.run(OPEN);
    const ui = await $.ui.mount({ ...PANE, surface });
    await host.clock.advance(10000);
    const header = (await ui.findAll({ type: 'Text' }))[0]?.text;
    await host.clock.advance(10000);
    expect((await ui.find({ type: 'Text', text: 'Read failed' }))?.text).toBe('Read failed');
    expect(await ui.find({ type: 'Text', text: /Last good ·/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: 'Requests' })).toBeDefined();
    expect((await ui.findAll({ type: 'Text' }))[0]?.text).toBe(header);
    expect(await ui.find({ type: 'Text', text: /private second line/ })).toBeUndefined();
    await ui.unmount();
  });

  test(`a timeout recovers at the next tick on ${surface}`, async ($, on) => {
    const host = setup(on);
    let runs = 0;
    on('process.run', () => {
      if (++runs === 1) return { deny: 'process timed out' };
      return { value: success() };
    });
    await start($, surface);
    await $.command.run(OPEN);
    const ui = await $.ui.mount({ ...PANE, surface });
    await host.clock.advance(10000);
    expect(await ui.find({ type: 'Text', text: /failed or timed out/ })).toBeDefined();
    await host.clock.advance(10000);
    expect(await ui.find({ type: 'Text', text: /failed or timed out/ })).toBeUndefined();
    expect(await ui.find({ type: 'Text', text: 'Requests' })).toBeDefined();
    await ui.unmount();
  });

  test(`command and home stay separate argv values on ${surface}`, {
    options: { command: '/tools/factory app', home: '/demo/home; echo no' },
  }, async ($, on) => {
    const host = setup(on);
    const calls: unknown[] = [];
    on('process.run', (_, e) => { calls.push(e); return { value: success() }; });
    await start($, surface);
    await $.command.run(OPEN);
    const ui = await $.ui.mount({ ...PANE, surface });
    await host.clock.advance(10000);
    expect(calls).toEqual([{
      argv: ['/tools/factory app', 'board', '--width', '100', '--home', '/demo/home; echo no'],
      init: { timeoutMs: 10000 },
    }]);
    await ui.unmount();
  });

  test(`output has at most 400 plain lines on ${surface}`, async ($, on) => {
    const host = setup(on);
    on('process.run', () => ({ value: success('\u001b]8;;https://example.com\u0007\u001b[31mfirst\u001b[0m\u0000\r\n' + 'row\n'.repeat(450)) }));
    await start($, surface);
    await $.command.run(OPEN);
    const ui = await $.ui.mount({ ...PANE, surface });
    await host.clock.advance(10000);
    const rows = await ui.findAll({ type: 'Text' });
    expect(rows).toHaveLength(401);
    expect(rows[1]?.text).toBe('first');
    await ui.unmount();
  });

  for (const [seconds, interval, columns, width] of [[1, 5000, 2, 40], [999, 300000, 999, 120]] as const) {
    test(`refresh and width stay in range at ${seconds}s on ${surface}`, { options: { refreshSeconds: seconds } }, async ($, on) => {
      const host = setup(on);
      const calls: unknown[] = [];
      on('process.run', (_, e) => { calls.push(e); return { value: success() }; });
      await start($, surface);
      await $.command.run(OPEN);
      const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: columns } });
      await host.clock.advance(interval - 1);
      expect(calls).toHaveLength(0);
      await host.clock.advance(1);
      expect(calls).toEqual([{ argv: ['factory', 'board', '--width', String(width)], init: { timeoutMs: Math.min(interval, 30000) } }]);
      await ui.unmount();
    });
  }

  test(`truncated output does not replace good text on ${surface}`, async ($, on) => {
    const host = setup(on);
    let runs = 0;
    on('process.run', () => ({ value: ++runs === 1 ? success() : {
      ...success('partial'), isStdoutTruncated: true,
    } }));
    await start($, surface);
    await $.command.run(OPEN);
    const ui = await $.ui.mount({ ...PANE, surface });
    await host.clock.advance(20000);
    expect(await ui.find({ type: 'Text', text: /output was cut/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: 'Requests' })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: 'partial' })).toBeUndefined();
    await ui.unmount();
  });

  test(`invalid process output does not become board text on ${surface}`, async ($, on) => {
    const host = setup(on);
    on('process.run', () => ({ value: { ...success(), exitCode: -1 } }));
    await start($, surface);
    await $.command.run(OPEN);
    const ui = await $.ui.mount({ ...PANE, surface });
    await host.clock.advance(10000);
    expect(await ui.find({ type: 'Text', text: 'Factory returned invalid output.' })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: 'Requests' })).toBeUndefined();
    await ui.unmount();
  });

  test(`an exit without stderr shows its code on ${surface}`, async ($, on) => {
    const host = setup(on);
    on('process.run', () => ({ value: { ...success(), exitCode: 4 } }));
    await start($, surface);
    await $.command.run(OPEN);
    const ui = await $.ui.mount({ ...PANE, surface });
    await host.clock.advance(10000);
    expect(await ui.find({ type: 'Text', text: 'Factory exited with code 4.' })).toBeDefined();
    await ui.unmount();
  });

  test(`a resize changes the next run width on ${surface}`, async ($, on) => {
    const host = setup(on);
    const widths: string[] = [];
    on('process.run', (_, e) => { widths.push(e.argv[3] ?? ''); return { value: success() }; });
    await start($, surface);
    await $.command.run(OPEN);
    const ui = await $.ui.mount({ ...PANE, surface });
    await host.clock.advance(10000);
    await ui.unmount();
    const narrow = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 60 } });
    await host.clock.advance(10000);
    expect(widths).toEqual(['100', '60']);
    await narrow.unmount();
  });

  test(`missing usage values show question marks on ${surface}`, async ($, on) => {
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }));
    const ui = await $.ui.mount({ ...PANE, surface });
    expect((await ui.find({ type: 'Text' }))?.text).toBe('context ? · 5h ? · 7d ? · updated ?');
    await ui.unmount();
  });

  test(`session end stops refresh on ${surface}`, async ($, on) => {
    const host = setup(on);
    let runs = 0;
    on('process.run', () => { runs += 1; return { value: success() }; });
    await start($, surface);
    await $.command.run(OPEN);
    await host.clock.advance(10000);
    expect(runs).toBe(1);
    await $.session.end({ reason: 'clear', sessionId: 'demo', resume: { id: 'demo' } });
    await host.clock.advance(20000);
    expect(runs).toBe(1);
  });
}

test('a desktop widget shows only usage and the request count', async ($, on) => {
  const host = setup(on);
  on('process.run', () => ({ value: success() }));
  await start($, 'desktop');
  await $.command.run(OPEN);
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, placement: 'widget' } });
  await host.clock.advance(10000);
  expect((await ui.findAll({ type: 'Text' })).map(row => row.text).slice(1)).toEqual(['requests 1']);
  await ui.unmount();
});
