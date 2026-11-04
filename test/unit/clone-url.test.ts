import { describe, expect, it } from 'vitest';
import {
  checkLocalSource,
  checkProjectUrl,
  classifyOrigin,
  describeCloneIssue,
  isPlainRepoName,
  MAX_CLONE_URL_CHARS,
  normalFormOf,
  parseCloneUrl,
  type CloneIssue,
  type CloneTarget,
} from '../../src/core/clone-url.js';

const targetOf = (text: string): CloneTarget => {
  const parsed = parseCloneUrl(text);
  if (!parsed.ok) throw new Error(`expected a clone URL, got ${parsed.error}`);
  return parsed.value;
};

const issueOf = (text: string): CloneIssue | null => {
  const parsed = parseCloneUrl(text);
  return parsed.ok ? null : parsed.error;
};

describe('parseCloneUrl: the forms that are accepted', () => {
  it.each([
    ['https://github.com/acme/web.git', 'web'],
    ['https://github.com/acme/web', 'web'],
    ['https://host:8443/acme/web.git', 'web'],
    ['ssh://git@github.com/acme/web.git', 'web'],
    ['ssh://github.com/acme/web.git', 'web'],
    ['ssh://git@host:2222/acme/web', 'web'],
    ['git@github.com:acme/web.git', 'web'],
    ['git@host.example:acme/web', 'web'],
  ])('reads %s as a remote URL with the repo name %s', (text, name) => {
    expect(targetOf(text)).toMatchObject({ kind: 'remote', url: text, name });
  });

  it('reads a file URL, with or without the word localhost', () => {
    expect(targetOf('file:///srv/acme/web.git')).toMatchObject({ kind: 'file', path: '/srv/acme/web.git', name: 'web' });
    expect(targetOf('file://localhost/srv/acme/web')).toMatchObject({ kind: 'file', path: '/srv/acme/web' });
  });

  it('reads a value that is no URL as a local path, and tells an absolute path from a relative one', () => {
    expect(targetOf('/w/web')).toEqual({ kind: 'local', path: '/w/web', absolute: true });
    expect(targetOf('../web')).toEqual({ kind: 'local', path: '../web', absolute: false });
    expect(targetOf('/w/odd:name@x')).toEqual({ kind: 'local', path: '/w/odd:name@x', absolute: true });
    expect(targetOf('/w/My Tool')).toMatchObject({ kind: 'local', absolute: true });
  });
});

