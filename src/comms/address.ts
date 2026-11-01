import { err, ok, type Result } from '../core/result.js';
import { address, program } from '../names.js';

export const MAX_ADDRESS_LENGTH = 4096;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * Check the address of another node. The only form is `file://` and an absolute path on this machine (F-13).
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
