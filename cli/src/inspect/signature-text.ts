// Readable signatures for `buckets inspect`. The adapter reports only a hash of each DMZ symbol's signature, so the
// inspect page reads the declaration from the `_/` file that declares the symbol. It parses the file with the
// project's own `typescript` package when it resolves (parse only, no type checking) and falls back to the line of
// the declaration. The text is for people: function bodies and initializers are left out.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type * as TS from 'typescript';

type TypeScript = typeof TS;

const MAX_LINES = 40;
const MAX_CHARS = 2400;

const loaded = new Map<string, TypeScript | null>();

/** The project's `typescript` package, or null when it does not resolve. Never bundled into the CLI. */
function loadTypeScript(projectDir: string): TypeScript | null {
  const key = path.resolve(projectDir);
  if (loaded.has(key)) return loaded.get(key)!;
  let ts: TypeScript | null = null;
  try {
    const req = createRequire(path.join(key, 'package.json'));
    ts = req(req.resolve('typescript')) as TypeScript;
  } catch {
    ts = null;
  }
  loaded.set(key, ts);
  return ts;
}

/** Removes the common indentation of the lines after the first, and trailing spaces. */
function dedent(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  const rest = lines.slice(1).filter((l) => l.trim() !== '');
  const indent = rest.length === 0 ? 0 : Math.min(...rest.map((l) => /^\s*/.exec(l)![0].length));
  return [lines[0]!, ...lines.slice(1).map((l) => l.slice(Math.min(indent, /^\s*/.exec(l)![0].length)))].join('\n');
}

function cap(text: string): string {
  let out = dedent(text.trim());
  const lines = out.split('\n');
  if (lines.length > MAX_LINES) out = `${lines.slice(0, MAX_LINES).join('\n')}\n...`;
  if (out.length > MAX_CHARS) out = `${out.slice(0, MAX_CHARS)}\n...`;
  return out;
}

function scriptKind(ts: TypeScript, file: string): TS.ScriptKind {
  const lower = file.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(lower)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** The text of `node` from its first token up to `end`, without the leading comments. */
function slice(sf: TS.SourceFile, node: TS.Node, end?: number): string {
  return sf.text.slice(node.getStart(sf), end ?? node.getEnd()).trim();
}

function functionHead(sf: TS.SourceFile, node: TS.FunctionLikeDeclaration): string {
  return slice(sf, node, node.body ? node.body.getStart(sf) : undefined).replace(/;$/, '');
}

function classText(ts: TypeScript, sf: TS.SourceFile, node: TS.ClassDeclaration): string {
  const open = sf.text.indexOf('{', node.members.pos - 1);
  const head = sf.text.slice(node.getStart(sf), open === -1 ? node.members.pos : open).trim();
  const members: string[] = [];
  for (const member of node.members) {
    const modifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : [];
    if (modifiers.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword) || (member.name && ts.isPrivateIdentifier(member.name))) continue;
    if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
      members.push(`  ${dedent(functionHead(sf, member))};`);
    } else if (ts.isPropertyDeclaration(member)) {
      const end = member.initializer ? member.initializer.getStart(sf) : undefined;
      members.push(`  ${slice(sf, member, end).replace(/\s*=$/, '').replace(/;$/, '')};`);
    } else if (!ts.isSemicolonClassElement(member) && !ts.isClassStaticBlockDeclaration(member)) {
      members.push(`  ${slice(sf, member)}`);
    }
  }
  return members.length === 0 ? `${head} {}` : `${head} {\n${members.join('\n')}\n}`;
}

