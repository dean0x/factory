declare const __FACTORY_VERSION__: string;
declare const __FACTORY_COMMIT__: string | null;
declare const __FACTORY_MODIFIED__: boolean | null;

/** What the build of this program was made from. The build writes the values; a build outside a git work tree has no commit. */
export interface BuildInfo {
  /** The package version. */
  readonly version: string;
  /** The full id of the commit of the build, or null when it is not known. */
  readonly commit: string | null;
  /** True when tracked files had changes that were not committed at the build. Null when the commit is not known. */
  readonly modified: boolean | null;
}

const COMMIT_ID = /^[0-9a-f]{40}$/;

export const FACTORY_VERSION: string = __FACTORY_VERSION__;

/** The build values, checked: a commit that is not 40 lower-case hex characters counts as not known. */
export const buildInfoOf = (version: string, commit: unknown, modified: unknown): BuildInfo =>
  typeof commit === 'string' && COMMIT_ID.test(commit)
    ? { version, commit, modified: typeof modified === 'boolean' ? modified : null }
    : { version, commit: null, modified: null };

export const FACTORY_BUILD: BuildInfo = buildInfoOf(__FACTORY_VERSION__, __FACTORY_COMMIT__, __FACTORY_MODIFIED__);
