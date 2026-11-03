import { address } from '../names.js';
import { err, ok, type Result } from './result.js';

/** The most characters of a clone URL, a project path or a local source. */
export const MAX_CLONE_URL_CHARS = 2048;

const USER = '[A-Za-z0-9_][A-Za-z0-9._-]*';
const HOST = '[A-Za-z0-9][A-Za-z0-9.-]*';
const PORT = '(:\\d{1,5})?';
const URL_PATH = '[A-Za-z0-9._~%+/-]+';
const HTTPS_URL = new RegExp(`^https://(${HOST})${PORT}/(${URL_PATH})$`);
const SSH_URL = new RegExp(`^ssh://(?:(${USER})@)?(${HOST})${PORT}/(${URL_PATH})$`);
const SCP_URL = new RegExp(`^(${USER})@(${HOST}):(${URL_PATH})$`);
const FILE_URL = new RegExp(`^${address.scheme}(?:localhost)?(/${URL_PATH})$`);
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
/** The form of a git transport helper, such as `ext::command`. Git runs the helper, so no scheme of this form is allowed. */
const TRANSPORT_HELPER = /^[A-Za-z][A-Za-z0-9+.-]*::/;
/** A value with a colon before its first @ and no slash before it, such as user:secret@host:path. */
const COLON_IN_USER = /^([^\s/@:]+):[^\s/@]*@/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const GIT_SUFFIX = '.git';

/**
 * Why a value is not a clone URL. The reason names the rule and never holds the value, because a value can hold a
 * password or a token.
 */
export type CloneIssue = 'too-long' | 'hyphen' | 'credentials' | 'scheme' | 'form' | 'not-local';

/** A repo on a host: an https URL, an ssh URL or the scp form. The host can share it. */
export interface RemoteUrl {
  readonly kind: 'remote';
  readonly url: string;
  /** The last part of the path without the git suffix. */
  readonly name: string;
  /** The host in lower case, the port, and the path without the git suffix and without slashes at the ends. */
  readonly normal: string;
}

/** A file URL. It names a folder of this machine. */
export interface FileUrl {
  readonly kind: 'file';
  readonly url: string;
  readonly path: string;
  readonly name: string;
}

/** A value that is no URL: a path of this machine. */
export interface LocalPath {
  readonly kind: 'local';
  readonly path: string;
  readonly absolute: boolean;
}

export type CloneTarget = RemoteUrl | FileUrl | LocalPath;

const reasons: Readonly<Record<CloneIssue, string>> = {
  'too-long': `The value has more than ${MAX_CLONE_URL_CHARS} characters.`,
  hyphen: 'The value starts with a hyphen, so a program could read it as an option.',
  credentials: 'The URL holds a user name, a password or a token.',
  scheme: 'The scheme of the URL is not allowed.',
  form: 'The form of the value is not allowed.',
  'not-local': 'The value is a URL of a host. A local source is a file URL or an absolute path.',
};

/** What a person can do about a refused URL. */
export const CLONE_URL_REMEDY = 'Use an https URL with no user name, or an ssh URL.';

/** The reason, as a sentence. */
export const cloneIssueReason = (issue: CloneIssue): string => reasons[issue];

/** The reason, and for a URL with credentials or a scheme that is not allowed also the fix. A config error has no hint line. */
export const describeCloneIssue = (issue: CloneIssue): string =>
  issue === 'credentials' || issue === 'scheme' ? `${reasons[issue]} ${CLONE_URL_REMEDY}` : reasons[issue];

const segmentsOf = (path: string): readonly string[] => path.split('/').filter((part) => part !== '');

const nameOf = (segments: readonly string[]): string => {
  const last = segments.at(-1) ?? '';
  return last.endsWith(GIT_SUFFIX) ? last.slice(0, -GIT_SUFFIX.length) : last;
};

const remoteOf = (url: string, host: string, port: string | undefined, path: string): Result<RemoteUrl, CloneIssue> => {
  const segments = segmentsOf(path);
  if (segments.includes('..')) return err('form');
  const name = nameOf(segments);
  const kept = [...segments.slice(0, -1), name].filter((part) => part !== '');
  return ok({ kind: 'remote', url, name, normal: `${host.toLowerCase()}${port ?? ''}/${kept.join('/')}` });
};

const fileOf = (url: string, path: string): Result<FileUrl, CloneIssue> => {
  const segments = segmentsOf(path);
  return segments.includes('..') ? err('form') : ok({ kind: 'file', url, path, name: nameOf(segments) });
};

/** The part of a URL between the scheme and the first slash: the user information, the host and the port. */
const authorityOf = (text: string, schemeLength: number): string => text.slice(schemeLength).split('/', 1)[0] ?? '';

const parseSchemeUrl = (text: string, scheme: string, schemeLength: number): Result<RemoteUrl | FileUrl, CloneIssue> => {
  const authority = authorityOf(text, schemeLength);
  switch (scheme) {
    case 'https': {
      if (authority.includes('@')) return err('credentials');
      if (authority.startsWith('-')) return err('hyphen');
      const match = HTTPS_URL.exec(text);
      return match === null ? err('form') : remoteOf(text, match[1] ?? '', match[2], match[3] ?? '');
    }
    case 'ssh': {
      const at = authority.lastIndexOf('@');
      if (at >= 0 && authority.slice(0, at).includes(':')) return err('credentials');
      if (authority.startsWith('-')) return err('hyphen');
      const match = SSH_URL.exec(text);
      return match === null ? err('form') : remoteOf(text, match[2] ?? '', match[3], match[4] ?? '');
    }
    case 'file': {
      const match = FILE_URL.exec(text);
      return match === null ? err('form') : fileOf(text, match[1] ?? '');
    }
    default:
      return err('scheme');
  }
};