function variableText(ts: TypeScript, sf: TS.SourceFile, statement: TS.VariableStatement, decl: TS.VariableDeclaration): string {
  const flags = statement.declarationList.flags;
  const keyword = flags & ts.NodeFlags.Const ? 'const' : flags & ts.NodeFlags.Let ? 'let' : 'var';
  const exported = (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ? 'export ' : '';
  const name = decl.name.getText(sf);
  if (decl.type) return `${exported}${keyword} ${name}: ${decl.type.getText(sf)}`;
  const init = decl.initializer;
  if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
    const head = init.body ? sf.text.slice(init.getStart(sf), init.body.getStart(sf)).trim() : init.getText(sf);
    return `${exported}${keyword} ${name} = ${head.replace(/=>$/, '=>')}`;
  }
  if (!init) return `${exported}${keyword} ${name}`;
  const text = init.getText(sf);
  const firstLine = text.split(/\r?\n/)[0]!;
  return `${exported}${keyword} ${name} = ${firstLine.length > 100 ? `${firstLine.slice(0, 100)}...` : firstLine}${text.includes('\n') && firstLine.length <= 100 ? ' ...' : ''}`;
}

function nameOf(ts: TypeScript, node: TS.Node): string | undefined {
  const named = node as TS.Node & { name?: TS.Node };
  return named.name && ts.isIdentifier(named.name) ? named.name.text : undefined;
}

/** The declaration text of `name` in the parsed file, or null. */
function fromSource(ts: TypeScript, sf: TS.SourceFile, name: string): string | null {
  const parts: string[] = [];
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && nameOf(ts, statement) === name) parts.push(functionHead(sf, statement));
    else if (ts.isClassDeclaration(statement) && nameOf(ts, statement) === name) parts.push(classText(ts, sf, statement));
    else if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name.text === name) parts.push(slice(sf, statement));
    else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name) && statement.name.text === name) parts.push(slice(sf, statement));
    else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) if (ts.isIdentifier(decl.name) && decl.name.text === name) parts.push(variableText(ts, sf, statement, decl));
    }
  }
  if (parts.length > 0) return parts.join('\n');
  // A barrel inside `_/` that passes the name on: say where it comes from.
  for (const statement of sf.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      if (element.name.text !== name) continue;
      const local = element.propertyName?.getText(sf);
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) return `export { ${local ? `${local} as ` : ''}${name} } from '${statement.moduleSpecifier.text}'`;
      if (local) return fromSource(ts, sf, local);
    }
  }
  return null;
}

const DECLARATION = (name: string): RegExp =>
  new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class|interface|type|enum|namespace)\\s+${name.replace(/[$]/g, '\\$')}\\b`);

/** The line that declares `name`, for when `typescript` does not resolve. */
function fromLines(text: string, name: string): string | null {
  const line = text.split(/\r?\n/).find((l) => DECLARATION(name).test(l));
  return line === undefined ? null : line.trim().replace(/\{\s*$/, '').trim();
}

export interface SignatureReader {
  /** The declaration of `name` in the project file `file`, without bodies, or null when it cannot be found. */
  read(file: string, name: string): string | null;
}

/** A reader that parses each file once. */
export function signatureReader(projectDir: string): SignatureReader {
  const ts = loadTypeScript(projectDir);
  const files = new Map<string, { text: string; sf: TS.SourceFile | null } | null>();
  const open = (file: string) => {
    if (files.has(file)) return files.get(file)!;
    let entry: { text: string; sf: TS.SourceFile | null } | null = null;
    try {
      const text = readFileSync(path.join(projectDir, file), 'utf8');
      let sf: TS.SourceFile | null = null;
      if (ts) {
        try {
          sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(ts, file));
        } catch {
          sf = null;
        }
      }
      entry = { text, sf };
    } catch {
      entry = null;
    }
    files.set(file, entry);
    return entry;
  };
  return {
    read(file, name) {
      const entry = open(file);
      if (entry === null) return null;
      let text: string | null = null;
      if (ts && entry.sf) {
        try {
          text = fromSource(ts, entry.sf, name);
        } catch {
          text = null;
        }
      }
      text ??= fromLines(entry.text, name);
      return text === null ? null : cap(text);
    },
  };
}
