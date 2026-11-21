import { assignmentSource, files } from '../names.js';

/** True when two path names are one name. The caller picks the rule of the letter case. */
export type NameCompare = (a: string, b: string) => boolean;

/**
 * How the place rule reads the names of a path.
 * - `atFactoryTop`: the names start below the factory folder. Only there is the local config refused.
 * - `ordersException`: the orders folder below the factory folder may start with a dot. Only the assignment check sets it.
 * - `sameName`: the compare of one name with a fixed name.
 */
export interface PlaceRule {
  readonly atFactoryTop: boolean;
  readonly ordersException: boolean;
  readonly sameName: NameCompare;
}

/**
 * The reason that the names of a path name the local config at the top of the factory folder, or null. The local config holds the
 * owner prefix, so a caller that copies a file for another session refuses it with every guard value.
 */
export const localConfigReason = (names: readonly string[], rule: Pick<PlaceRule, 'atFactoryTop' | 'sameName'>): string | null => {
  const [first] = names;
  return rule.atFactoryTop && names.length === 1 && first !== undefined && rule.sameName(first, files.localConfig)
    ? `${files.localConfig} holds the settings of one person on one machine`
    : null;
};

/**
 * The reason that the names of a path refuse, or null when the fixed rule lets them pass. The names are the parts of the path from its
 * top down to the file. The rule refuses the local config at the top of the factory folder, and a part that starts with a dot, except
 * the orders folder below the factory folder when the exception is on. Each caller picks the exit code of its refusal.
 */
export const dotRuleReason = (names: readonly string[], rule: PlaceRule): string | null => {
  const local = localConfigReason(names, rule);
  if (local !== null) return local;
  const { atFactoryTop, ordersException, sameName } = rule;
  const orders = assignmentSource.ordersParts;
  const inOrders =
    atFactoryTop && ordersException && names.length > orders.length && orders.every((part, index) => sameName(names[index] ?? '', part));
  const hidden = names.slice(inOrders ? orders.length : 0).find((name) => name.startsWith(assignmentSource.dotMark));
  return hidden === undefined ? null : `${JSON.stringify(hidden)} starts with a dot`;
};
