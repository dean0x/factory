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

/** The index after the string or template literal that starts at `start`. A template expression may hold literals. */
const endOfLiteral = (code: string, start: number): number => {
  const quote = code[start];
  let index = start + 1;
  while (index < code.length) {
    const char = code[index];
    if (char === '\\') {
      index += 2;
    } else if (char === quote) {
      return index + 1;
    } else if (quote === '`' && char === '$' && code[index + 1] === '{') {
      index = scanExpression(code, index + 2, '').end + 1;
    } else {
      index += 1;
    }
  }
  return code.length;
};

/**
 * The expression that starts at `start` and the index where it ends. It ends before one of `stops` at the top level, or
 * before the bracket that closes the group that holds it. Literals and nested groups are skipped.
 */
const scanExpression = (code: string, start: number, stops: string): { readonly text: string; readonly end: number } => {
  let depth = 0;
  let index = start;
  while (index < code.length) {
    const char = code[index] ?? '';
    if (char === "'" || char === '"' || char === '`') {
      index = endOfLiteral(code, index);
    } else if ('([{'.includes(char)) {
      depth += 1;
      index += 1;
    } else if (')]}'.includes(char)) {
      if (depth === 0) break;
      depth -= 1;
      index += 1;
    } else if (depth === 0 && stops.includes(char)) {
      break;
    } else {
      index += 1;
    }
  }
  return { text: code.slice(start, index).trim(), end: index };
};

/**
 * The code of an expression, with the text of its string literals left out: what is left is the code outside the
 * literals and the code inside the `${...}` parts of the templates.
 */
export const codeOfExpression = (expression: string): string => {
  let code = '';
  let index = 0;
  while (index < expression.length) {
    const char = expression[index] ?? '';
    if (char === "'" || char === '"') {
      index = endOfLiteral(expression, index);
      code += ' ';
    } else if (char === '`') {
      index += 1;
      while (index < expression.length && expression[index] !== '`') {
        if (expression[index] === '\\') {
          index += 2;
        } else if (expression[index] === '$' && expression[index + 1] === '{') {
          const part = scanExpression(expression, index + 2, '');
          code += ` ${codeOfExpression(part.text)} `;
          index = part.end + 1;
        } else {
          index += 1;
        }
      }
      index += 1;
    } else {
      code += char;
      index += 1;
    }
  }
  return code;
};

/** The arguments of every call of `name` in a source text, as written. A call in a comment does not count. */
export const callsOf = (source: string, name: string): readonly (readonly string[])[] => {
  const code = stripComments(source);
  return [...code.matchAll(new RegExp(`\\b${name}\\(`, 'g'))].map((match) => {
    const args: string[] = [];
    let index = (match.index ?? 0) + match[0].length;
    while (index < code.length) {
      const argument = scanExpression(code, index, ',');
      if (argument.text !== '') args.push(argument.text);
      if (code[argument.end] !== ',') break;
      index = argument.end + 1;
    }
    return args;
  });
};

/** A constant that a source text declares, or the default value of a parameter, with its value as written. */
export interface Constant {
  readonly name: string;
  readonly text: string;
  readonly exported: boolean;
}

/** Every `const` or `let` of a source text and every parameter with a default value of type string. */
export const constantsOf = (source: string): readonly Constant[] => {
  const code = stripComments(source);
  const declared = [...code.matchAll(/(?:^|[\s;{])(export\s+)?(?:const|let)\s+([A-Za-z_]\w*)\s*(?::[^=;]+)?=(?![=>])/g)].map(
    (match): Constant => ({
      name: match[2] ?? '',
      text: scanExpression(code, (match.index ?? 0) + match[0].length, ';').text,
      exported: match[1] !== undefined,
    }),
  );
  const defaults = [...code.matchAll(/\b([A-Za-z_]\w*)\s*:\s*string\s*=(?![=>])/g)].map(
    (match): Constant => ({
      name: match[1] ?? '',
      text: scanExpression(code, (match.index ?? 0) + match[0].length, ',').text,
      exported: false,
    }),
  );
  return [...declared, ...defaults];
};

/** The module path of every import, re-export and dynamic import of a source text. */
export const importPathsOf = (source: string): string[] =>
  [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');

/** The value of a shell variable that a line of a script sets with double quotes: `name="value"`. */
export const shellValue = (script: string, name: string): string | undefined =>
  new RegExp(`^${name}="([^"\\n]*)"$`, 'm').exec(script)?.[1];

/**
 * Like `importPathsOf`, and a type-only import or re-export (`import type`, `export type ... from`) is left out: the compiler
 * erases it, so it leaves no import at run time.
 */
export const runtimeImportPathsOf = (source: string): string[] =>
  importPathsOf(source.replace(/\b(?:import|export)\s+type\b[^;]*?\bfrom\s*['"][^'"]+['"]/g, ''));
