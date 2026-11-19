import { readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import type { RowSite } from '../../src/guards/types.js';
import * as ts from 'typescript/unstable/ast';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { API } from 'typescript/unstable/sync';

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

/** The named declarations of a source file, without nested code, comments or literal text. */
const namesOfFile = (file: ts.SourceFile): readonly string[] =>
  file.statements.flatMap((statement) => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.flatMap((declaration) =>
        ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
      );
    }
    if (
      ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)
    ) {
      return statement.name === undefined ? [] : [statement.name.text];
    }
    return [];
  });

/** Reuse the installed TypeScript parser. A separate parser would duplicate its syntax and module rules. */
const withSourceFiles = <T>(sources: readonly string[], read: (files: readonly ts.SourceFile[]) => T): T => {
  const folder = join(process.cwd(), 'source-scan');
  const config = join(folder, 'tsconfig.json');
  const paths = sources.map((_, index) => join(folder, `source-${index}.ts`));
  const virtualFiles = Object.fromEntries(paths.map((path, index) => [path, sources[index] ?? '']));
  const api = new API({ fs: createVirtualFileSystem({
    ...virtualFiles,
    [config]: JSON.stringify({ files: paths, compilerOptions: { noLib: true, noResolve: true, types: [] } }),
  }) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const program = snapshot.getProject(config)?.program;
      return read(paths.map((path) => {
        const file = program?.getSourceFile(path);
        if (file === undefined) throw new Error('The source parser did not return a file.');
        return file;
      }));
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
};

/** Parse source texts in one compiler session. All input stays in memory, and the session always closes. */
export const topLevelNamesOf = (sources: readonly string[]): readonly (readonly string[])[] =>
  withSourceFiles(sources, (files) => files.map(namesOfFile));

export interface SourceDeclaration {
  readonly site: RowSite;
  readonly body: string;
  readonly references: readonly string[];
  readonly ports: readonly string[];
  readonly faults: readonly string[];
}

interface SourceModule {
  readonly declarations: ReadonlyMap<string, SourceDeclaration>;
  readonly imports: ReadonlyMap<string, RowSite>;
  readonly reexports: readonly string[];
}

/** Runtime references only: comments, literal text, type annotations and property names cannot create an edge. */
const referencesOf = (body: ts.Node, file: ts.SourceFile): Pick<SourceDeclaration, 'references' | 'ports' | 'faults'> => {
  const references = new Set<string>();
  const ports = new Set<string>();
  const faults = new Set<string>();
  const visit = (node: ts.Node, depth: number): void => {
    if (depth >= 128) { faults.add('syntax depth cap reached'); return; }
    if (ts.isTypeNode(node)) return;
    if (ts.isPropertyAccessExpression(node)) {
      const text = node.getText(file).replace(/\s|\?/g, '');
      if (text === 'deps.guards' || text.startsWith('deps.guards.')) faults.add('guard value read');
      references.add(text);
      visit(node.expression, depth + 1);
      return;
    }
    if (ts.isCallExpression(node)) {
      const text = node.expression.getText(file).replace(/\s|\?/g, '');
      if (/^deps(?:\.[A-Za-z_]\w*)+$/.test(text)) ports.add(text.slice('deps.'.length));
      if (text.startsWith('deps[')) faults.add('computed dependency call');
    }
    if (ts.isElementAccessExpression(node)) {
      const owner = node.expression.getText(file);
      if (owner === 'deps' || owner === 'deps.fs' || owner.startsWith('deps.guards')) faults.add('computed dependency access');
    }
    if (ts.isIdentifier(node)) { references.add(node.text); return; }
    if (ts.isPropertyAssignment(node)) { visit(node.initializer, depth + 1); return; }
    if (ts.isVariableDeclaration(node) || ts.isParameterDeclaration(node)) {
      if (node.initializer !== undefined) {
        const text = node.initializer.getText(file).trim();
        if (/^deps(?:\.fs(?:\.[A-Za-z_]\w*)?)?$/.test(text)) faults.add('dependency alias');
        visit(node.initializer, depth + 1);
      }
      return;
    }
    node.forEachChild((child) => { visit(child, depth + 1); });
  };
  visit(body, 0);
  return { references: [...references], ports: [...ports], faults: [...faults] };
};

const objectOf = (node: ts.Node): ts.ObjectLiteralExpression | undefined => {
  let current = node;
  for (let depth = 0; depth < 16; depth += 1) {
    if (ts.isObjectLiteralExpression(current)) return current;
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
    else if (ts.isArrowFunction(current)) current = current.body;
    else return undefined;
  }
  return undefined;
};

const moduleOf = (path: string, file: ts.SourceFile): SourceModule => {
  const declarations = new Map<string, SourceDeclaration>();
  const imports = new Map<string, RowSite>();
  const reexports: string[] = [];
  const add = (symbol: string, node: ts.Node): void => {
    declarations.set(symbol, { site: { path, symbol }, body: node.getText(file), ...referencesOf(node, file) });
    const object = objectOf(node);
    if (object === undefined) return;
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property) || !ts.isIdentifier(property.name)) continue;
      const name = `${symbol}.${property.name.text}`;
      if (ts.isPropertyAssignment(property)) addMember(name, property.initializer);
      else if (ts.isShorthandPropertyAssignment(property)) addMember(name, property.name);
      else if (ts.isMethodDeclaration(property) && property.body !== undefined) addMember(name, property.body);
    }
  };
  const addMember = (symbol: string, node: ts.Node): void => {
    declarations.set(symbol, { site: { path, symbol }, body: node.getText(file), ...referencesOf(node, file) });
  };
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause === undefined || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
      const target = normalize(join(dirname(path), statement.moduleSpecifier.text)).replace(/\.js$/, '.ts');
      if (!statement.moduleSpecifier.text.startsWith('.')) continue;
      const bindings = clause.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const item of bindings.elements) {
          if (!item.isTypeOnly) imports.set(item.name.text, { path: target, symbol: item.propertyName?.text ?? item.name.text });
        }
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) imports.set(bindings.name.text, { path: target, symbol: '*' });
      if (clause.name !== undefined) imports.set(clause.name.text, { path: target, symbol: 'default' });
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause === undefined &&
      statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith('.')) {
      reexports.push(normalize(join(dirname(path), statement.moduleSpecifier.text)).replace(/\.js$/, '.ts'));
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) add(declaration.name.text, declaration.initializer);
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.body !== undefined) {
      add(statement.name.text, statement);
    }
  }
  return { declarations, imports, reexports };
};

