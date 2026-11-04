import { fileTransport as fileTransportOf } from '../../src/comms/transport.js';
import { runDoctor as runDoctorOf, checkChildren as checkChildrenOf } from '../../src/commands/doctor.js';
import { planInit as planInitOf, runInit as runInitOf } from '../../src/commands/init.js';
import { runNode as runNodeOf } from '../../src/commands/node.js';
import { runStart as runStartOf } from '../../src/commands/start.js';
import { runUpgrade as runUpgradeOf } from '../../src/commands/upgrade.js';
import {
  inspectConfig as inspectConfigOf,
  inspectSharedConfig as inspectSharedConfigOf,
  loadConfig as loadConfigOf,
  parseConfigTexts as parseConfigTextsOf,
  readNodeIdentity as readNodeIdentityOf,
} from '../../src/config/load.js';
import { parseConfig as parseConfigOf, sharedConfigSchemaFor } from '../../src/config/schema.js';
import { recipes, type RecipeRegistry } from '../../src/recipes/index.js';
import { specFor } from '../../src/upgrade/spec.js';
import type { UpgradeSpec } from '../../src/upgrade/spec.js';

/**
 * The commands and the config readers of the package, bound to the registry of the package. The commands take the registry as
 * a parameter; a test that checks the behavior of the package imports these names, and a test that checks another registry
 * imports the commands from `src` and passes its own registry.
 */
const withPackageRecipes =
  <Args extends readonly unknown[], Result>(run: (...args: [...Args, RecipeRegistry]) => Result) =>
  (...args: Args): Result =>
    run(...args, recipes);

export const runInit = withPackageRecipes(runInitOf);
export const planInit = withPackageRecipes(planInitOf);
export const runStart = withPackageRecipes(runStartOf);
export const runDoctor = withPackageRecipes(runDoctorOf);
export const runNode = withPackageRecipes(runNodeOf);
export const checkChildren = withPackageRecipes(checkChildrenOf);
export const fileTransport = withPackageRecipes(fileTransportOf);
export const loadConfig = withPackageRecipes(loadConfigOf);
export const inspectConfig = withPackageRecipes(inspectConfigOf);
export const inspectSharedConfig = withPackageRecipes(inspectSharedConfigOf);
export const readNodeIdentity = withPackageRecipes(readNodeIdentityOf);
export const parseConfigTexts = withPackageRecipes(parseConfigTextsOf);
export const parseConfig = withPackageRecipes(parseConfigOf);

/** The upgrade of the package. A test can pass another spec to replace a file handler. */
export const runUpgrade = (
  ...args: [deps: Parameters<typeof runUpgradeOf>[0], options: Parameters<typeof runUpgradeOf>[1], upgrade?: UpgradeSpec]
): ReturnType<typeof runUpgradeOf> => runUpgradeOf(args[0], args[1], recipes, args[2]);

export const sharedConfigSchema = sharedConfigSchemaFor(recipes);
export const currentSpec = specFor(recipes);
