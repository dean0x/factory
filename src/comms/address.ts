import { resolve } from 'node:path';
import { err, ok, type Result } from '../core/result.js';
import { address, places, program } from '../names.js';

export const MAX_ADDRESS_LENGTH = 4096;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * Check the address of another node. The only form is `file://` and an absolute path on this machine.
 * The result is the path. An error names the broken rule and never repeats the address.
 */
export const checkFileAddress = (value: string): Result<string, string> => {
  if (!value.startsWith(address.scheme)) return err(`${program} runs on one machine: use a ${address.scheme} address`);
  if (value.length > MAX_ADDRESS_LENGTH) return err(`an address has at most ${MAX_ADDRESS_LENGTH} characters`);
  const path = value.slice(address.scheme.length);
  if (CONTROL_CHARACTER.test(path)) return err('an address must not hold a control character');
  if (path.includes('%')) return err('an address must not hold a percent sign (%)');
  if (path.includes('?')) return err('an address must not hold a query');
  if (path.includes('#')) return err('an address must not hold a fragment');
  if (!path.startsWith('/')) {
    return err(`an address has no host: write ${address.scheme} and an absolute path`);
  }
  if (path.split('/').includes('..')) return err('an address must not hold a .. segment');
  return ok(path);
};

/** The start of any URL, for example `ssh://`. A text that starts so is an address, not a path. */
const SCHEME_START = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

export interface ChildTarget {
  /** The `file://` address that the config holds. */
  readonly address: string;
  /** The absolute path of the node home, with no `.` or `..` part and no trailing slash. */
  readonly path: string;
}

/**
 * A node as a person types it: a `file://` address, or a path that may be relative to the current folder.
 * The result holds the clean path and the address for it. Any other kind of address is refused.
 */
export const childTarget = (cwd: string, argument: string): Result<ChildTarget, string> => {
  if (argument === '') return err(`the path of the ${places.folder} is empty`);
  const typed = SCHEME_START.test(argument) ? checkFileAddress(argument) : ok(argument);
  if (!typed.ok) return typed;
  const path = resolve(cwd, typed.value);
  const built = `${address.scheme}${path}`;
  const checked = checkFileAddress(built);
  return checked.ok ? ok({ address: built, path }) : checked;
};
