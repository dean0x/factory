import { describe, expect, it } from 'vitest';
import { comparable } from '../../src/core/paths.js';
import { dotRuleReason, type NameCompare, type PlaceRule } from '../../src/core/place-rule.js';
import { projectFolderKey } from '../../src/core/project-path.js';
import { assignmentSource, files } from '../../src/names.js';
import { createFakeDeps } from '../helpers/fake-deps.js';

const [STATE, ORDERS] = assignmentSource.ordersParts;

/** The compare of the assignment check: the letter case counts as the platform says. */
const byPlatform = (os: string): NameCompare => {
  const deps = createFakeDeps({ os });
  return (a, b) => comparable(deps, a) === comparable(deps, b);
};

/** The compare of the doc rule: the letter case never counts, on any platform. */
const byFolderKey: NameCompare = (a, b) => projectFolderKey(a) === projectFolderKey(b);

const rule = (override: Partial<PlaceRule> = {}): PlaceRule => ({
  atFactoryTop: true,
  ordersException: true,
  sameName: byPlatform('linux'),
  ...override,
});

describe('the local config of the factory folder', () => {
  it('is refused at the top of the factory folder', () => {
    expect(dotRuleReason([files.localConfig], rule())).toContain('settings of one person');
  });

  it('is not refused below another folder, or when the top is not the factory folder', () => {
    expect(dotRuleReason(['docs', files.localConfig], rule())).toBeNull();
    expect(dotRuleReason([files.localConfig], rule({ atFactoryTop: false }))).toBeNull();
  });

  it('is refused in any letter case on a platform that ignores the case', () => {
    expect(dotRuleReason([files.localConfig.toUpperCase()], rule({ sameName: byPlatform('darwin') }))).toContain('settings of one person');
  });

  it('keeps the compare of the caller: a platform that counts the case lets a changed case pass', () => {
    expect(dotRuleReason([files.localConfig.toUpperCase()], rule({ sameName: byPlatform('linux') }))).toBeNull();
  });

  it('is refused in upper case and in mixed case by the folder key compare, also on a fake Linux platform', () => {
    const docRule = rule({ sameName: byFolderKey, ordersException: false });
    const mixed = `${files.localConfig.slice(0, 3).toUpperCase()}${files.localConfig.slice(3)}`;
    expect(byPlatform('linux')(files.localConfig.toUpperCase(), files.localConfig)).toBe(false);
    expect(dotRuleReason([files.localConfig.toUpperCase()], docRule)).toContain('settings of one person');
    expect(dotRuleReason([mixed], docRule)).toContain('settings of one person');
  });
});

describe('a part that starts with a dot', () => {
  it('is refused, and the reason names the part', () => {
    expect(dotRuleReason(['src', '.cache', 'task.md'], rule({ atFactoryTop: false }))).toBe('".cache" starts with a dot');
    expect(dotRuleReason(['.env'], rule({ atFactoryTop: false }))).toBe('".env" starts with a dot');
  });

  it('is refused below the state folder of the factory folder when the path is not in the orders folder', () => {
    expect(dotRuleReason([STATE, 'state', 'heartbeat.json'], rule())).toBe(`${JSON.stringify(STATE)} starts with a dot`);
  });

  it('lets a path with no dot part pass', () => {
    expect(dotRuleReason(['docs', 'plan.md'], rule())).toBeNull();
    expect(dotRuleReason(['docs', 'plan.md'], rule({ atFactoryTop: false, ordersException: false }))).toBeNull();
  });
});

describe('the orders folder below the factory folder', () => {
  const inOrders = [STATE, ORDERS, 'task.md'];

  it('passes when the orders exception is on', () => {
    expect(dotRuleReason(inOrders, rule({ ordersException: true }))).toBeNull();
    expect(dotRuleReason([STATE, ORDERS, 'sub', 'task.md'], rule())).toBeNull();
  });

  it('is refused when the orders exception is off, because its first part starts with a dot', () => {
    expect(dotRuleReason(inOrders, rule({ ordersException: false }))).toBe(`${JSON.stringify(STATE)} starts with a dot`);
  });

  it('is refused when the top is not the factory folder, with the orders exception on', () => {
    expect(dotRuleReason(inOrders, rule({ atFactoryTop: false }))).toContain('starts with a dot');
  });

  it('still refuses a dot part below the orders folder', () => {
    expect(dotRuleReason([STATE, ORDERS, '.hidden.md'], rule())).toBe('".hidden.md" starts with a dot');
  });

  it('is found by the compare of the caller: the case of the orders parts counts as the platform says', () => {
    const upper = [STATE.toUpperCase(), ORDERS.toUpperCase(), 'task.md'];
    expect(dotRuleReason(upper, rule({ sameName: byPlatform('darwin') }))).toBeNull();
    expect(dotRuleReason(upper, rule({ sameName: byPlatform('linux') }))).toContain('starts with a dot');
  });
});
