/** Text that no template and no generated file may hold. */
export const DENY_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'owner name', pattern: /dean/i },
  { name: 'user folder', pattern: /\/Users\//i },
  { name: 'workspace name', pattern: /sandbox/i },
  { name: 'workflow tool name', pattern: /devflow/i },
  { name: 'proxy product name', pattern: /subswitch/i },
  { name: 'machine size', pattern: /\b\d+\s?(GB|MB|TB|CPUs?|cores?)\b/i },
  { name: 'session id', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { name: 'date of an event', pattern: /\b20\d{2}-\d{2}-\d{2}\b/ },
];

export const denyMatches = (text: string): string[] =>
  DENY_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