/**
 * Read a value as a clone URL or as a path of this machine. The accepted URL forms are https, ssh, the scp form
 * `user@host:path` and file. An https URL has no user name. A password, a token or a secret part in any URL form is
 * refused. A value with a hyphen at its start is refused, so a URL can never act as an option of git or ssh.
 * A value that is no URL is a local path, absolute or relative.
 */
export const parseCloneUrl = (text: string): Result<CloneTarget, CloneIssue> => {
  if (text.length > MAX_CLONE_URL_CHARS) return err('too-long');
  if (text.startsWith('-')) return err('hyphen');
  if (CONTROL_CHARACTER.test(text)) return err('form');
  if (text.startsWith('/')) return ok({ kind: 'local', path: text, absolute: true });
  const scheme = SCHEME.exec(text);
  if (scheme !== null) return parseSchemeUrl(text, (scheme[1] ?? '').toLowerCase(), scheme[0].length);
  if (TRANSPORT_HELPER.test(text)) return err('scheme');
  if (COLON_IN_USER.test(text)) return err('credentials');
  const scp = SCP_URL.exec(text);
  if (scp !== null) return remoteOf(text, scp[2] ?? '', undefined, scp[3] ?? '');
  return ok({ kind: 'local', path: text, absolute: false });
};

/** A path of this machine in a config file is absolute and has no `..` segment. */
const checkedPath = (target: LocalPath): Result<LocalPath, CloneIssue> =>
  target.absolute && !segmentsOf(target.path).includes('..') ? ok(target) : err('form');

/**
 * The value of the `url` key of a project: a URL of a host, a file URL or an absolute path. A file URL and a path
 * work on this machine only, so a project with one of them can not be shared.
 */
export const checkProjectUrl = (text: string): Result<CloneTarget, CloneIssue> => {
  const parsed = parseCloneUrl(text);
  if (!parsed.ok) return parsed;
  return parsed.value.kind === 'local' ? checkedPath(parsed.value) : parsed;
};

/** The value of a local source: a file URL or an absolute path. A URL of a host is no local source. */
export const checkLocalSource = (text: string): Result<FileUrl | LocalPath, CloneIssue> => {
  const parsed = parseCloneUrl(text);
  if (!parsed.ok) return parsed;
  if (parsed.value.kind === 'remote') return err('not-local');
  return parsed.value.kind === 'local' ? checkedPath(parsed.value) : ok(parsed.value);
};

/** True when the name is one plain folder name, so a clone of the repo makes a folder with that name. */
export const isPlainRepoName = (name: string): boolean => NAME_PATTERN.test(name) && !name.includes('..');

/**
 * The form that tells whether two values name one repo. The host is in lower case, and the user name, the git suffix
 * and the slashes at the ends are gone. The scp form, `ssh://` and `https://` of one repo give one form.
 */
export const normalFormOf = (target: CloneTarget): string =>
  target.kind === 'remote' ? target.normal : `${address.scheme}${segmentsOf(target.path).join('/')}`;

interface Stripped {
  readonly text: string;
  readonly removed: boolean;
}

/**
 * The value without the secret part of its user information. An https URL loses the whole user information.
 * An ssh URL and the scp form keep the user name, because ssh needs it, and lose what follows the colon.
 */
const withoutSecret = (text: string): Stripped => {
  const unchanged = { text, removed: false };
  const scheme = SCHEME.exec(text);
  if (scheme === null) {
    const scp = COLON_IN_USER.exec(text);
    return scp === null ? unchanged : { text: `${scp[1] ?? ''}@${text.slice(scp[0].length)}`, removed: true };
  }
  const rest = text.slice(scheme[0].length);
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const tail = slash < 0 ? '' : rest.slice(slash);
  const at = authority.lastIndexOf('@');
  if (at < 0) return unchanged;
  const host = authority.slice(at + 1);
  const userinfo = authority.slice(0, at);
  switch ((scheme[1] ?? '').toLowerCase()) {
    case 'https':
      return { text: `${scheme[0]}${host}${tail}`, removed: true };
    case 'ssh': {
      const user = userinfo.split(':', 1)[0] ?? '';
      return user === userinfo ? unchanged : { text: `${scheme[0]}${user === '' ? '' : `${user}@`}${host}${tail}`, removed: true };
    }
    default:
      return unchanged;
  }
};

/** What a repo origin is, for the `url` key of a project. */
export type OriginClass =
  /** A URL of a host that the config can hold. `credentialsRemoved` is true when the origin held a secret. */
  | { readonly kind: 'shareable'; readonly url: string; readonly credentialsRemoved: boolean }
  /** A file URL: a local source. */
  | { readonly kind: 'file'; readonly url: string }
  /** No origin, a local path, or a value that the rules refuse. The repo can not be shared. */
  | { readonly kind: 'other' };

/** Sort the origin of a repo. The secret part of an origin never reaches the result. */
export const classifyOrigin = (origin: string | null): OriginClass => {
  const stripped = withoutSecret((origin ?? '').trim());
  const parsed = parseCloneUrl(stripped.text);
  if (!parsed.ok) return { kind: 'other' };
  if (parsed.value.kind === 'remote') {
    return { kind: 'shareable', url: parsed.value.url, credentialsRemoved: stripped.removed };
  }
  return parsed.value.kind === 'file' ? { kind: 'file', url: parsed.value.url } : { kind: 'other' };
};
