import { describe, expect, it } from 'vitest';
import type { CliError } from '../../src/cli/errors.js';
import { maxSetupTextBytes } from '../../src/names.js';
import { readSetupFile, readSetupTexts, renderableSetupText } from '../../src/state/setup-text.js';
import { layoutOf } from '../../src/state/layout.js';
import { createFakeDeps } from '../helpers/fake-deps.js';

const ROOT = '/w/acme';
const layout = layoutOf(ROOT);

const failureOf = (result: { readonly ok: boolean; readonly error?: CliError }): CliError => {
  if (result.ok || result.error === undefined) throw new Error('expected a refusal');
  return result.error;
};

describe('renderableSetupText', () => {
  it('gives null for an absent text, an empty text and a text of white space only', () => {
    expect(renderableSetupText(null)).toBeNull();
    expect(renderableSetupText('')).toBeNull();
    expect(renderableSetupText(' \n\t\n')).toBeNull();
  });

  it('gives the text as it is when it holds a word', () => {
    expect(renderableSetupText('Be kind.\n')).toBe('Be kind.\n');
  });
});

describe('readSetupFile', () => {
  const read = (deps: ReturnType<typeof createFakeDeps>) => readSetupFile(deps, layout, layout.setupCoordinatorFile);

  it('gives null for a file that is absent', async () => {
    expect(await read(createFakeDeps())).toEqual({ ok: true, value: null });
  });

  it('gives the text of a plain file, with LF line ends', async () => {
    const deps = createFakeDeps();
    deps.seed(layout.setupCoordinatorFile, 'One.\r\nTwo.\rThree.\n');
    expect(await read(deps)).toEqual({ ok: true, value: 'One.\nTwo.\nThree.\n' });
  });

  it('keeps a tab and a line end, which plain text holds', async () => {
    const deps = createFakeDeps();
    deps.seed(layout.setupCoordinatorFile, 'A\tB\n');
    expect(await read(deps)).toEqual({ ok: true, value: 'A\tB\n' });
  });

  it('refuses a folder in place of the file, with exit 1 and a remedy', async () => {
    const deps = createFakeDeps();
    deps.seedDir(layout.setupCoordinatorFile);
    const error = failureOf(await read(deps));
    expect(error.kind).toBe('failure');
    expect(error.message).toBe('setup/coordinator.md is not a file');
    expect(error.hint).toBe('Move it away, then run the command again.');
  });

  it('refuses a file over the byte bound, and names the bound', async () => {
    const deps = createFakeDeps();
    deps.seed(layout.setupCoordinatorFile, 'x'.repeat(maxSetupTextBytes + 1));
    const error = failureOf(await read(deps));
    expect(error.kind).toBe('failure');
    expect(error.message).toBe(`setup/coordinator.md is larger than ${maxSetupTextBytes} bytes`);
    expect(error.hint).toContain('Shorten setup/coordinator.md');
  });

  it('accepts a file of exactly the byte bound', async () => {
    const deps = createFakeDeps();
    deps.seed(layout.setupCoordinatorFile, 'x'.repeat(maxSetupTextBytes));
    expect((await read(deps)).ok).toBe(true);
  });

  it.each([
    ['a null byte', 'a\u0000b'],
    ['an escape character', 'a\u001b[31mred'],
    ['a delete character', 'a\u007fb'],
    ['a form feed', 'a\u000cb'],
  ])('refuses %s, because the file is not plain text', async (_name, text) => {
    const deps = createFakeDeps();
    deps.seed(layout.setupCoordinatorFile, text);
    const error = failureOf(await read(deps));
    expect(error.kind).toBe('failure');
    expect(error.message).toBe('setup/coordinator.md is not plain text: it holds a control character');
    expect(error.hint).toContain('Remove the control characters');
  });

  it.each([
    ['a begin marker', '<!-- factory:begin coordinator v1 sha256=abc -->\n'],
    ['an end marker', 'Text.\n<!-- factory:end coordinator -->\n'],
  ])('refuses %s, because it would break the block that holds the text', async (_name, text) => {
    const deps = createFakeDeps();
    deps.seed(layout.setupCoordinatorFile, text);
    const error = failureOf(await read(deps));
    expect(error.kind).toBe('failure');
    expect(error.message).toBe('setup/coordinator.md holds a line that starts a managed block');
    expect(error.hint).toContain('Remove the marker lines');
  });

  it('accepts a comment that is not a marker of a block', async () => {
    const deps = createFakeDeps();
    deps.seed(layout.setupCoordinatorFile, '<!-- Write your own text here. -->\n');
    expect((await read(deps)).ok).toBe(true);
  });

  it('stops with exit 4 for a link, and reads nothing', async () => {
    const deps = createFakeDeps({ links: { [layout.setupCoordinatorFile]: '/outside/notes.md' } });
    deps.seed(layout.setupCoordinatorFile, 'Text.\n');
    const error = failureOf(await read(deps));
    expect(error.kind).toBe('safety');
    expect(error.message).toBe('setup/coordinator.md is a link, so factory does not use it');
  });
});

describe('readSetupTexts', () => {
  it('gives null for both texts of a factory folder with no setup folder', async () => {
    expect(await readSetupTexts(createFakeDeps(), layout)).toEqual({ ok: true, value: { coordinator: null, worker: null } });
  });

  it('gives each text from its own file', async () => {
    const deps = createFakeDeps();
    deps.seed(layout.setupCoordinatorFile, 'For the coordinator.\n');
    deps.seed(layout.setupWorkerFile, 'For every worker.\n');
    expect(await readSetupTexts(deps, layout)).toEqual({
      ok: true,
      value: { coordinator: 'For the coordinator.\n', worker: 'For every worker.\n' },
    });
  });

  it('gives null for a file that holds white space only, so that no block is rendered', async () => {
    const deps = createFakeDeps();
    deps.seed(layout.setupCoordinatorFile, '\n\n');
    deps.seed(layout.setupWorkerFile, '');
    expect(await readSetupTexts(deps, layout)).toEqual({ ok: true, value: { coordinator: null, worker: null } });
  });

  it('gives null for the worker text when only the coordinator text is there, and the other way round', async () => {
    const onlyCoordinator = createFakeDeps();
    onlyCoordinator.seed(layout.setupCoordinatorFile, 'A.\n');
    expect(await readSetupTexts(onlyCoordinator, layout)).toEqual({ ok: true, value: { coordinator: 'A.\n', worker: null } });
    const onlyWorker = createFakeDeps();
    onlyWorker.seed(layout.setupWorkerFile, 'B.\n');
    expect(await readSetupTexts(onlyWorker, layout)).toEqual({ ok: true, value: { coordinator: null, worker: 'B.\n' } });
  });

  it('names the worker file when it holds a marker', async () => {
    const deps = createFakeDeps();
    deps.seed(layout.setupCoordinatorFile, 'Fine.\n');
    deps.seed(layout.setupWorkerFile, '<!-- factory:begin worker v1 sha256=abc -->\n');
    const error = failureOf(await readSetupTexts(deps, layout));
    expect(error.message).toBe('setup/roles/worker.md holds a line that starts a managed block');
  });

  it('stops with exit 4 when the roles folder of the setup is a link', async () => {
    const deps = createFakeDeps({ links: { [layout.setupRolesDir]: '/outside/roles' } });
    deps.seed(layout.setupWorkerFile, 'B.\n');
    const error = failureOf(await readSetupTexts(deps, layout));
    expect(error.kind).toBe('safety');
    expect(error.message).toBe('setup/roles is a link, so factory does not use it');
  });
});
