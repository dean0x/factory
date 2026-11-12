import { describe, expect, it } from 'vitest';
import { accessFaultOf } from '../../src/core/access.js';
import type { PathInfo } from '../../src/core/deps.js';
import { createFakeDeps } from '../helpers/fake-deps.js';

const info = (change: Partial<PathInfo> = {}): PathInfo => ({ kind: 'file', uid: 1000, mode: 0o600, mtimeMs: 0, size: 0, ...change });

describe('access fault of a path', () => {
  it('is none for a path of this user that only the user can write', () => {
    expect(accessFaultOf(createFakeDeps({ uid: 1000 }), info({ mode: 0o644 }))).toBeNull();
  });

  it('is the other owner for a path of another user', () => {
    expect(accessFaultOf(createFakeDeps({ uid: 1000 }), info({ uid: 0 }))).toBe('otherOwner');
  });

  it.each([0o620, 0o602, 0o660, 0o666])('is writable by others for the mode %s', (mode) => {
    expect(accessFaultOf(createFakeDeps({ uid: 1000 }), info({ mode }))).toBe('writableByOthers');
  });

  it('checks the mode and not the owner on a platform with no user ids', () => {
    const deps = createFakeDeps({ uid: null });
    expect(accessFaultOf(deps, info({ uid: 0 }))).toBeNull();
    expect(accessFaultOf(deps, info({ uid: 0, mode: 0o660 }))).toBe('writableByOthers');
  });

  it('names the owner first when both faults hold', () => {
    expect(accessFaultOf(createFakeDeps({ uid: 1000 }), info({ uid: 0, mode: 0o666 }))).toBe('otherOwner');
  });
});
