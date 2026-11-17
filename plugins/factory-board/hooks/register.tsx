import { atom, read, update } from 'claude-code';
import type { Register, SessionUsage, Timer } from 'claude-code';
import type { BoardLines } from '../types';

const PANE = 'factory-board';
const MIN_WIDTH = 40;
const MAX_WIDTH = 120;
const MAX_LINES = 400;
const MAX_OUTPUT = 4194304;
const lines = atom({ plugin: 'factory-board', key: 'lines' } as const, [] as BoardLines, { shape: 'board-lines-1' });
const fault = atom({ plugin: 'factory-board', key: 'fault' } as const, null);
const ranAt = atom({ plugin: 'factory-board', key: 'ranAt' } as const, null);
const columns = atom({ plugin: 'factory-board', key: 'columns' } as const, 100);
const running = atom({ plugin: 'factory-board', key: 'running' } as const, false);

type BoardRead = { readonly ok: true; readonly lines: BoardLines } | { readonly ok: false; readonly error: string };
const held = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;

// Process text is data, not terminal markup. Remove escape sequences and controls.
const plain = (text: string): string => text
  .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\|$)/g, '')
  .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu, '');
const clipped = (text: string, width: number): string => Array.from(plain(text)).slice(0, width).join('');

const parseOutput = (value: unknown, width: number): BoardRead => {
  if (value === null || typeof value !== 'object' || !('exitCode' in value) || !('stdout' in value) || !('stderr' in value)
    || typeof value.exitCode !== 'number' || !Number.isInteger(value.exitCode) || value.exitCode < 0
    || typeof value.stdout !== 'string' || typeof value.stderr !== 'string'
    || value.stdout.length > MAX_OUTPUT || value.stderr.length > MAX_OUTPUT
    || !('isStdoutTruncated' in value) || typeof value.isStdoutTruncated !== 'boolean'
    || !('isStderrTruncated' in value) || typeof value.isStderrTruncated !== 'boolean') {
    return { ok: false, error: 'Factory returned invalid output.' };
  }
  if (value.exitCode !== 0) {
    return { ok: false, error: clipped(value.stderr.split('\n', 1)[0] ?? '', width) || `Factory exited with code ${value.exitCode}.` };
  }
  if (value.isStdoutTruncated) return { ok: false, error: 'Factory output was cut. Last good text stays below.' };
  const rows = value.stdout.replace(/\r\n/g, '\n').split('\n', MAX_LINES + 1).slice(0, MAX_LINES);
  return { ok: true, lines: (rows[rows.length - 1] === '' ? rows.slice(0, -1) : rows).map(row => clipped(row, width)) };
};

const failureOf = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  return /ENOENT|not found/i.test(message)
    ? 'Factory command not found. Set the command option.'
    : 'Factory command failed or timed out.';
};
const timeOf = (iso: string | null): string => iso === null ? '?' : iso.slice(11, 19);
const percentOf = (percent: number | undefined): string => percent === undefined ? '?' : `${Math.round(percent)}%`;
const headerOf = (usage: SessionUsage, at: string | null): string => {
  const limit = (kind: string) => percentOf(usage.rateLimits.find(row => row.kind === kind)?.percentUsed);
  return `context ${percentOf(usage.context.percent)} · 5h ${limit('five_hour')} · 7d ${limit('seven_day')} · updated ${timeOf(at)}`;
};
const requestCount = (rows: BoardLines): string => {
  const heading = rows.indexOf('Requests');
  const summary = heading < 0 ? '' : rows[heading + 1] ?? '';
  // Read the command's summary, not its table headings or its capped rows.
  return /^(\d+) open requests?\.$/.exec(summary)?.[1] ?? (/^No open requests\.$/.test(summary) ? '0' : '?');
};

export const register: Register = (on, options) => {
  const interval = held(options.refreshSeconds, 5, 300, 10) * 1000;
  const command = typeof options.command === 'string' && options.command.trim() !== '' ? options.command : 'factory';
  const home = typeof options.home === 'string' ? options.home : '';
  let timer: Timer | undefined;
  let busy = false;
  let session = 0;
  let bodyColumns = 100;

  on('session.start', async ($, e, next) => {
    timer?.cancel();
    const currentSession = ++session;
    await update($, running, () => false);
    await $.command.register({ name: 'board', description: 'Show the factory board in a pane' });
    if (options.open === 'auto') await $.ui.open({ id: PANE, title: 'Factory board' });
    timer = $.clock.every(interval, async () => {
      // Claim before the first await, so two timer callbacks cannot start a run.
      if (busy || currentSession !== session) return;
      busy = true;
      try {
        const visible = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown && pane.isPlaced);
        if (!visible || currentSession !== session) return;
        const width = held(bodyColumns, MIN_WIDTH, MAX_WIDTH, 100);
        await update($, columns, () => width);
        await update($, running, () => true);
        if (currentSession !== session) return;
        if (command.includes('/') && !command.startsWith('/')) {
          await update($, fault, () => 'Factory command not found. Set the command option.');
          return;
        }
        let result: BoardRead;
        try {
          const output: unknown = await $.process.run([
            command, 'board', '--width', String(width), ...(home === '' ? [] : ['--home', home]),
          ], { timeoutMs: Math.min(interval, 30000) });
          result = parseOutput(output, width);
        } catch (error: unknown) {
          result = { ok: false, error: failureOf(error) };
        }
        if (currentSession !== session) return;
        if (result.ok) {
          const time = new Date(await $.clock.now()).toISOString();
          if (currentSession !== session) return;
          await update($, lines, () => result.lines);
          await update($, ranAt, () => time);
        }
        await update($, fault, () => result.ok ? null : result.error);
      } finally {
        busy = false;
        await update($, running, () => false);
      }
    });
    return next(e);
  });
  on('session.end', async ($, e, next) => {
    session += 1;
    timer?.cancel();
    await update($, running, () => false);
    return next(e);
  });
  on('command.run', { command: 'board' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Factory board' });
    return { text: opened.isPlaced ? 'Factory board pane opened.' : 'Factory board pane waits for a surface.' };
  });
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    // A render cannot write state. The next tick saves the last observed width.
    bodyColumns = held(e.props.bodyColumns, MIN_WIDTH, MAX_WIDTH, 100);
    const [rows, error, at, usage] = await Promise.all([read($, lines), read($, fault), read($, ranAt), $.session.usage()]);
    const header = headerOf(usage, at);
    return <Box flexDirection="column" overflowX="scroll">
      <Text>{header}</Text>
      {error !== null && <Text>{error}</Text>}
      {error !== null && at !== null && <Text>Last good · {timeOf(at)}</Text>}
      {e.props.placement === 'widget' ? <Text>requests {requestCount(rows)}</Text> : rows.map(row => <Text>{row}</Text>)}
    </Box>;
  });
};
