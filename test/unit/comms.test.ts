import { describe, expect, it } from 'vitest';
import { checkFileAddress, MAX_ADDRESS_LENGTH } from '../../src/comms/address.js';

const SCHEME_HINT = 'factory runs on one machine: use a file:// address';

describe('file address', () => {
  it.each([
    ['a home folder', 'file:///home/owner/acme-factory', '/home/owner/acme-factory'],
    ['a trailing slash', 'file:///srv/nodes/web-factory/', '/srv/nodes/web-factory/'],
    ['a dot in a name', 'file:///srv/web.factory/a-b_c', '/srv/web.factory/a-b_c'],
  ])('accepts %s and returns the path', (_name, address, path) => {
    expect(checkFileAddress(address)).toEqual({ ok: true, value: path });
  });

  it.each([
    ['ssh', 'ssh://owner@host/srv/web-factory'],
    ['https', 'https://example.com/web-factory'],
    ['http', 'http://127.0.0.1/web-factory'],
    ['no scheme', '/srv/web-factory'],
    ['a relative path', 'acme/node'],
    ['an empty text', ''],
    ['a scheme in capitals', 'FILE:///srv/web-factory'],
    ['one slash only', 'file:/srv/web-factory'],
  ])('refuses %s and says that factory runs on one machine', (_name, address) => {
    expect(checkFileAddress(address)).toEqual({ ok: false, error: SCHEME_HINT });
  });

  it.each([
    ['a host', 'file://host/srv/web-factory', 'no host'],
    ['the name localhost', 'file://localhost/srv/web-factory', 'no host'],
    ['a relative path after the scheme', 'file://srv/web-factory', 'no host'],
    ['a .. segment', 'file:///srv/../etc', '..'],
    ['a .. segment at the end', 'file:///srv/web-factory/..', '..'],
    ['a percent sign', 'file:///srv/web%2Ffactory', '%'],
    ['a query', 'file:///srv/web-factory?x=1', 'query'],
    ['a fragment', 'file:///srv/web-factory#top', 'fragment'],
    ['a NUL character', 'file:///srv/web\0factory', 'control character'],
    ['a new line', 'file:///srv/web\nfactory', 'control character'],
  ])('refuses %s', (_name, address, reason) => {
    const checked = checkFileAddress(address);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error).toContain(reason);
  });

  it('keeps a name that only holds two dots', () => {
    expect(checkFileAddress('file:///srv/web..factory')).toEqual({ ok: true, value: '/srv/web..factory' });
  });

  it('refuses an address that is too long, and accepts the longest one', () => {
    const base = 'file:///';
    const longest = `${base}${'a'.repeat(MAX_ADDRESS_LENGTH - base.length)}`;
    expect(longest).toHaveLength(MAX_ADDRESS_LENGTH);
    expect(checkFileAddress(longest).ok).toBe(true);
    const tooLong = checkFileAddress(`${longest}a`);
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error).toContain(String(MAX_ADDRESS_LENGTH));
  });

  it('does not repeat the rejected address in the message', () => {
    const secret = 'sk-ant-api03-SECRETSECRET';
    for (const address of [`ssh://${secret}@host/x`, `file://${secret}/x`, `file:///x?${secret}`, `file:///x/..${secret}/../`]) {
      const checked = checkFileAddress(address);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.error).not.toContain('SECRET');
    }
  });
});
