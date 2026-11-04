import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Every `.ts` file under a folder. */
export const allSourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return allSourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });

export const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The text of every string literal. Template expressions and {{placeholders}} are blanked. */
export const literalsOf = (source: string): string[] => {
  const code = stripComments(source);
  const tokens = [
    ...(code.match(/'(?:[^'\\\n]|\\.)*'/g) ?? []),
    ...(code.match(/"(?:[^"\\\n]|\\.)*"/g) ?? []),
    ...(code.match(/`(?:[^`\\]|\\.)*`/g) ?? []),
  ];
  return tokens.map((token) =>
    token.slice(1, -1).replace(/\$\{[^}]*\}/g, ' ').replace(/\{\{[A-Za-z]+\}\}/g, ' '),
  );
};

/** The module path of every import, re-export and dynamic import of a source text. */
export const importPathsOf = (source: string): string[] =>
  [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');

/** The value of a shell variable that a line of a script sets with double quotes: `name="value"`. */
export const shellValue = (script: string, name: string): string | undefined =>
  new RegExp(`^${name}="([^"\\n]*)"$`, 'm').exec(script)?.[1];