describe('parseCloneUrl: the forms that are refused', () => {
  it.each([
    ['an https URL with a user name', 'https://user@host/acme/web.git'],
    ['an https URL with a token as the user', 'https://ghp_S3cretT0kenValue@github.com/acme/web.git'],
    ['an https URL with a user and a password', 'https://user:p4ss@host/acme/web.git'],
    ['an https URL with an empty user', 'https://@host/acme/web.git'],
    ['an ssh URL with a password', 'ssh://user:p4ss@host/acme/web.git'],
    ['an ssh URL with a token after a colon', 'ssh://git:tok3n@host/acme/web.git'],
    ['the scp form with a password', 'user:p4ss@host:acme/web.git'],
    ['the scp form with an empty password', 'user:@host:acme/web.git'],
  ])('refuses %s as credentials', (_name, text) => {
    expect(issueOf(text)).toBe('credentials');
  });

  it.each([
    ['an http URL', 'http://host/acme/web.git'],
    ['the git scheme', 'git://host/acme/web.git'],
    ['a transport helper', 'ext::sh -c touch% /tmp/x'],
    ['a transport helper with a scheme word', 'fd::17'],
    ['an ftp URL', 'ftp://host/acme/web.git'],
  ])('refuses %s as a scheme that is not allowed', (_name, text) => {
    expect(issueOf(text)).toBe('scheme');
  });

  it.each([
    ['a value', '-oProxyCommand=x'],
    ['an scp user', '-oProxyCommand=x@host:acme/web.git'],
    ['an ssh host', 'ssh://-oProxyCommand=x/acme/web.git'],
    ['an ssh user', 'ssh://-u@host/acme/web.git'],
    ['an https host', 'https://-host/acme/web.git'],
  ])('refuses a hyphen at the start of %s', (_name, text) => {
    expect(issueOf(text)).toBe('hyphen');
  });

  it.each([
    ['a file URL with a host', 'file://host/srv/web'],
    ['a file URL with a user', 'file://user@localhost/srv/web'],
    ['a file URL with a .. segment', 'file:///srv/../etc'],
    ['an https URL with a .. segment', 'https://host/acme/../web'],
    ['an https URL with no path', 'https://host'],
    ['an https URL with a space', 'https://host/acme/a b'],
    ['a value with a control character', 'https://host/acme/web\u0007'],
  ])('refuses %s as a form that is not a clone URL', (_name, text) => {
    expect(issueOf(text)).toBe('form');
  });

  it('refuses a value over the length bound', () => {
    expect(issueOf(`https://host/${'a'.repeat(MAX_CLONE_URL_CHARS)}`)).toBe('too-long');
    expect(issueOf(`https://host/${'a'.repeat(MAX_CLONE_URL_CHARS - 'https://host/'.length)}`)).toBeNull();
  });

  it('never repeats the value in the text of a reason', () => {
    const secret = 'ghp_S3cretT0kenValue';
    const issues: CloneIssue[] = ['too-long', 'hyphen', 'credentials', 'scheme', 'form', 'not-local'];
    for (const issue of issues) expect(describeCloneIssue(issue)).not.toContain(secret);
    expect(describeCloneIssue('credentials')).toContain('https URL with no user name');
  });
});

describe('the normal form of a clone URL', () => {
  const same = [
    'https://github.com/acme/web.git',
    'https://GitHub.com/acme/web',
    'https://github.com/acme/web/',
    'https://github.com/acme/web.git/',
    'git@github.com:acme/web.git',
    'git@github.com:acme/web',
    'ssh://git@github.com/acme/web.git',
    'ssh://github.com/acme/web',
    'ssh://other@GITHUB.COM/acme//web',
  ];

  it.each(same)('gives one normal form for %s', (text) => {
    expect(normalFormOf(targetOf(text))).toBe('github.com/acme/web');
  });

  it('tells apart another host, another port and another path', () => {
    const forms = [
      'https://github.com/acme/web',
      'https://github.com/acme/api',
      'https://gitlab.com/acme/web',
      'https://github.com:8443/acme/web',
      'https://github.com/other/web',
    ].map((text) => normalFormOf(targetOf(text)));
    expect(new Set(forms).size).toBe(forms.length);
  });

  it('gives a file URL and an absolute path the same normal form', () => {
    expect(normalFormOf(targetOf('file:///srv/acme/web.git'))).toBe(normalFormOf(targetOf('file:///srv/acme/web.git/')));
    expect(normalFormOf(targetOf('/srv/acme/web'))).toBe(normalFormOf(targetOf('file:///srv/acme/web')));
  });
});

describe('the value of a project url', () => {
  it.each(['https://host/acme/web.git', 'git@host:acme/web.git', 'ssh://git@host/acme/web', 'file:///srv/acme/web', '/srv/acme/web'])(
    'accepts %s',
    (text) => {
      expect(checkProjectUrl(text).ok).toBe(true);
    },
  );

  it.each(['web', '../web', '~/web', 'a/b', ''])('refuses the relative value "%s"', (text) => {
    expect(checkProjectUrl(text)).toEqual({ ok: false, error: 'form' });
  });

  it('refuses an absolute path with a .. segment', () => {
    expect(checkProjectUrl('/srv/../etc')).toEqual({ ok: false, error: 'form' });
  });

  it('refuses credentials, a leading hyphen and a scheme that is not allowed', () => {
    expect(checkProjectUrl('https://u:t@host/a/b')).toEqual({ ok: false, error: 'credentials' });
    expect(checkProjectUrl('-x')).toEqual({ ok: false, error: 'hyphen' });
    expect(checkProjectUrl('http://host/a/b')).toEqual({ ok: false, error: 'scheme' });
  });
});

