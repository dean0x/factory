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

const setup = (on: On, placed = true, beforeRegister?: () => Promise<void>) => {
  const clock = mock.clock(on, { now: Date.parse('2030-01-02T03:04:00Z') });
  let panes: readonly UiPane[] = [];
  let registrations = 0;
  on('command.register', async () => {
    await beforeRegister?.();
    registrations += 1;
    return { value: { command: 'board' } };
  });
  on('command.run', () => ({ text: '' }));
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('session.end', () => ({ sessionId: 'demo' }));
  on('ui.open', () => {
    panes = [{ id: 'factory-board', title: 'Factory board', isShown: true, isPlaced: placed, isFocused: false }];
    return placed ? { value: { isPlaced: true } } : { value: { isPlaced: false, reason: 'No surface places panes.' } };
  });
  on('ui.panes', () => ({ value: panes }));
  on('session.usage', () => ({ value: {
    startedAt: 0, context: { window: 200000, percent: 23 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 42 }, { kind: 'seven_day', percentUsed: 17 }],
  } }));
  return { clock, registrations: () => registrations, panes: () => panes, setPane: (shown: boolean, placed: boolean) => {
    panes = panes.map(pane => ({ ...pane, isShown: shown, isPlaced: placed }));
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

  for (const [placed, text] of [
    [true, 'Factory board pane opened.'],
    [false, 'Factory board pane waits for a surface.'],
  ] as const) {
    test(`/board reports pane placement ${placed} on ${surface}`, async ($, on) => {
      setup(on, placed);
      await start($, surface);
      expect((await $.command.run(OPEN)).text).toBe(text);
    });
  }

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
    host.setPane(false, true);
    await host.clock.advance(10000);
    expect(runs).toBe(1);
    host.setPane(true, false);
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

  for (const command of ['', '  ', '\t \n', 'factory-cli']) {
    test(`command ${JSON.stringify(command)} uses a program name on ${surface}`, { options: { command } }, async ($, on) => {
      const host = setup(on);
      const programs: string[] = [];
      on('process.run', (_, e) => { programs.push(e.argv[0] ?? ''); return { value: success() }; });
      await start($, surface);
      await $.command.run(OPEN);
      await host.clock.advance(10000);
      expect(programs).toEqual([command.trim() === '' ? 'factory' : command]);
    });
  }

  for (const command of ['./factory', '../factory', 'tools/factory', 'tools/factory app', 'factory/']) {
    test(`relative command ${command} shows an option hint without a run on ${surface}`, { options: { command } }, async ($, on) => {
      const host = setup(on);
      let runs = 0;
      on('process.run', () => { runs += 1; return { value: success() }; });
      await start($, surface);
      await $.command.run(OPEN);
      const ui = await $.ui.mount({ ...PANE, surface });
      await host.clock.advance(20000);
      expect(runs).toBe(0);
      expect((await ui.findAll({ type: 'Text' })).map(row => row.text).slice(1))
        .toEqual(['Factory command not found. Set the command option.']);
      await ui.unmount();
    });
  }

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

  for (const [name, input, expected] of [
    ['OSC with BEL', 'a\u001b]8;;https://example.com\u0007b', 'ab'],
    ['OSC with ST', 'a\u001b]8;;https://example.com\u001b\\b', 'ab'],
    ['OSC without an end', 'a\u001b]8;;https://example.com', 'a'],
    ['CSI and C0', '\u001b[31ma\u001b[0m\u0000\tb', 'ab'],
    ['C1', 'a\u0080\u0085\u009bb\u009fc', 'abc'],
    ['bidi controls', 'a‪‫‬‭‮b⁦⁧⁨⁩c', 'abc'],
    ['zero width and direction marks', 'a​‌‍‎‏b؜c', 'abc'],
    ['line and paragraph separators', 'a b c', 'abc'],
    ['byte order mark', 'a﻿b', 'ab'],
    ['lone surrogates', 'a\ud800b\udcffc', 'abc'],
    ['default ignorable points', 'a͏bᅟc\u{e0100}d', 'abcd'],
    ['valid surrogate pair', 'a\u{1f680}b', 'a\u{1f680}b'],
    ['width after the filter', '\u001b[31m' + 'x'.repeat(39) + '\u{1f680}tail\u001b[0m', 'x'.repeat(39) + '\u{1f680}'],
  ] as const) {
    for (const stream of ['stdout', 'stderr'] as const) {
      test(`${stream} draws exact plain text for ${name} on ${surface}`, async ($, on) => {
        const host = setup(on);
        on('process.run', () => ({ value: stream === 'stdout'
          ? success(input)
          : { ...success(), exitCode: 1, stderr: input + '\nsecond line' } }));
        await start($, surface);
        await $.command.run(OPEN);
        const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 40 } });
        await host.clock.advance(10000);
        expect((await ui.findAll({ type: 'Text' })).map(row => row.text).slice(1)).toEqual([expected]);
        await ui.unmount();
      });
    }
  }

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
      const rows = (await ui.findAll({ type: 'Text' })).slice(1);
      expect(rows).toHaveLength(boardTextFixture.trimEnd().split('\n').length);
      for (const row of rows) expect(Array.from(row.text ?? '').length).toBeLessThanOrEqual(width);
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

  for (const restart of [false, true]) {
    test(`an old run cannot publish after session end (restart ${restart}) on ${surface}`, async ($, on) => {
      const host = setup(on);
      let runs = 0;
      on('process.run', async () => {
        if (++runs === 1) {
          await host.clock.sleep(25000);
          return { value: success('Previous board') };
        }
        return { value: success() };
      });
      await start($, surface);
      await $.command.run(OPEN);
      const ui = await $.ui.mount({ ...PANE, surface });
      await host.clock.advance(10000);
      await $.session.end({ reason: 'clear', sessionId: 'demo', resume: { id: 'demo' } });
      if (restart) await start($, surface);
      await host.clock.advance(25000);
      expect(runs).toBe(1);
      expect(await ui.find({ type: 'Text', text: 'Previous board' })).toBeUndefined();
      expect((await ui.findAll({ type: 'Text' }))[0]?.text).toMatch(/updated \?$/);
      await host.clock.advance(5000);
      expect(runs).toBe(restart ? 2 : 1);
      if (restart) expect(await ui.find({ type: 'Text', text: 'Requests' })).toBeDefined();
      await ui.unmount();
    });
  }

  for (const [name, output] of [
    ['no result', null],
    ['missing fields', { exitCode: 0, stdout: boardTextFixture, stderr: '' }],
    ['oversized stdout', success('x'.repeat(4194305))],
    ['oversized stderr', { ...success(), stderr: 'x'.repeat(4194305) }],
  ] as const) {
    test(`${name} keeps good text and shows a fault on ${surface}`, async ($, on) => {
      const host = setup(on);
      let runs = 0;
      on('process.run', () => ({ value: ++runs === 1 ? success() : output as unknown as ProcessRunResult }));
      await start($, surface);
      await $.command.run(OPEN);
      const ui = await $.ui.mount({ ...PANE, surface });
      await host.clock.advance(20000);
      expect(await ui.find({ type: 'Text', text: 'Factory returned invalid output.' })).toBeDefined();
      expect(await ui.find({ type: 'Text', text: 'Requests' })).toBeDefined();
      expect(await ui.find({ type: 'Text', text: /Last good ·/ })).toBeDefined();
      await ui.unmount();
    });
  }

  test(`session end during startup leaves no refresh timer on ${surface}`, async ($, on) => {
    let ticks = 0;
    on('clock.every', { ms: 10000 }, async (_, e, next) => { ticks += 1; return next(e); });
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host = setup(on, true, () => gate);
    const pending = start($, surface);
    await host.clock.settle();
    await $.session.end({ reason: 'clear', sessionId: 'demo', resume: { id: 'demo' } });
    release();
    await pending;
    await host.clock.advance(20000);
    expect(ticks).toBe(0);
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

test('a desktop widget marks a failed refresh and clears it after success', async ($, on) => {
  const host = setup(on);
  let runs = 0;
  on('process.run', () => ({ value: ++runs === 2 ? { ...success(), exitCode: 1, stderr: 'Read failed' } : success() }));
  await start($, 'desktop');
  await $.command.run(OPEN);
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, placement: 'widget' } });
  await host.clock.advance(20000);
  const rows = (await ui.findAll({ type: 'Text' })).map(row => row.text);
  expect(rows.slice(1)).toEqual(['Read failed', expect.stringMatching(/^Last good ·/), 'requests 1']);
  await host.clock.advance(10000);
  expect((await ui.findAll({ type: 'Text' })).map(row => row.text).slice(1)).toEqual(['requests 1']);
  await ui.unmount();
});

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