export interface TraceOptions {
  readonly deps: Readonly<Record<string, RowSite>>;
  readonly rowSites?: readonly RowSite[];
  /** Each exception must name a reached registry row site; its body must still pass the scan. */
  readonly exceptions?: readonly (RowSite & { readonly reason: string })[];
  readonly maxDepth: number;
}

export interface SourceTrace {
  readonly sites: readonly RowSite[];
  readonly faults: readonly string[];
}

/** Follow declaration bodies through local names, relative imports and an explicit dependency adapter map. */
export const traceSitesOf = (sources: Readonly<Record<string, string>>, roots: readonly RowSite[], options: TraceOptions): SourceTrace => {
  const paths = Object.keys(sources);
  const modules = withSourceFiles(paths.map((path) => sources[path] ?? ''), (files) =>
    new Map(files.map((file, index) => [paths[index] ?? '', moduleOf(paths[index] ?? '', file)])));
  const seen = new Map<string, RowSite>();
  const faults = new Set<string>();
  const resolveExports = (site: RowSite, depth: number, ancestors: ReadonlySet<string>): readonly { readonly site: RowSite; readonly depth: number }[] => {
    const key = `${site.path}:${site.symbol}`;
    if (depth >= options.maxDepth) { faults.add(`${key}: depth cap reached`); return []; }
    if (ancestors.has(key)) return [];
    const module = modules.get(site.path);
    if (module?.declarations.has(site.symbol)) return [{ site, depth }];
    const nextAncestors = new Set([...ancestors, key]);
    return (module?.reexports ?? []).flatMap((path) => resolveExports({ path, symbol: site.symbol }, depth + 1, nextAncestors));
  };
  const visit = (site: RowSite, depth: number, ancestors: ReadonlySet<string>): void => {
    const key = `${site.path}:${site.symbol}`;
    if (depth >= options.maxDepth) { faults.add(`${key}: depth cap reached`); return; }
    if (ancestors.has(key)) return;
    const module = modules.get(site.path);
    const declaration = module?.declarations.get(site.symbol);
    if (declaration === undefined || module === undefined) {
      const targets = resolveExports(site, depth, new Set());
      if (targets.length === 0) faults.add(`${key}: declaration not found`);
      for (const target of targets) visit(target.site, target.depth, ancestors);
      return;
    }
    seen.set(key, site);
    const exception = options.exceptions?.find((item) => item.path === site.path && item.symbol === site.symbol);
    const isRowSite = options.rowSites?.some((item) => item.path === site.path && item.symbol === site.symbol);
    if (isRowSite && (exception === undefined || exception.reason.trim() === '')) {
      faults.add(`${key}: row site requires a named exception with a reason`);
    }
    const nextAncestors = new Set([...ancestors, key]);
    for (const fault of declaration.faults) faults.add(`${key}: ${fault}`);
    const next = new Map<string, RowSite>();
    for (const port of declaration.ports) {
      const target = options.deps[port];
      if (target === undefined) faults.add(`${key}: unmapped dependency method ${port}`);
      else next.set(`${target.path}:${target.symbol}`, target);
    }
    for (const reference of declaration.references) {
      let target: RowSite | undefined;
      if (module.declarations.has(reference)) target = { path: site.path, symbol: reference };
      else {
        const [name, ...members] = reference.split('.');
        const imported = module.imports.get(name ?? '');
        if (imported !== undefined && imported.symbol !== '*') target = imported;
        else if (imported !== undefined && members.length > 0) target = { path: imported.path, symbol: members.join('.') };
      }
      if (target !== undefined) next.set(`${target.path}:${target.symbol}`, target);
    }
    for (const target of next.values()) visit(target, depth + 1, nextAncestors);
  };
  for (const root of roots) visit(root, 0, new Set());
  const rowKeys = new Set((options.rowSites ?? []).map((site) => `${site.path}:${site.symbol}`));
  for (const exception of options.exceptions ?? []) {
    const key = `${exception.path}:${exception.symbol}`;
    if (!seen.has(key)) faults.add(`${key}: exception site was not reached`);
    if (!rowKeys.has(key)) faults.add(`${key}: exception site is not a registry row site`);
  }
  return { sites: [...seen.values()], faults: [...faults] };
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

/** The text of the top-level declaration of each site, or null when its file does not declare it. */
export const declarationTextsOf = (sources: Readonly<Record<string, string>>, sites: readonly RowSite[]): readonly (string | null)[] => {
  const paths = Object.keys(sources);
  const modules = withSourceFiles(paths.map((path) => sources[path] ?? ''), (files) =>
    new Map(files.map((file, index) => [paths[index] ?? '', moduleOf(paths[index] ?? '', file)])));
  return sites.map((site) => modules.get(site.path)?.declarations.get(site.symbol)?.body ?? null);
};