describe('the value of a local source', () => {
  it.each(['file:///srv/acme/web', 'file://localhost/srv/acme/web', '/srv/acme/web', '/w/My Tool'])('accepts %s', (text) => {
    expect(checkLocalSource(text).ok).toBe(true);
  });

  it.each([
    ['a relative path', 'web', 'form'],
    ['a path under the home folder of a user', '~/code/web', 'form'],
    ['a path with a .. segment', '/srv/../etc', 'form'],
    ['a leading hyphen', '-x', 'hyphen'],
    ['a user name and a password', 'https://u:t@host/a/b', 'credentials'],
    ['a remote URL', 'https://host/acme/web', 'not-local'],
    ['an scp URL', 'git@host:acme/web', 'not-local'],
    ['a scheme that is not allowed', 'http://host/a', 'scheme'],
    ['a line break', '/srv/a\n/srv/b', 'form'],
  ])('refuses %s', (_name, text, issue) => {
    expect(checkLocalSource(text)).toEqual({ ok: false, error: issue });
  });
});

describe('the name of a repo', () => {
  it.each(['web', 'a.b', 'my-repo_2', 'A1'])('accepts %s', (name) => {
    expect(isPlainRepoName(name)).toBe(true);
  });

  it.each(['', '-x', '.hidden', 'a..b', 'a'.repeat(101), 'a b'])('refuses "%s"', (name) => {
    expect(isPlainRepoName(name)).toBe(false);
  });

  it('is empty for a URL whose last part is only the git suffix', () => {
    expect(targetOf('https://host/acme/.git')).toMatchObject({ kind: 'remote', name: '' });
  });
});

describe('classifyOrigin: what init may write as the url of a project', () => {
  it('keeps a remote URL as it is', () => {
    expect(classifyOrigin('git@github.com:acme/web.git')).toEqual({
      kind: 'shareable',
      url: 'git@github.com:acme/web.git',
      credentialsRemoved: false,
    });
    expect(classifyOrigin('ssh://git@github.com/acme/web.git')).toMatchObject({ kind: 'shareable', credentialsRemoved: false });
  });

  it.each([
    ['an https user', 'https://ghp_S3cretT0kenValue@github.com/acme/web.git', 'https://github.com/acme/web.git'],
    ['an https user and a password', 'https://user:p4ss@github.com/acme/web.git', 'https://github.com/acme/web.git'],
    ['an https password with an @', 'https://user:p@ss@github.com/acme/web.git', 'https://github.com/acme/web.git'],
    ['an ssh password', 'ssh://git:tok3n@github.com/acme/web.git', 'ssh://git@github.com/acme/web.git'],
    ['an scp password', 'git:tok3n@github.com:acme/web.git', 'git@github.com:acme/web.git'],
  ])('writes the URL without the secret of %s', (_name, origin, url) => {
    expect(classifyOrigin(origin)).toEqual({ kind: 'shareable', url, credentialsRemoved: true });
  });

  it('reports a file URL as a local source', () => {
    expect(classifyOrigin('file:///srv/acme/web.git')).toEqual({ kind: 'file', url: 'file:///srv/acme/web.git' });
  });

  it.each([
    ['no origin', null],
    ['an empty origin', '  '],
    ['a local path', '/srv/acme/web.git'],
    ['a relative path', '../web.git'],
    ['an http URL', 'http://host/acme/web.git'],
    ['a transport helper', 'ext::sh -c x'],
    ['a value that stays refused after the secret is cut', 'https://user:p4ss@host/'],
  ])('reports %s as a value with no shareable URL', (_name, origin) => {
    expect(classifyOrigin(origin)).toEqual({ kind: 'other' });
  });
});
