// Generates the reference pages in docs/reference/ from the source of truth:
//   cli/src/core/types.ts         rule ids, lock change kinds, environment codes, CheckReport, Lock
//   cli/src/**/*.ts               the messages the CLI prints for each of them
//   cli/src/output/text.ts        exit code messages and the refresh diff labels
//   cli/src/commands/*.ts         usage lines, hook settings, link messages
//   cli/src/hooks/*.ts            hook events, hook messages and the Claude Code tool names
//   cli/src/core/links.ts         buckets.links.json
//   cli/src/inspect/*.ts          the snapshot of `buckets inspect --json` and the export output
//   adapters/ts/src/protocol.ts   the adapter protocol (types and doc comments)
//   site/schema/v1.json           the config reference
//   the built CLI                 `buckets --help`, `buckets --version` and the agents of `--agent`
//   docs/guide/agents/*.md        the title of each agent page, for the agents table
// Run with `npm run generate -w docs`. The output folder is rebuilt from scratch on every run.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPLAIN_RULE, EXPLAIN_LOCK, EXPLAIN_ENV, EXPLAIN_IMPORT_KIND, EXPLAIN_HOOK, RULE_GROUPS } from './explanations.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const out = path.resolve(here, '../reference');
const require = createRequire(import.meta.url);
const ts = require('typescript');

const rel = (p) => path.join(repo, p);
const read = (p) => readFileSync(rel(p), 'utf8');
const sources = new Map();
function source(p) {
  if (!sources.has(p)) sources.set(p, ts.createSourceFile(p, read(p), ts.ScriptTarget.Latest, true));
  return sources.get(p);
}
function walk(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => walk(child, fn));
}
function tsFiles(dir) {
  const result = [];
  for (const name of readdirSync(rel(dir))) {
    const p = `${dir}/${name}`;
    if (statSync(rel(p)).isDirectory()) result.push(...tsFiles(p));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) result.push(p);
  }
  return result.sort();
}

/* ---------- escaping ---------- */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Text with `code spans` becomes HTML with <code>. */
const inline = (s) => String(s).split(/(`[^`]+`)/).map((part) => (part.startsWith('`') && part.endsWith('`') && part.length > 1 ? `<code>${esc(part.slice(1, -1))}</code>` : esc(part))).join('');
/** Short variable names in the source, as words a reader understands in a placeholder. */
const PLACEHOLDER_WORDS = { p: 'path', rel: 'project', 'folder abs': 'folder', 'origin arg': 'origin', 'bucket arg': 'bucket folder', 'to posix': 'path' };
const words = (name) => {
  const w = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return PLACEHOLDER_WORDS[w] ?? w;
};

/* ---------- constants, also across imports ---------- */
/** The file an import specifier of `sf` points at, as a repository path, or null for a package. */
function importedFile(sf, spec) {
  if (!spec.startsWith('.')) return null;
  const p = path.posix.join(path.posix.dirname(sf.fileName), spec).replace(/\.js$/, '.ts');
  return existsSync(rel(p)) ? p : null;
}
/** The declaration of a top-level constant named `name` in `sf`, following named imports. */
function constDeclaration(sf, name, seen = new Set()) {
  if (seen.has(sf.fileName)) return null;
  seen.add(sf.fileName);
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return { sf, init: d.initializer };
    }
  }
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings || !ts.isNamedImports(st.importClause.namedBindings)) continue;
    const el = st.importClause.namedBindings.elements.find((e) => e.name.text === name);
    if (!el) continue;
    const file = importedFile(sf, st.moduleSpecifier.text);
    if (file) return constDeclaration(source(file), el.propertyName?.text ?? name, seen);
  }
  return null;
}
/** The value of an expression made only of literals and constants, or null. Strings and numbers only. */
function staticValue(sf, expr) {
  if (!expr) return null;
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) return staticValue(sf, expr.expression);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (ts.isIdentifier(expr) && /^[A-Z][A-Z0-9_]*$/.test(expr.text)) {
    const d = constDeclaration(sf, expr.text);
    return d ? staticValue(d.sf, d.init) : null;
  }
  if (ts.isTemplateExpression(expr)) {
    let s = expr.head.text;
    for (const span of expr.templateSpans) {
      const v = staticValue(sf, span.expression);
      if (v === null) return null;
      s += String(v) + span.literal.text;
    }
    return s;
  }
  if (ts.isBinaryExpression(expr)) {
    const a = staticValue(sf, expr.left), b = staticValue(sf, expr.right);
    if (a === null || b === null) return null;
    switch (expr.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken: return typeof a === 'number' && typeof b === 'number' ? a + b : String(a) + String(b);
      case ts.SyntaxKind.SlashToken: return typeof a === 'number' && typeof b === 'number' ? a / b : null;
      case ts.SyntaxKind.AsteriskToken: return typeof a === 'number' && typeof b === 'number' ? a * b : null;
      default: return null;
    }
  }
  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    const base = staticValue(sf, expr.expression.expression);
    if (typeof base !== 'string') return null;
    const args = expr.arguments.map((a) => staticValue(sf, a));
    if (args.some((a) => typeof a !== 'number')) return null;
    switch (expr.expression.name.text) {
      case 'toLowerCase': return base.toLowerCase();
      case 'toUpperCase': return base.toUpperCase();
      case 'trim': return base.trim();
      case 'charAt': return base.charAt(args[0] ?? 0);
      case 'slice': return base.slice(...args);
      default: return null;
    }
  }
  return null;
}
function constString(sf, name) {
  const d = constDeclaration(sf, name);
  if (!d) return undefined;
  const v = staticValue(d.sf, d.init);
  return v === null ? undefined : String(v);
}

/* ---------- rendering code strings with placeholders ---------- */
function placeholder(sf, expr) {
  if (ts.isParenthesizedExpression(expr)) return placeholder(sf, expr.expression);
  const fixed = staticValue(sf, expr);
  if (fixed !== null) return String(fixed);
  if (ts.isIdentifier(expr)) return `<${words(expr.text)}>`;
  if (ts.isPropertyAccessExpression(expr)) return `<${words(expr.name.text)}>`;
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : 'value';
    if (name === 'sentence' && expr.arguments[0]) return placeholder(sf, expr.arguments[0]);
    if (['join', 'map', 'slice', 'trim', 'replace'].includes(name) && ts.isPropertyAccessExpression(callee)) return placeholder(sf, callee.expression);
    if (['toPosix', 'sanitizeDialogText', 'String'].includes(name) && expr.arguments[0]) return placeholder(sf, expr.arguments[0]);
    if (name === 'resolve' && expr.arguments.length) return placeholder(sf, expr.arguments[expr.arguments.length - 1]);
    const styled = unstyled(sf, expr);
    if (styled) return render(sf, styled) ?? placeholder(sf, styled);
    if (name === 'relative' && expr.arguments[1]) return placeholder(sf, expr.arguments[1]);
    if (name === 'plural' && expr.arguments[1]) return `<${words(expr.arguments[1].text ?? 'count')}s>`;
    return `<${words(name)}>`;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return placeholder(sf, expr.left);
  if (ts.isConditionalExpression(expr)) {
    // A short optional part, such as `${x ? '' : ' (the folder does not exist)'}`, is shown in square brackets.
    const a = staticValue(sf, expr.whenTrue), b = staticValue(sf, expr.whenFalse);
    if (a === '' && typeof b === 'string') return `[${b}]`;
    if (b === '' && typeof a === 'string') return `[${a}]`;
  }
  return '<value>';
}
/** Renders a string-ish expression. Interpolations become <placeholders>. Returns null when it is not a string. */
function render(sf, expr, strict = false) {
  if (!expr) return null;
  if (ts.isParenthesizedExpression(expr)) return render(sf, expr.expression, strict);
  const fixed = staticValue(sf, expr);
  if (fixed !== null) return String(fixed);
  if (ts.isTemplateExpression(expr)) {
    let s = expr.head.text;
    for (const span of expr.templateSpans) s += placeholder(sf, span.expression) + span.literal.text;
    return s;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = render(sf, expr.left, strict), b = render(sf, expr.right, strict);
    return a !== null && b !== null ? a + b : null;
  }
  if (strict) return null;
  return placeholder(sf, expr);
}
/** The argument of a terminal color call such as `err.error(text)` or `out.bold(text)`, or null. */
const STYLE_CALLS = new Set(['error', 'bold', 'ok', 'warn', 'dim', 'phos', 'path']);
function unstyled(sf, e) {
  if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression) || !e.arguments[0]) return null;
  return STYLE_CALLS.has(e.expression.name.text) && ['err', 'out', 'style'].includes(e.expression.expression.getText(sf)) ? e.arguments[0] : null;
}
/**
 * Every text an expression can produce. Conditionals give one text per branch, also inside templates, and a local
 * constant is replaced by its value. A conditional with an empty branch is shown in square brackets instead, and
 * an expression with too many combinations falls back to placeholders.
 */
function variants(sf, expr, depth = 0) {
  if (!expr) return [];
  if (ts.isParenthesizedExpression(expr)) return variants(sf, expr.expression, depth);
  const fixed = staticValue(sf, expr);
  if (fixed !== null) return [String(fixed)];
  if (ts.isConditionalExpression(expr)) return uniq([...variants(sf, expr.whenTrue, depth), ...variants(sf, expr.whenFalse, depth)]);
  const part = (e) => {
    if (ts.isParenthesizedExpression(e)) return part(e.expression);
    // Terminal colors, such as `err.error('No config')`, print their argument.
    const styled = unstyled(sf, e);
    if (styled) return part(styled);
    const v = staticValue(sf, e);
    if (v !== null) return [String(v)];
    if (ts.isTemplateExpression(e) || (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
      const list = variants(sf, e, depth + 1);
      return list.length ? list : [placeholder(sf, e)];
    }
    if (ts.isConditionalExpression(e)) {
      // Decorations for a terminal, such as a check mark, are left out: agents and CI read the plain output.
      if (/\.tty$/.test(e.condition.getText(sf))) return part(e.whenFalse);
      const a = staticValue(sf, e.whenTrue), b = staticValue(sf, e.whenFalse);
      // An optional part, such as `${x ? '' : ' (more)'}`, is shown in square brackets.
      if (a === '' || b === '') {
        const texts = part(a === '' ? e.whenFalse : e.whenTrue);
        // Several texts for the optional part, such as `${copy ? '' : enclosed ? ', because ...' : ', because ...'}`,
        // give one variant each, plus the one without it.
        if (texts.length > 1 && !texts.some((t) => /^<[^<>]+>$/.test(t))) return uniq(['', ...texts]);
        if (texts.length !== 1) return [placeholder(sf, e)];
        return [texts[0].trim() === '' ? '' : `[${texts[0]}]`];
      }
      // Two runtime values, such as `error instanceof Error ? error.message : String(error)`, are one placeholder.
      const texty = (x) => ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) || ts.isTemplateExpression(x) || ts.isConditionalExpression(x) || staticValue(sf, x) !== null;
      if (!texty(e.whenTrue) && !texty(e.whenFalse)) return [placeholder(sf, e.whenTrue)];
      return uniq([...part(e.whenTrue), ...part(e.whenFalse)]);
    }
    if (ts.isIdentifier(e) && depth < 3) {
      const local = localConst(e, e.text);
      if (local && (ts.isConditionalExpression(local) || ts.isTemplateExpression(local) || ts.isStringLiteral(local))) {
        const list = part(local);
        if (list.length) return list;
      }
    }
    return [placeholder(sf, e)];
  };
  let pieces = null;
  if (ts.isTemplateExpression(expr)) pieces = [[expr.head.text], ...expr.templateSpans.flatMap((span) => [part(span.expression), [span.literal.text]])];
  else if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const flat = [];
    const collect = (e) => (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken ? (collect(e.left), collect(e.right)) : flat.push(e));
    collect(expr);
    pieces = flat.map((e) => (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e) ? variants(sf, e, depth + 1) : part(e)));
    if (pieces.some((p) => p.length === 0)) return [];
  } else if (ts.isIdentifier(expr) && depth < 3) {
    const list = part(expr);
    return list.length === 1 && /^<[^<>]+>$/.test(list[0]) ? [] : list;
  } else {
    const r = render(sf, expr);
    return r === null ? [] : [r];
  }
  const size = pieces.reduce((n, p) => n * p.length, 1);
  if (size > 12) {
    const r = render(sf, expr);
    return r === null ? [] : [r];
  }
  let result = [''];
  for (const p of pieces) result = result.flatMap((a) => p.map((b) => a + b));
  return uniq(result);
}
const uniq = (list) => [...new Set(list)];

/* ---------- reading types ---------- */
function unionOf(file, typeName) {
  const sf = source(file);
  let members = null;
  walk(sf, (n) => {
    if (ts.isTypeAliasDeclaration(n) && n.name.text === typeName && ts.isUnionTypeNode(n.type)) {
      members = n.type.types.map((t) => (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : t.getText()));
    }
  });
  if (!members) throw new Error(`type ${typeName} not found in ${file}`);
  return members;
}
const docOf = (node) => (node.jsDoc ?? []).map((d) => (typeof d.comment === 'string' ? d.comment : (d.comment ?? []).map((c) => c.text).join(''))).join('\n').replace(/\s*\n\s*/g, ' ').trim();
function declarations(file) {
  const sf = source(file);
  const list = [];
  for (const st of sf.statements) {
    if (ts.isInterfaceDeclaration(st)) {
      list.push({
        kind: 'interface', name: st.name.text, doc: docOf(st), text: st.getText(sf),
        members: st.members.filter(ts.isPropertySignature).map((m) => ({ name: m.name.getText(sf), optional: Boolean(m.questionToken), type: m.type ? m.type.getText(sf).replace(/\s+/g, ' ') : '', doc: docOf(m) })),
      });
    } else if (ts.isTypeAliasDeclaration(st)) {
      list.push({ kind: 'type', name: st.name.text, doc: docOf(st), text: st.getText(sf), members: [] });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) list.push({ kind: 'const', name: d.name.getText(sf), doc: docOf(st), text: st.getText(sf), members: [] });
    }
  }
  return list;
}

/* ---------- finding the messages for an id ---------- */
/** For every string literal equal to `id` in `files`, the message next to it: the `message` property of the
 *  same object, or the next argument of the same call. A message passed in as a parameter is followed to the
 *  callers of the enclosing function in the same file, and a local constant to its value. */
function messagesFor(id, files) {
  const found = [];
  for (const file of files) {
    const sf = source(file);
    walk(sf, (n) => {
      if (!(ts.isStringLiteral(n) && n.text === id)) return;
      const p = n.parent;
      if (ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.parent)) {
        const prop = p.parent.properties.find((q) => ts.isPropertyAssignment(q) && q.name.getText(sf) === 'message');
        if (prop) found.push(...followParam(sf, prop, prop.initializer));
      } else if ((ts.isNewExpression(p) || ts.isCallExpression(p)) && p.arguments) {
        const i = p.arguments.indexOf(n);
        if (i >= 0 && p.arguments[i + 1]) found.push(...variants(sf, p.arguments[i + 1]));
      } else if (ts.isAsExpression(p) && ts.isPropertyAssignment(p.parent)) {
        const obj = p.parent.parent;
        const prop = obj.properties.find((q) => ts.isPropertyAssignment(q) && q.name.getText(sf) === 'message');
        if (prop) found.push(...followParam(sf, prop, prop.initializer));
      }
    });
  }
  return uniq(found.filter((m) => m && !/^<[^<>]+>$/.test(m)));
}
/** The local `const name = ...` visible from `at`, or null. */
function localConst(at, name) {
  for (let node = at.parent; node; node = node.parent) {
    if (!ts.isBlock(node) && !ts.isSourceFile(node)) continue;
    for (const st of node.statements) {
      if (!ts.isVariableStatement(st) || st.pos > at.pos || !(st.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d.initializer;
    }
  }
  return null;
}
function followParam(sf, at, expr) {
  if (ts.isIdentifier(expr)) {
    let fn = at;
    while (fn && !ts.isFunctionDeclaration(fn)) fn = fn.parent;
    if (fn) {
      const i = fn.parameters.findIndex((p) => p.name.getText(sf) === expr.text);
      if (i >= 0) return callArgs(sf, fn.name.text, i);
    }
    const local = localConst(at, expr.text);
    if (local) return variants(sf, local);
  }
  return variants(sf, expr);
}
function callArgs(sf, fnName, index) {
  const list = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const c = n.expression;
    const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? `${c.expression.getText(sf)}.${c.name.text}` : '';
    if (name === fnName && n.arguments[index]) list.push(...variants(sf, n.arguments[index]));
  });
  return uniq(list);
}
function propValues(file, propName) {
  const sf = source(file);
  const list = [];
  walk(sf, (n) => {
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === propName) list.push(...variants(sf, n.initializer));
  });
  return uniq(list.filter((m) => m && !/^<[^>]+>$/.test(m)));
}
function objectLiteralOf(file, constName) {
  const sf = source(file);
  let obj;
  walk(sf, (n) => {
    if (ts.isVariableDeclaration(n) && n.name.getText(sf) === constName) obj = n.initializer;
  });
  if (!obj) throw new Error(`${constName} not found in ${file}`);
  while (ts.isAsExpression(obj) || ts.isSatisfiesExpression?.(obj)) obj = obj.expression;
  return { sf, obj };
}
function recordOf(file, constName) {
  const { sf, obj } = objectLiteralOf(file, constName);
  const map = {};
  for (const p of obj.properties) if (ts.isPropertyAssignment(p)) map[p.name.getText(sf).replace(/^['"]|['"]$/g, '')] = render(sf, p.initializer);
  return map;
}
/** A record whose values are object literals, as plain objects of rendered strings. */
function recordOfObjects(file, constName) {
  const { sf, obj } = objectLiteralOf(file, constName);
  const map = {};
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isObjectLiteralExpression(p.initializer)) continue;
    map[p.name.getText(sf).replace(/^['"]|['"]$/g, '')] = Object.fromEntries(p.initializer.properties.filter(ts.isPropertyAssignment).map((q) => [q.name.getText(sf), render(sf, q.initializer)]));
  }
  return map;
}
function switchReturns(file, fnName) {
  const sf = source(file);
  const map = {};
  walk(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === fnName) {
      walk(n, (c) => {
        if (ts.isCaseClause(c) && ts.isStringLiteral(c.expression)) {
          const ret = c.statements.find(ts.isReturnStatement);
          if (ret && ret.expression && ts.isArrayLiteralExpression(ret.expression)) map[c.expression.text] = ret.expression.elements.map((e) => render(sf, e));
          else if (ret) map[c.expression.text] = render(sf, ret.expression);
        }
      });
    }
  });
  return map;
}
/** The function declaration named `fnName` in `sf`, or null. */
function functionNamed(sf, fnName) {
  let found = null;
  walk(sf, (n) => {
    if (!found && ts.isFunctionDeclaration(n) && n.name?.text === fnName) found = n;
  });
  return found;
}
/** Every text the return statements of a function can produce, in source order. Nested functions are skipped. */
function returnTexts(file, fnName) {
  const sf = source(file);
  const fn = functionNamed(sf, fnName);
  if (!fn) throw new Error(`function ${fnName} not found in ${file}`);
  const list = [];
  const visit = (n) => {
    if (n !== fn && ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) list.push(...variants(sf, n.expression));
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return uniq(list.filter((m) => m && !/^<[^<>]+>$/.test(m)));
}
/**
 * The texts a function builds up in a local `out` string before it prints it: the initializer of `let out = ...`
 * and every `out += ...`, in source order. Parts that are only a placeholder, such as `out += report(...)`, are left out.
 */
function outTexts(file, fnName) {
  const sf = source(file);
  const fn = functionNamed(sf, fnName);
  if (!fn) throw new Error(`function ${fnName} not found in ${file}`);
  const list = [];
  walk(fn, (n) => {
    if (ts.isVariableDeclaration(n) && n.name.getText(sf) === 'out' && n.initializer) list.push(...variants(sf, n.initializer));
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken && n.left.getText(sf) === 'out') list.push(...variants(sf, n.right));
  });
  return uniq(list.map((m) => m.replace(/\n+$/, '')).filter((m) => m && !/^<[^<>]+>$/.test(m)));
}
/** Every string literal in a file that starts with `prefix`. */
function literalStartingWith(file, prefix) {
  const sf = source(file);
  let found = null;
  walk(sf, (n) => {
    if (!found && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text.startsWith(prefix)) found = n.text;
  });
  if (found === null) throw new Error(`no string starting with "${prefix}" in ${file}`);
  return found;
}
/** The messages a command prints: the first argument of io.stdout, io.stderr and `new <errorClass>`, in source order. */
function printedMessages(file, errorClass) {
  const sf = source(file);
  const list = [];
  walk(sf, (n) => {
    let arg;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText(sf) === 'io' && ['stdout', 'stderr'].includes(n.expression.name.text)) arg = n.arguments[0];
    else if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === errorClass) arg = n.arguments?.[0];
    if (arg) list.push(...variants(sf, arg));
  });
  return uniq(list.map((m) => m.replace(/\n?Usage:[\s\S]*$/, '').replace(/\n+$/, '').replace(/\n/g, ' ').trim()).filter((m) => m && m !== '<value>' && !/^<[^<>]+>$/.test(m) && !/<diff>|\(formatting only\)/.test(m)));
}

/* ---------- the built CLI ---------- */
function runCli(args) {
  // CLI_BIN, relative to the repository root, points at another build of the CLI.
  const bin = process.env.CLI_BIN ? path.resolve(repo, process.env.CLI_BIN) : rel('cli/dist/index.js');
  if (!existsSync(bin)) throw new Error(`The built CLI is missing at ${bin}. Run \`npm run build\` first, or set CLI_BIN.`);
  return execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', SLOPBUCKETS_NO_UPDATE_CHECK: '1' } });
}
/** Runs the built CLI and returns stderr. For the error messages that list the agents and their events. */
function cliStderr(args, cwd = repo) {
  const bin = process.env.CLI_BIN ? path.resolve(repo, process.env.CLI_BIN) : rel('cli/dist/index.js');
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, input: '', encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', SLOPBUCKETS_NO_UPDATE_CHECK: '1' } });
  return result.stderr ?? '';
}
/**
 * Every agent of `buckets init --agent`, with the events of `buckets hook --agent <name>`. The CLI lists the agents
 * when it gets an unknown name, before it writes anything, and lists an agent's events when it gets an unknown event.
 * An agent without hooks gets an empty list.
 */
function cliAgents() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'slopbuckets-docs-'));
  let text;
  try {
    text = cliStderr(['init', '--agent', 'docs-generator-unknown-agent'], scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const m = /Known agents: (.+?), or auto\b/.exec(text);
  if (!m) throw new Error(`\`buckets init --agent <unknown>\` no longer lists the agents. Update cliAgents in docs/scripts/generate.mjs. It printed: ${text}`);
  return m[1].split(',').map((name) => name.trim()).filter(Boolean).map((name) => {
    const answer = cliStderr(['hook', '--agent', name, 'docs-generator-unknown-event']);
    const events = /Events: (.+?)\.\s*$/m.exec(answer);
    return { name, events: events ? events[1].split(',').map((e) => e.trim()) : [] };
  });
}
/** The title in the front matter of a guide page. */
function pageTitle(file) {
  const m = /^---\n[\s\S]*?^title: (.+)$/m.exec(read(file).replace(/\r\n/g, '\n'));
  if (!m) throw new Error(`${file} has no title in its front matter`);
  return m[1].trim();
}
function parseHelp(text) {
  const sections = {};
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    if (/^\S/.test(line)) {
      const m = /^([A-Z][^:]*?):?$/.exec(line);
      current = m && !line.startsWith('Usage') ? m[1] : null;
      if (current) sections[current] = [];
      continue;
    }
    if (!current) continue;
    // An entry is indented by 2 spaces. A command wider than the first column, such as
    // `inspect --export <format>`, stands alone on its line and its description follows on the next lines.
    const entry = /^ {2}(\S.*?)\s{2,}(\S.*)$/.exec(line);
    const list = sections[current];
    if (entry) list.push([entry[1], entry[2]]);
    else if (/^ {2}\S/.test(line)) list.push([line.trim(), '']);
    else if (list.length) list[list.length - 1][1] = `${list[list.length - 1][1]} ${line.trim()}`.trim();
  }
  return sections;
}
/** The usage lines in a rendered string: `Usage: buckets ...` on one line, or `Usage:` followed by indented lines. */
function usageLines(s) {
  const list = [];
  const block = /Usage:\n((?: {2}buckets[^\n]*(?:\n|$))+)/.exec(s);
  if (block) list.push(...block[1].split('\n').map((l) => l.trim()).filter(Boolean));
  const one = /Usage: (buckets [^\n]*?)(?:\\n|\n|$)/.exec(s);
  if (one) list.push(one[1].trim().replace(/\.$/, ''));
  return list;
}

/* ---------- page helpers ---------- */
const GEN = '<p class="gen-note">Generated from the source code by <code>docs/scripts/generate.mjs</code>. Do not edit this page by hand.</p>';
const front = (title, description) => `---\ntitle: ${title}\ndescription: ${description}\n---\n\n`;
// Vue condenses whitespace in templates, so a line break becomes <br> and the indent of the next line &nbsp;.
const msgText = (m) => esc(m).replace(/\n( *)/g, (_, indent) => `<br>${'&nbsp;'.repeat(indent.length)}`);
const msgBlock = (messages) => messages.map((m) => `<div class="msg" v-pre>${msgText(m)}</div>`).join('\n');
const codeBlock = (lang, text) => `\`\`\`${lang}\n${text}\n\`\`\``;
function table(head, allRows) {
  // A column with no text in any row, such as Notes for a type without doc comments, is left out.
  const cols = head.map((_, i) => i).filter((i) => allRows.some((r) => String(r[i] ?? '').trim()));
  head = cols.map((i) => head[i]);
  const rows = allRows.map((r) => cols.map((i) => r[i]));
  return `<div class="table-wrap"><table v-pre>\n<thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>\n<tbody>\n${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n')}\n</tbody>\n</table></div>`;
}
function check(list, map, what) {
  const missing = list.filter((id) => !(id in map));
  const extra = Object.keys(map).filter((id) => !list.includes(id));
  if (missing.length || extra.length) {
    throw new Error(`${what}: the explanations in docs/scripts/explanations.mjs are out of date. Missing: ${missing.join(', ') || 'none'}. Not in the code: ${extra.join(', ') || 'none'}.`);
  }
}
/** One section per type: its doc comment, its source and a table of its fields. */
const typeSections = (decls, level = '###') =>
  decls.map((d) => `${level} ${d.name}\n\n${d.doc ? inline(d.doc) + '\n\n' : ''}${codeBlock('ts', d.text)}\n${d.members.length ? '\n' + table(['Field', 'Type', 'Notes'], d.members.map((m) => [`<code>${esc(m.name)}${m.optional ? '?' : ''}</code>`, `<code>${esc(m.type)}</code>`, inline(m.doc)])) + '\n' : ''}`).join('\n');

/* =====================================================================
   Pages
   ===================================================================== */
const pages = {};
const AGENTS_JSON = 'agents.json';
let agentList = [];
const pkg = JSON.parse(read('cli/package.json'));
const LOCK_FILE = constString(source('cli/src/core/paths.ts'), 'LOCK_FILE');
const LINKS_FILE = constString(source('cli/src/core/links.ts'), 'LINKS_FILE');

/* ---------- CLI ---------- */
{
  const help = runCli(['--help']);
  const version = runCli(['--version']).trim();
  const sections = parseHelp(help);
  const commands = sections.Commands ?? [];
  const options = sections.Options ?? [];
  const exits = sections['Exit codes of check'] ?? [];
  if (!commands.length) throw new Error('No commands found in `buckets --help`. The help layout changed: update parseHelp in docs/scripts/generate.mjs.');
  const usages = uniq(tsFiles('cli/src/commands').flatMap((f) => {
    const sf = source(f);
    const list = [];
    walk(sf, (n) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
        const s = render(sf, n);
        if (s && s.includes('Usage:')) list.push(...usageLines(s));
      }
    });
    return list;
  }));
  const hookEvents = (() => {
    const { sf, obj } = objectLiteralOf('cli/src/hooks/adapters/claude.ts', 'HOOK_EVENTS');
    return obj.elements.map((e) => render(sf, e));
  })();
  // `buckets hook` has no usage line of its own: an unknown event or agent prints the list instead.
  usages.push('buckets hook [--agent <name>] <event>');
  usages.sort();
  const agents = cliAgents().map((agent) => {
    const page = agent.name === 'claude' ? 'guide/claude-code.md' : `guide/agents/${agent.name}.md`;
    if (!existsSync(rel(`docs/${page}`))) throw new Error(`The agent "${agent.name}" has no guide page at docs/${page}. Write one and add it to the sidebar.`);
    return { ...agent, title: pageTitle(`docs/${page}`), link: `../${page.replace(/\.md$/, '')}` };
  });
  agentList = agents.map(({ name, title, events }) => ({ name, title, hooks: events.length > 0 }));
  const nextStep = recordOf('cli/src/output/text.ts', 'NEXT_STEP');
  const webResults = recordOfObjects('cli/src/commands/refresh-web.ts', 'RESULT');
  pages['cli.md'] = front('CLI reference', 'Every buckets command and option, taken from the built CLI.') +
`# CLI reference

${GEN}

The package on npm is <code>${esc(pkg.name)}</code> and the command is <code>buckets</code>. This page was built with this CLI:

${codeBlock('text', `$ buckets --version\n${version}`)}

## Commands

${table(['Command', 'What it does'], commands.map(([c, d]) => [`<code>buckets ${esc(c)}</code>`, inline(d)]))}

## Options

${table(['Option', 'What it does'], options.map(([c, d]) => [`<code>${esc(c)}</code>`, inline(d)]))}

## Usage lines

Each command prints its usage line when it gets an option it does not know. Together they list every flag.

${codeBlock('text', usages.join('\n'))}

## Hook events

<code>buckets hook &lt;event&gt;</code>, without <code>--agent</code>, runs a Claude Code hook and accepts these events. See [Claude Code hooks](./hooks) for what each one reads and writes.

${table(['Event'], hookEvents.map((e) => [`<code>${esc(e)}</code>`]))}

## Agents

<code>buckets init --agent &lt;name&gt;</code> installs the hooks of these agents, and <code>buckets hook --agent &lt;name&gt; &lt;event&gt;</code> runs one of them, reading and writing JSON in that agent's own format. <code>--agent</code> takes a comma separated list, such as <code>--agent codex,cursor</code>. <code>--agent auto</code> picks every agent whose folder or file exists in the project, such as <code>.codex</code> or <code>.cursor</code>. <code>buckets init --git-hook</code> adds a git pre-commit hook that runs <code>buckets check</code> whatever the agent, and <code>--no-git-hook</code>, the default, leaves the git hooks alone. An agent without hook events gets only the <code>AGENTS.md</code> block and the skill. Every hook fails open. When the <code>buckets</code> command is missing, the agent's call goes through. The [Supported agents](../guide/agents/) page compares what each agent supports.

${table(['Agent', '--agent', 'Events of buckets hook --agent'], agents.map((a) => [`<a href="${a.link}">${esc(a.title)}</a>`, `<code>${esc(a.name)}</code>`, a.events.length ? a.events.map((e) => `<code>${esc(e)}</code>`).join(', ') : 'none, the agent has no hooks']))}

## Exit codes of check

${table(['Code', 'In the help', 'Last line of the text report'], exits.map(([code, d]) => [`<code>${esc(code)}</code>`, inline(d), inline(nextStep[code] ?? '')]))}

The JSON report of <code>buckets check --json</code> is described in [Check report](./report). With nested projects, the exit code is 3 when any project has an environment problem, else 1 when any project breaks a rule, else 2 when any project differs from its lock, else 0.

## Results of refresh --web

<code>buckets refresh --web</code> waits for the decision on the review page and ends with one of these results. A result with exit code 0 goes to stdout, the others to stderr.

${table(['Result', 'Exit code', 'Last line'], Object.entries(webResults).map(([k, v]) => [`<code>${esc(k)}</code>`, `<code>${esc(v.code)}</code>`, inline(v.text ?? '')]))}

Before the page opens, it exits with 1 when a rule is broken or when the machine cannot show a confirmation window, and with 3 for an environment problem. See [The approval flow](../guide/approval).

## Messages of refresh, refresh --web, inspect and update

What these commands print besides the report and the diff, in the order of the source. Words in angle brackets stand for values the CLI fills in, and text in square brackets appears only in some cases.

### buckets refresh

${msgBlock(printedMessages('cli/src/commands/refresh.ts'))}

### buckets refresh --web

${msgBlock(printedMessages('cli/src/commands/refresh-web.ts'))}

### buckets inspect

${msgBlock(printedMessages('cli/src/commands/inspect.ts'))}

### buckets update

${msgBlock(printedMessages('cli/src/commands/update.ts'))}

Every command except <code>buckets hook</code>, <code>buckets check --file</code> and <code>buckets update</code> first prints this line on stderr when the registry has a newer version. It reads the registry at most once a day, and never when <code>CI</code> or <code>SLOPBUCKETS_NO_UPDATE_CHECK=1</code> is set:

${msgBlock(propValues('cli/src/core/update.ts', 'message'))}

A human runs <code>buckets update</code>. The [agent hooks](./hooks#pre-tool-use) deny an agent's <code>buckets update</code> without <code>--check</code> or <code>--json</code>, and tell it to give the human the version from this line.

The messages of <code>buckets link</code> are on the [Links registry](./links#what-buckets-link-prints) page.

## Full help text

${codeBlock('text', `$ buckets --help\n${help.trimEnd()}`)}
`;
}

/* ---------- rules ---------- */
{
  const ids = unionOf('cli/src/core/types.ts', 'RuleId');
  check(ids, EXPLAIN_RULE, 'RuleId');
  const cliFiles = tsFiles('cli/src');
  const extra = {
    'config-invalid': callArgs(source('cli/src/core/config.ts'), 'invalid', 0),
    'dmz-path': propValues('cli/src/core/dmz-path.ts', 'error'),
    'link-missing-dependency': returnTexts('cli/src/core/check.ts', 'missingDependencyMessage'),
  };
  // Parts that a message joins in at run time, shown after the message.
  const joined = {
    'link-missing-dependency': ['<parts>', callArgs(source('cli/src/core/check.ts'), 'parts.push', 0)],
  };
  const fromAdapter = {
    'project-config': callArgs(source('adapters/ts/src/project-config.ts'), 'problems.push', 0),
    'dmz-syntax': callArgs(source('adapters/ts/src/analyze.ts'), 'violation', 1),
    'import-global': propValues('adapters/ts/src/code.ts', 'message'),
  };
  const grouped = RULE_GROUPS.map(([prefix, title]) => [title, ids.filter((id) => id.startsWith(prefix))]);
  const rest = ids.filter((id) => !RULE_GROUPS.some(([prefix]) => id.startsWith(prefix)));
  if (rest.length) grouped.push(['Other rules', rest]);
  let body = '';
  for (const [title, list] of grouped) {
    if (!list.length) continue;
    body += `\n## ${title}\n`;
    for (const id of list) {
      // A message about a leftover of a retired command names that command, which the docs no longer describe. The
      // explanation of the rule covers that case in its own words.
      const msgs = uniq([...(extra[id] ?? []), ...messagesFor(id, cliFiles)]).filter((m) => !/\blink build\b/.test(m));
      body += `\n### ${id}\n\n${inline(EXPLAIN_RULE[id])}\n\n`;
      if (msgs.length) body += `What the CLI prints:\n\n${msgBlock(msgs)}\n`;
      if (joined[id]?.[1].length) body += `
In place of <code>${esc(joined[id][0])}</code>, the text for each side that lacks the package: the first one below when it is missing for type checking, and one of the others when it is missing at runtime:

${msgBlock(joined[id][1])}
`;
      if (fromAdapter[id]?.length) body += `\nMessages from the TypeScript adapter that can appear in place of <code>&lt;message&gt;</code>:\n\n${msgBlock(fromAdapter[id])}\n`;
    }
  }
  pages['rules.md'] = front('Rule ids', 'Every rule id buckets check reports, with the messages the CLI prints.') +
`# Rule ids

${GEN}

A broken rule makes <code>buckets check</code> exit with code 1. The text report groups the problems by file and tags each one with its rule id. The JSON report puts the id in <code>violations[].rule</code>. There are ${ids.length} rule ids.

Words in angle brackets, such as <code>&lt;target&gt;</code>, stand for values the CLI fills in. Text in square brackets appears only in some cases.

${table(['Rule id', 'When'], ids.map((id) => [`<a href="#${id}"><code>${id}</code></a>`, inline(EXPLAIN_RULE[id])]))}
${body}`;
}

/* ---------- lock changes and environment codes ---------- */
{
  const kinds = unionOf('cli/src/core/types.ts', 'LockChangeKind');
  check(kinds, EXPLAIN_LOCK, 'LockChangeKind');
  const files = ['cli/src/core/lock.ts', 'cli/src/core/check.ts'];
  const signs = recordOf('cli/src/output/text.ts', 'SIGNS');
  const labels = switchReturns('cli/src/output/text.ts', 'describeChange');
  const labelWidth = Number(/const LABEL_WIDTH = (\d+)/.exec(read('cli/src/output/text.ts'))?.[1] ?? 22);
  const heading = literalStartingWith('cli/src/output/text.ts', 'Only a human approves these');
  let lockBody = '';
  for (const k of kinds) {
    const msgs = messagesFor(k, files);
    lockBody += `\n### ${k}\n\n${inline(EXPLAIN_LOCK[k])}\n\n`;
    if (msgs.length) lockBody += `The message in the JSON report of <code>buckets check</code>:\n\n${msgBlock(msgs)}\n`;
    if (labels[k]) {
      const line = Array.isArray(labels[k])
        ? `${signs[k] ?? ''} ${labels[k][0].padEnd(labelWidth)}${labels[k][1]}${/symbol|signature/.test(k) ? '  <symbol>' : ''}`
        : `${signs[k] ?? ''} ${labels[k]}`;
      lockBody += `\nIn the <code>buckets refresh</code> diff:\n\n${msgBlock([line])}\n`;
    }
  }
  const codes = unionOf('cli/src/core/types.ts', 'EnvironmentCode');
  check(codes, EXPLAIN_ENV, 'EnvironmentCode');
  const envFiles = [...tsFiles('cli/src'), ...tsFiles('adapters/ts/src')];
  let envBody = '';
  for (const c of codes) {
    const msgs = messagesFor(c, envFiles);
    envBody += `\n### ${c}\n\n${inline(EXPLAIN_ENV[c])}\n\n${msgs.length ? `What the CLI prints:\n\n${msgBlock(msgs)}\n` : ''}`;
  }
  pages['lock.md'] = front('Lock differences and environment codes', 'Lock change kinds (exit code 2) and environment codes (exit code 3), from the CLI source.') +
`# Lock differences and environment codes

${GEN}

## Lock differences

When every rule passes but the project differs from <code>${LOCK_FILE}</code>, <code>buckets check</code> exits with code 2 and lists each difference under this heading:

${msgBlock([`Lock differences\n  ${heading}`])}

Each line has a sign (<code>+</code> new, <code>-</code> gone, <code>~</code> changed), the kind, the path and, for symbol changes, the symbol. The JSON report puts each difference in <code>lockChanges[]</code> with its <code>kind</code>, <code>path</code>, <code>message</code> and, for symbol changes, <code>symbol</code>. With nested projects, <code>project</code> says which lock it is about. Only a human approves these, with <code>buckets refresh</code> or by typing the confirmation code that <code>buckets refresh --web</code> asks for. The file itself is described in [Lock file](./lockfile).

${table(['Kind', 'When'], kinds.map((k) => [`<a href="#${k}"><code>${k}</code></a>`, inline(EXPLAIN_LOCK[k])]))}
${lockBody}
## Environment codes

An environment problem stops the check with exit code 3. The JSON report puts it in <code>environment</code>, with a <code>code</code> and a <code>message</code>, and the text report starts with <code>Environment problem (&lt;code&gt;)</code>. When the problem is in a nested project, the message starts with <code>In the nested project &lt;path&gt;:</code>.

${table(['Code', 'When'], codes.map((c) => [`<a href="#${c}"><code>${c}</code></a>`, inline(EXPLAIN_ENV[c])]))}
${envBody}`;
}

/* ---------- check report ---------- */
{
  const decl = declarations('cli/src/core/types.ts');
  const pick = (n) => decl.find((d) => d.name === n);
  const show = ['CheckReport', 'Violation', 'LockChange'].map(pick).filter(Boolean);
  const nextStep = recordOf('cli/src/output/text.ts', 'NEXT_STEP');
  const projectTitle = (() => {
    const sf = source('cli/src/output/text.ts');
    let found = null;
    walk(sf, (n) => {
      if (!found && ts.isConditionalExpression(n) && /where the check ran/.test(n.getText(sf))) found = variants(sf, n);
    });
    return found ?? [];
  })();
  pages['report.md'] = front('Check report', 'The JSON report of buckets check --json, with the project fields of the recursive check.') +
`# Check report

${GEN}

## JSON report

<code>buckets check --json</code> writes one <code>CheckReport</code> object to stdout, and the process exits with its <code>exitCode</code>. Paths in <code>file</code> and <code>path</code> are relative to the project named in <code>project</code> and use <code>/</code>, also on Windows.

The CLI always fills in <code>project</code> and <code>projects</code>. The project where the check ran is <code>.</code>, and a nested project is its folder relative to that one, such as <code>root/web/_/kit</code>. <code>buckets check --no-recursive</code> lists only <code>.</code>, and <code>buckets check --file</code> lists only the project of the file. The fields are optional in the types because the programmatic API also returns the report of a single project, without them.

The top-level <code>exitCode</code> is 3 when any project has an environment problem, else 1 when any project breaks a rule, else 2 when any project differs from its lock, else 0. Each entry of <code>projects</code> keeps the exit code of that project alone.

${typeSections(show)}

The id types are listed in [Rule ids](./rules) and [Lock differences and environment codes](./lock).

## Text report

Without <code>--json</code>, the report is plain text grouped by file. With nested projects, each project with problems gets its own heading:

${msgBlock(projectTitle.map((t) => `== ${t}`))}

The report ends with a summary line and one line that depends on the exit code:

${table(['Exit code', 'Last line'], Object.entries(nextStep).map(([k, v]) => [`<code>${esc(k)}</code>`, inline(v)]))}
`;
}

/* ---------- lock file ---------- */
{
  const decl = declarations('cli/src/core/types.ts');
  const pick = (n) => decl.find((d) => d.name === n);
  const lockSrc = read('cli/src/core/lock.ts');
  const lockVersion = Number(/export const LOCK_VERSION = (\d+)/.exec(lockSrc)?.[1]);
  if (!lockVersion) throw new Error('LOCK_VERSION not found in cli/src/core/lock.ts');
  // The doc comment of `dmz` describes a field of version 2 locks in the words of the old link format. The page
  // says what that field means today instead.
  const OLD = '.external/';
  const legacy = (d) => ({
    ...d,
    text: d.text.replace(/\/\*\*[^]*?\*\/\r?\n[ \t]*/g,(c) => (c.includes(OLD) ? '' : c)),
    members: d.members.map((m) => (m.doc.includes(OLD) ? { ...m, doc: '`external` is only in locks of version 2, from an older link format. The CLI ignores it.' } : m)),
  });
  pages['lockfile.md'] = front('Lock file', `The shape of ${LOCK_FILE}, version ${lockVersion}, with nested projects and links.`) +
`# Lock file

${GEN}

<code>${LOCK_FILE}</code> records the last state a human approved. Each project has its own lock, nested projects included. Only <code>buckets refresh</code> writes it, in a terminal or after the confirmation that <code>buckets refresh --web</code> asks for. Agents read it and never write it.

The current format is <code>lockVersion: ${lockVersion}</code>. The CLI also reads older locks. Version 1 locks were written before nested projects and links, and the CLI reads them as if the newer sections were empty. Version 2 locks hold links in an older format, without the alias and the published symbols, so every link in them shows up as <a href="./lock#link-changed"><code>link-changed</code></a> until a human approves again. Versions 1 to 3 store only a hash of the config. The CLI compares that hash with the hash of the current config, so an unchanged config is not a difference, and a review of a changed one shows the current values and says the old ones were not recorded. The next approval writes version ${lockVersion}. Keys are sorted and the file ends with a line feed, so the lock diffs cleanly in a pull request.

## What each field holds

${table(['Field', 'Holds'], [
  ['<code>lockVersion</code>', `The format version, ${lockVersion} today.`],
  ['<code>cli</code>', 'The CLI version that wrote the lock. <code>buckets check</code> refuses to run with another version and exits with code 3. CI installs this version.'],
  ['<code>adapter</code>', 'The adapter name and version, and <code>toolchain</code>: the tools whose version can change signature hashes, such as <code>typescript@5.9.3</code>. A different toolchain alone is not a problem. The check exits with code 3 only when the toolchain changed and a signature hash changed too.'],
  ['<code>config</code>', '<code>buckets.config.json</code> with the defaults filled in, its keys sorted and without <code>$schema</code>, so a formatting change is not a difference. <code>access</code> and <code>layout</code> are there only when the config has them, with <code>allow</code> and <code>deny</code> always present and sorted. Each access line is in the form <code>A -&gt; B</code>. Locks of versions 1 to 3 hold a <code>sha256:</code> hash of the same object instead.'],
  ['<code>buckets</code>', 'Every bucket folder, sorted.'],
  ['<code>dmz</code>', 'For each DMZ file, <code>.external.ts</code> files included, a hash of its text and a hash of the type signature of each symbol it re-exports. The text hash ignores line endings (CRLF counts as LF) and a leading byte order mark, so an editor that adds or drops either one does not change it.'],
  ['<code>projects</code>', 'Nested projects, relative to this project. Each one has its own lock. Left out when there are none.'],
  ['<code>links</code>', 'Registered links by link folder: the name, the origin project folder, the mode, the alias of the origin and, in <code>symbols</code>, the signature hash of every symbol the origin publishes, by <code>.external.ts</code> file. A change inside the origin that keeps these hashes is not a difference. <code>symbols</code> is left out when the link was missing on disk at approval time. Left out when there are none.'],
])}

## Types

${typeSections(['Lock', 'LockLink'].map(pick).filter(Boolean).map(legacy))}

## Example

A project with two nested projects and two links. Hashes are shortened.

${codeBlock('json', JSON.stringify({
  adapter: { name: 'ts', toolchain: 'typescript@5.9.3', version: pkg.version },
  buckets: ['root', 'root/api', 'root/store', 'root/web'],
  cli: pkg.version,
  config: { access: { allow: ['** -> root/store'], default: 'deny', deny: [] }, adapter: 'ts', alias: '@root', layout: { allow: ['root/*/*'], default: 'deny', deny: [] }, root: 'root' },
  dmz: {
    'root/dmz/api/web.ts': { symbols: { route: 'sha256:a361...' }, text: 'sha256:2dda...' },
    'root/dmz/store/api.ts': { symbols: { query: 'sha256:6b13...' }, text: 'sha256:cff1...' },
  },
  links: {
    'root/web/_/links/billing': {
      alias: '@root-p7hq2wxe', mode: 'link', name: 'billing', origin: '../billing',
      symbols: { 'dmz/invoices/.external.ts': { Invoice: 'sha256:f30a...', createInvoice: 'sha256:7925...' } },
    },
    'root/web/_/links/kit': {
      alias: '@root-9ajxwndv', mode: 'copy', name: 'kit', origin: 'root/web/_/kit',
      symbols: { 'dmz/theme/.external.ts': { Theme: 'sha256:41d2...' } },
    },
  },
  lockVersion,
  projects: ['root/store/_/engine', 'root/web/_/kit'],
}, null, 2))}

The nested project <code>root/web/_/kit</code> publishes <code>root/dmz/theme/.external.ts</code>. Its own lock pins that file like any other DMZ file, and the lock of every project that links it pins the same signature under <code>links</code>:

${codeBlock('json', JSON.stringify({ 'root/dmz/theme/.external.ts': { symbols: { Theme: 'sha256:41d2...' }, text: 'sha256:77e5...' } }, null, 2))}

Every difference between this file and the project is listed in [Lock differences](./lock).
`;
}

/* ---------- config ---------- */
{
  const schema = JSON.parse(read('site/schema/v1.json'));
  const props = Object.entries(schema.properties).filter(([k]) => k !== '$schema');
  /** A property with its `$ref` resolved: the definition, with the property's own keywords on top. */
  const resolved = (v) => (v.$ref ? { ...schema.$defs[v.$ref.replace('#/$defs/', '')], ...v } : v);
  const typeOf = (v) => {
    const r = resolved(v);
    return r.type === 'array' && r.items?.type ? `${r.items.type}[]` : r.type;
  };
  const defaultOf = (v) => (v.default === undefined ? 'not set' : `<code>${esc(JSON.stringify(v.default))}</code>`);
  const constraint = (v) => {
    const r = resolved(v);
    return [
      r.enum ? `one of ${r.enum.map((e) => `\`${JSON.stringify(e)}\``).join(', ')}` : '',
      r.minLength ? `at least ${r.minLength} character` : '',
      r.minimum !== undefined ? `at least ${r.minimum}` : '',
      r.properties ? `an object with ${Object.keys(r.properties).map((k) => `\`${k}\``).join(', ')}` : '',
      r.uniqueItems ? 'no item twice' : '',
    ].filter(Boolean).join(', ');
  };
  const example = { $schema: schema.$id, ...Object.fromEntries(props.filter(([, v]) => v.default !== undefined).map(([k, v]) => [k, v.default])) };
  // Every object property gets a section of its own with its fields, so nested keys are documented too.
  const nested = props.filter(([, v]) => resolved(v).type === 'object' && v.properties).map(([k, v]) => {
    const required = new Set(v.required ?? []);
    const fields = Object.entries(v.properties);
    // Array fields whose items have a description of their own, such as the lines of access.allow and access.deny.
    const lists = fields.filter(([, f]) => resolved(f).items?.description);
    const sample = v.examples?.[0];
    // A <p> keeps Markdown from reading the `**` of a pattern as bold.
    const itemsText = lists.length
      ? `<p>Each item of ${lists.map(([name]) => `<code>${esc(`${k}.${name}`)}</code>`).join(' and ')} is one line. ${uniq(lists.map(([, f]) => inline(resolved(f).items.description))).join(' ')}</p>`
      : '';
    return `
## ${k}

${inline(v.description)}

${sample ? codeBlock('json', JSON.stringify({ [k]: sample }, null, 2)) : ''}

${table(['Field', 'Type', 'Required', 'Allowed values', 'Meaning'], fields.map(([name, f]) => [`<code>${esc(`${k}.${name}`)}</code>`, `<code>${esc(typeOf(f))}</code>`, required.has(name) ? 'yes' : 'no', inline(constraint(f)), inline(f.description)]))}

${itemsText}
${k === 'access' ? `
A malformed line, a line listed twice in one list, the same line in both lists and an unknown field inside <code>access</code> are <a href="./rules#config-invalid"><code>config-invalid</code></a>. How a line matches an import, which line decides when several match, and what the agent does when an import is denied are in [Access rules](../guide/concepts#access-rules). The violations are on the [rules reference](./rules#access-rules).
` : ''}${k === 'layout' ? `
A malformed line, a line listed twice in one list, the same line in both lists and an unknown field inside <code>layout</code> are <a href="./rules#config-invalid"><code>config-invalid</code></a>. The lines use the patterns of access lines, and the most specific matching line decides in the same way. How the parents of an allowed bucket pass, and what the agent does when a folder is denied, are in [Layout](../guide/concepts#layout). The violations are on the [rules reference](./rules#layout).
` : ''}`;
  }).join('');
  // The syntax of bucket path patterns, as cli/src/core/bucket-glob.ts parses it.
  const PATTERN_ROWS = [
    ['<code>**</code>', 'zero or more bucket names, as a whole segment', '<code>root/teams/**</code> matches <code>root/teams</code> and every bucket below it'],
    ['<code>*</code>', 'any characters inside one name', '<code>root/team-*</code> matches <code>root/team-a</code>'],
    ['<code>{a,b}</code>', 'one of the alternatives, separated by commas', '<code>root/{api,web}</code> matches <code>root/api</code> and <code>root/web</code>'],
    ['<code>&lt;a,b&gt;</code>', 'one of the alternatives, and the <code>&lt;...&gt;</code> groups of one name match values that differ from each other', '<code>root/&lt;A,B,C&gt;+&lt;A,B,C&gt;</code> matches <code>root/A+B</code> and <code>root/B+A</code>, not <code>root/A+A</code>'],
    ['<code>&lt;&lt;a,b&gt;&gt;</code>', 'one of the alternatives, and the <code>&lt;&lt;...&gt;&gt;</code> groups of one name match values in strictly increasing order, by character code, so uppercase sorts before lowercase', '<code>root/&lt;&lt;A,B,C&gt;&gt;+&lt;&lt;A,B,C&gt;&gt;</code> matches <code>root/A+B</code>, <code>root/A+C</code> and <code>root/B+C</code>, not <code>root/B+A</code>'],
  ];
  pages['config.md'] = front('Config reference', 'Every field of buckets.config.json, from the published JSON Schema.') +
`# Config reference

${GEN}

<code>buckets.config.json</code> sits at the root of the project. <code>buckets init</code> writes it, and the CLI finds the project by looking for this file in the current folder and its parents. ${inline(schema.description)}

${codeBlock('json', JSON.stringify(example, null, 2))}

${table(['Field', 'Type', 'Default', 'Allowed values', 'Meaning'], props.map(([k, v]) => [`<code>${esc(k)}</code>`, `<code>${esc(typeOf(v))}</code>`, defaultOf(v), inline(constraint(v)), inline(v.description)]))}

${schema.additionalProperties === false ? 'Unknown fields are not allowed. The check' : 'The check'} reports them as <a href="./rules#config-invalid"><code>config-invalid</code></a>. The <code>$schema</code> field points at the JSON Schema, <a href="${esc(schema.$id)}"><code>${esc(schema.$id)}</code></a>, so editors can autocomplete and validate the file.

A human owns this file. The agent hooks deny every write to any <code>buckets.config.json</code>, nested ones included, as they do for the lock, and the reason they return tells the agent to ask the human for the change. See [Claude Code hooks](./hooks#pre-tool-use).

The lock stores the config with the defaults filled in, its keys sorted and without <code>$schema</code>, so a change in formatting alone is not a lock difference, but a changed value is <a href="./lock#config-changed"><code>config-changed</code></a>. The review lists each change: every <code>access</code> or <code>layout</code> line added or removed, a changed <code>access.default</code> or <code>layout.default</code>, and every other key with its old and new value. Locks older than version 4 store only a hash of the config. See [Lock file](./lockfile).

The default of <code>alias</code> applies only to a config that leaves the field out. <code>buckets init</code> always writes an alias of its own: <code>@</code>, the name of the root bucket folder, a dash and 8 random lowercase letters and digits, such as <code>@root-k3x9pm2a</code>. The 8 characters leave out <code>0</code>, <code>o</code>, <code>1</code>, <code>l</code> and <code>i</code>, which are easy to confuse. Projects that link each other import through each other's alias, so no two projects should share one. Older projects with <code>@root</code> keep working, but <code>buckets link add</code> refuses to link two projects with the same alias.

A nested project has its own <code>buckets.config.json</code> in a subfolder of a bucket's <code>_/</code>. Its <code>alias</code> must differ from the alias of every project around it: the same alias as an enclosing project is <a href="./rules#config-invalid"><code>config-invalid</code></a>. See [Projects and links](../guide/projects-and-links).
## Bucket path patterns

Each side of an <code>access</code> line and each <code>layout</code> line is a pattern over bucket paths, such as <code>root/billing</code>. A pattern starts with the root path or with <code>**</code>. See [Patterns](../guide/concepts#patterns).

${table(['Pattern', 'Matches', 'Example'], PATTERN_ROWS)}
${nested}`;
}

/* ---------- links registry ---------- */
{
  const file = 'cli/src/core/links.ts';
  const decl = declarations(file);
  const reasons = (() => {
    const sf = source(file);
    let list = [];
    walk(sf, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'readLinksManifest') {
        walk(n, (c) => {
          if (ts.isPropertyAssignment(c) && c.name.getText(sf) === 'reason') list.push(...variants(sf, c.initializer));
        });
      }
    });
    return uniq(list);
  })();
  const nameRegex = /export const LINK_NAME = (\/.*\/);/.exec(read(file))?.[1];
  const linkFile = 'cli/src/commands/link.ts';
  const messages = printedMessages(linkFile, 'LinkError');
  const usage = usageLines(constString(source(linkFile), 'LINK_USAGE'));
  const added = outTexts(linkFile, 'addLink');
  const removed = outTexts(linkFile, 'removeLink');
  const edits = uniq([...returnTexts(linkFile, 'tsconfigReport'), ...returnTexts(linkFile, 'excludeReport')].map((m) => m.replace(/\n+$/, '')));
  const bundlers = callArgs(source('cli/src/core/tsconfig-paths.ts'), 'out.push', 0);
  if (!added.length || !removed.length || !edits.length || !bundlers.length) throw new Error('The messages of buckets link add or remove were not found: update the links registry section of docs/scripts/generate.mjs.');
  pages['links.md'] = front('Links registry', `The shape of ${LINKS_FILE}, what buckets link add changes in the project and what the buckets link commands print.`) +
`# Links registry

${GEN}

<code>${LINKS_FILE}</code> sits next to <code>buckets.config.json</code> and lists the links a project wants. The <code>buckets link</code> commands write it, and an agent may edit it by hand, unlike <code>buckets.config.json</code>, which only a human edits. It is not an approval: a new, removed or changed entry is a lock difference until a human approves it. Commit it. For the whole workflow, read [Projects and links](../guide/projects-and-links).

${codeBlock('json', JSON.stringify({ links: {
  'root/web/_/links/billing': { alias: '@root-p7hq2wxe', mode: 'link', origin: '../billing' },
  'root/web/_/links/kit': { alias: '@root-9ajxwndv', mode: 'copy', origin: 'root/web/_/kit' },
} }, null, 2))}

## Fields

${table(['Field', 'Holds'], [
  ['<code>links</code>', 'An object keyed by link folder, <code>&lt;bucket&gt;/_/links/&lt;name&gt;</code>, relative to the project.'],
  ['<code>links[].origin</code>', 'The folder of the origin project, the one that holds its <code>buckets.config.json</code>. It is relative to this project when possible, and absolute when the origin is on another drive. An absolute origin works only on the machine that wrote it. An origin that names a <code>.external</code> file or folder, the format of older versions, makes the file invalid.'],
  ['<code>links[].mode</code>', '<code>link</code> for a junction (Windows) or folder symlink (macOS, Linux) to the root bucket folder of the origin, kept out of git. <code>copy</code> for a committed copy of the <code>.external.ts</code> files of the origin and every file they import.'],
  ['<code>links[].alias</code>', 'The import alias of the origin project, as its <code>buckets.config.json</code> names it. Code imports the link through it.'],
  ['<code>$comment</code>', 'Optional free text. Any other top-level field makes the file invalid.'],
])}

The link name must match \`${nameRegex ?? ''}\`. Every bucket segment of the key must be a plain folder name: no empty segment, no \`.\` or \`..\`, no \`_\` or \`dmz\`, no backslash and no colon. The CLI checks that the real path stays inside \`<bucket>/_/links/\` and never creates, copies or deletes anything outside it.

${typeSections(decl.filter((d) => d.name === 'LinkRequest'))}

## When the file is invalid

<code>buckets link</code> refuses to run and <code>buckets check</code> reports <a href="./rules#config-invalid"><code>config-invalid</code></a>. The reason is one of these:

${msgBlock(reasons)}

## What buckets link add changes

Besides <code>${LINKS_FILE}</code> and the link folder, <code>buckets link add</code> edits two more files and prints what it did:

- <code>tsconfig.json</code>: it maps the alias of the origin to the link folder in <code>compilerOptions.paths</code>, and adds the link folder to <code>exclude</code>, so <code>tsc</code> compiles only the linked files that code imports. It edits the file in place and keeps its comments. When it cannot edit the file safely, it prints the line to add by hand. <code>buckets link remove</code> takes both entries out again.
- <code>.gitignore</code>: a link in <code>link</code> mode gets a <code>/&lt;link folder&gt;</code> line. A copy does not.

It never edits a bundler config. For each Vite, Next.js or webpack config it finds in the project folder, it prints the alias setting to add.

## What buckets link prints

${codeBlock('text', usage.join('\n'))}

Words in angle brackets stand for values the CLI fills in, and text in square brackets appears only in some cases.

### buckets link add

What a successful <code>buckets link add</code> prints, in this order. It exits with code 0.

${msgBlock(added)}

### buckets link remove

${msgBlock(removed)}

### Edits to tsconfig.json

The lines that report the <code>paths</code> and <code>exclude</code> edits of <code>link add</code> and <code>link remove</code>:

${msgBlock(edits)}

### Bundler settings

One block for each bundler config that <code>link add</code> finds:

${msgBlock(bundlers)}

### Other messages and errors

Every other message of the <code>buckets link</code> commands, in the order of the source. An error starts with <code>buckets link &lt;subcommand&gt;:</code> and exits with code 1.

${msgBlock(messages)}
`;
}

/* ---------- adapter protocol ---------- */
{
  const file = 'adapters/ts/src/protocol.ts';
  const decl = declarations(file);
  const kinds = unionOf(file, 'ImportKind');
  check(kinds, EXPLAIN_IMPORT_KIND, 'ImportKind');
  const abi = decl.find((d) => d.name === 'ABI_VERSION');
  const info = runCli(['--version']).trim().split('\n')[1] ?? '';
  pages['adapter-protocol.md'] = front('Adapter protocol', 'The types a language adapter receives and returns, from adapters/ts/src/protocol.ts.') +
`# Adapter protocol

${GEN}

These are the types in <code>adapters/ts/src/protocol.ts</code>. The CLI asks an adapter three things: <code>info</code>, <code>init</code> and <code>analyze</code>. Every request and every response carries the protocol version in <code>abi</code>. The CLI refuses an adapter that speaks a different version and exits with code 3.

Some fields are optional, so an adapter can leave them out:

- <code>nestedProjects</code> on <code>InitRequest</code> and <code>AnalyzeRequest</code> lists the projects nested in this one. <code>init</code> keeps them out of the build, and <code>analyze</code> reports a build setting that still reaches one of them in <code>config</code>.
- <code>links</code> on <code>AnalyzeRequest</code> lists the link folders of the project with the alias of each origin, and <code>AnalyzeResponse.links</code> answers with one <code>LinkReport</code> per link: the symbols the origin publishes, the packages the linked files import and what kept the adapter from reading the link.
- <code>resolvedForTypes</code> and <code>resolvedAtRuntime</code> on a <code>LinkDependency</code> tell the two package lookups apart. Without them, the CLI has only <code>resolved</code>, and the <a href="./rules#link-missing-dependency"><code>link-missing-dependency</code></a> message names both places to install the package.
- <code>written</code> on <code>InitResponse.changed[]</code> is <code>false</code> for a file the adapter left as it was and that needs a hand edit.

${abi ? codeBlock('ts', abi.text) : ''}

The bundled adapter reports: <code>${esc(info)}</code>. For how the pieces fit together, read [Writing an adapter](../guide/adapters).

## Import kinds

The adapter only classifies imports. The CLI decides what is allowed.

${table(['kind', 'Meaning', 'target'], kinds.map((k) => [`<code>${esc(k)}</code>`, inline(EXPLAIN_IMPORT_KIND[k][0]), inline(EXPLAIN_IMPORT_KIND[k][1])]))}

## Types

${typeSections(decl.filter((d) => d.kind !== 'const'))}
`;
}

/* ---------- hooks ---------- */
{
  const { sf, obj } = objectLiteralOf('cli/src/commands/settings.ts', 'HOOKS');
  const hooks = obj.elements.map((e) => Object.fromEntries(e.properties.map((p) => [p.name.getText(sf), render(sf, p.initializer)])));
  check(hooks.map((h) => h.event), EXPLAIN_HOOK, 'HOOKS');
  const deny = constString(source('cli/src/hooks/core.ts'), 'LOCK_DENY_REASON');
  const configDeny = constString(source('cli/src/hooks/core.ts'), 'CONFIG_DENY_REASON');
  const updateDeny = constString(source('cli/src/hooks/core.ts'), 'UPDATE_DENY_REASON');
  if (!deny || !configDeny || !updateDeny) throw new Error('LOCK_DENY_REASON, CONFIG_DENY_REASON or UPDATE_DENY_REASON not found in cli/src/hooks/core.ts');
  const stopIntro = recordOf('cli/src/hooks/core.ts', 'STOP_INTRO');
  const setOf = (name) => {
    const { sf: s, obj: o } = objectLiteralOf('cli/src/hooks/adapters/claude.ts', name);
    return o.arguments[0].elements.map((e) => render(s, e));
  };
  const settings = { hooks: Object.fromEntries(hooks.map((h) => [h.event, [{ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: 'command', command: h.command }] }]])) };
  pages['hooks.md'] = front('Claude Code hooks', 'The hooks buckets init installs, what each one reads and what it writes, from the CLI source.') +
`# Claude Code hooks

${GEN}

<code>buckets init</code> merges these entries into <code>.claude/settings.json</code>. It skips an entry whose command is already there, so running it twice adds nothing. <code>buckets init</code> in a nested project skips this step, because the hooks of the enclosing project already check nested projects.

${codeBlock('json', JSON.stringify(settings, null, 2))}

${table(['Event', 'Matcher', 'Command', 'What it does'], hooks.map((h) => [`<code>${esc(h.event)}</code>`, h.matcher ? `<code>${esc(h.matcher).replace(/\|/g, '|<wbr>')}</code>` : 'every call', `<code>${esc(h.command)}</code>`, inline(EXPLAIN_HOOK[h.event])]))}

## Input

Each hook reads the JSON that Claude Code writes to stdin. The fields the CLI uses:

${table(['Field', 'Used for'], [
  ['<code>CLAUDE_PROJECT_DIR</code> (environment)', 'Where to start looking for <code>buckets.config.json</code>. Without it the hook uses <code>cwd</code> from the input, then the current folder, and walks up the parents. When no project holds that folder, the session was opened above the projects, as described below.'],
  ['<code>cwd</code>', 'The folder relative file paths resolve against. In a session opened above the projects, a shell command belongs to the project nearest to it.'],
  ['<code>session_id</code>', 'In a session opened above the projects, the key of the file that records the projects the session touched. Without a valid id, nothing is recorded.'],
  ['<code>tool_name</code>', `Which tool the agent called. File tools: ${setOf('FILE_TOOLS').map((t) => `<code>${esc(t)}</code>`).join(', ')}. Shell tools: ${setOf('SHELL_TOOLS').map((t) => `<code>${esc(t)}</code>`).join(', ')}. The post-edit check runs for ${setOf('EDIT_TOOLS').map((t) => `<code>${esc(t)}</code>`).join(', ')}.`],
  ['<code>tool_input.file_path</code>, <code>tool_input.notebook_path</code>', 'The file a file tool writes.'],
  ['<code>tool_input.command</code>', 'The command a shell tool runs.'],
  ['<code>stop_hook_active</code>', 'True on the second attempt to stop. The stop hooks then let the agent finish without running the check again.'],
])}

Every hook exits with 0 in all cases, and the decision travels in the JSON on stdout.

## Sessions opened above the projects

Claude Code can open a session in a folder that holds several projects, such as <code>~/code</code>. It then skips the <code>.claude/settings.json</code> of each project, so put the entries above in the <code>.claude/settings.json</code> of that folder or in <code>~/.claude/settings.json</code>. When no project holds <code>CLAUDE_PROJECT_DIR</code>, the hooks work per call:

- A file tool works on the project nearest to its file. A file outside every project passes and nothing runs.
- A shell tool belongs to the project nearest to <code>cwd</code>. The shell rules of the lock guard apply to every command, in a project or not.
- <code>post-tool-use</code> records the project of each file the agent edits, and <code>pre-tool-use</code> records the project of each shell command, in <code>&lt;temp folder&gt;/slopbuckets-sessions/&lt;session_id&gt;.jsonl</code>.
- <code>stop</code> and <code>subagent-stop</code> run the full check in each recorded project, nested projects included, and block once with one report that names the folder of each failing project. With nothing recorded, they let the agent finish. A project whose folder or <code>buckets.config.json</code> is gone leaves the record.

A missing, oversized or malformed record counts as empty, and the next record replaces it. A session opened inside a project records nothing and works as the rest of this page says.

## Output

### pre-tool-use

When a call would write a lock or a config (<code>${LOCK_FILE}</code> or <code>buckets.config.json</code> of any project, nested ones included) or run <code>buckets refresh</code> in any form other than <code>buckets refresh --web</code>, or run <code>buckets update</code> without <code>--check</code> or <code>--json</code>, the hook writes a deny decision. Claude Code applies it even in bypass permission mode. Otherwise it writes nothing.

${codeBlock('json', JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '...' } }, null, 2))}

The reason the agent reads for the lock and for <code>buckets refresh</code>:

${msgBlock([deny])}

The reason for a config:

${msgBlock([configDeny])}

The reason for <code>buckets update</code>:

${msgBlock([updateDeny])}

The file rule denies a file tool when the target is a lock or a config. The rules below name the lock, and they apply to <code>buckets.config.json</code> the same way:

- by name, after Windows drops a stream suffix (<code>${LOCK_FILE}::$DATA</code>) and trailing dots and spaces (<code>${LOCK_FILE}.</code>)
- by identity, when the target or its folder exists: the hook compares the real path, and the device and inode, with the lock of the session project, the lock of the project nearest to the target and the locks of the nested projects listed in the session lock. This catches 8.3 short names such as <code>BUCKET~1.JSO</code>, hard links, symbolic links and linked folders. In a session opened above the projects, a target is a lock when a project holds it and its typed or real name is the lock's, and a target with more than one hard link is compared with the locks of the projects the session recorded and of the projects found up to 3 levels below the session folder.

The shell rule is a text match, after the hook removes quotes, backticks, carets and backslashes, which shells drop. It denies a command when:

- it names the lock or a config: literally, through an 8.3 short name, or through a glob whose last part matches the file name but not <code>package.json</code>, such as <code>bucket*</code>, <code>&#42;.lock.json</code>, <code>&#42;.config.json</code> or <code>b[u]ckets.lock.json</code>. So even <code>cat ${LOCK_FILE}</code> is denied, and the agent reads both files with the Read tool.
- it runs <code>buckets refresh</code> and what follows <code>refresh</code> is not exactly <code>--web</code>, optionally followed by output redirections, then the end of the command or a separator. A redirection goes to a file (<code>&gt; refresh.log</code>, <code>&gt;&gt; refresh.log</code>, <code>&amp;&gt; refresh.log</code>, PowerShell <code>*&gt; refresh.log</code>) or to another stream (<code>2&gt;&amp;1</code>). The separator can be a trailing <code>&amp;</code> or a pipe, as in <code>| tee refresh.log</code>, and <code>nohup</code> in front of the call is allowed too. So an agent can run the command in the background and keep its log. A redirection to the lock names the lock, so the first rule denies it. The program can be <code>buckets</code> or <code>slopbuckets</code>, with a version (<code>npx slopbuckets@0.1.0 refresh</code>), through a Windows shim (<code>buckets.cmd refresh</code>), as a script run by node or tsx (<code>node cli/dist/index.js refresh</code>), or behind a package runner with flags (<code>npm exec slopbuckets -- refresh</code>). Every call in the command must pass, so <code>buckets refresh --web; buckets refresh</code> is denied.
- it runs <code>buckets update</code>, through the same programs as <code>buckets refresh</code> (<code>npx slopbuckets update</code>, <code>pnpm exec buckets update</code>, <code>yarn buckets update</code>, <code>bunx slopbuckets update</code>), and no argument of that call, up to the next separator, is exactly <code>--check</code> or <code>--json</code>. Those two flags only report, so <code>buckets update --check</code> and <code>buckets update --json &gt; update.log</code> pass. A redirection target is not an argument, so <code>buckets update &gt; --check</code> is denied. Every call in the command must pass, so <code>buckets update --check; buckets update</code> is denied. A human updates the CLI.

When this hook crashes, it allows the call, because a crash here would break every tool call the agent makes. When a stop hook or the post-edit hook crashes, it blocks once with the error, so the agent cannot finish with unchecked work.

### stop and subagent-stop

The hook runs the full check from <code>CLAUDE_PROJECT_DIR</code>, nested projects included, or from each recorded project in a session opened above the projects. When it fails, the hook blocks once and hands the report back to the agent. On the second attempt, with <code>stop_hook_active</code> set, it lets the agent finish.

${codeBlock('json', JSON.stringify({ decision: 'block', reason: '<first line by exit code>\n\n<text report>' }, null, 2))}

${table(['Exit code', 'First line of the reason'], Object.entries(stopIntro).filter(([, v]) => v).map(([k, v]) => [`<code>${esc(k)}</code>`, inline(v)]))}

### post-tool-use

After an edit to a file inside the root bucket folder of its nearest project, the session project or one nested in it, the hook runs <code>buckets check --file</code> on that file. When the file breaks a rule, it blocks with the report, so the agent fixes it right away. The orphan rule and the lock comparison do not run here, so a new contract that is not used yet does not trip it.

${codeBlock('json', JSON.stringify({ decision: 'block', reason: 'buckets check --file <path> found problems in the file you just edited. Fix them before you continue.\n\n<text report>' }, null, 2))}
`;
}

/* ---------- inspect snapshot ---------- */
{
  const file = 'cli/src/inspect/snapshot.ts';
  const decl = declarations(file);
  const version = constString(source(file), 'SNAPSHOT_VERSION');
  const types = decl.filter((d) => (d.kind === 'interface' || d.kind === 'type') && d.name !== 'SnapshotOptions');
  const mermaid = declarations('cli/src/inspect/export-mermaid.ts').filter((d) => /^Mermaid/.test(d.name));
  const feedKinds = unionOf('cli/src/inspect/events.ts', 'FeedKind');
  const feed = declarations('cli/src/inspect/events.ts').filter((d) => d.name === 'FeedEvent');
  const routes = (() => {
    const sf = source('cli/src/web/inspect-app.ts');
    const list = [];
    walk(sf, (n) => {
      if (!ts.isObjectLiteralExpression(n)) return;
      const get = (k) => n.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === k);
      const m = get('method'), p = get('path');
      if (m && p && ts.isStringLiteral(p.initializer)) list.push([render(sf, m.initializer), p.initializer.text]);
    });
    return list.filter(([, p]) => !p.startsWith('/assets/'));
  })();
  const ROUTE_TEXT = {
    '/': 'The page. The view and the selection live in the query string, so a link opens the same view.',
    '/api/snapshot': 'The current snapshot, the same object as <code>buckets inspect --json</code>.',
    '/api/timeline': 'The approvals read from git, one track per project.',
    '/export/map.svg': 'The map as SVG. <code>?project=&lt;path&gt;</code> picks a nested project.',
    '/export/buckets.mmd': 'The bucket graph of every project as a Mermaid flowchart.',
    '/api/events': 'Server-Sent Events: <code>hello</code> first, then a new snapshot version and feed events after each change.',
  };
  for (const [, p] of routes) if (!(p in ROUTE_TEXT)) throw new Error(`The inspect route ${p} has no description in docs/scripts/generate.mjs.`);
  pages['inspect.md'] = front('Inspect snapshot', 'The JSON that buckets inspect --json prints, the export output and the endpoints of the inspect page.') +
`# Inspect snapshot

${GEN}

<code>buckets inspect --json</code> prints one <code>InspectSnapshot</code> object and exits with code 0, without a server. The inspect page reads the same object, so an agent that reads the JSON sees what the human sees on the page. The format version is <code>snapshotVersion: ${esc(version)}</code>. It changes when a field changes meaning or goes away. New fields can appear without a version change.

All paths are relative to the project named by <code>project</code> or <code>path</code>, with <code>/</code>. Project paths are relative to the project where inspect started, which is <code>.</code>. Add <code>--no-recursive</code> to leave out the nested projects. For how the views use these fields, read [Inspect](../guide/inspect).

## Snapshot types

${typeSections(types)}

## Export output

<code>buckets inspect --export svg</code> prints the map of the starting project as an SVG file, <code>buckets inspect --export mermaid</code> prints the bucket graph of every project as a Mermaid flowchart, and <code>buckets inspect --export html</code> prints the whole page as one self-contained HTML file. All three exit without a server and never write the analysis cache. <code>--out &lt;file&gt;</code> writes the file instead and refuses a path whose name, or real path, is a lock file, or a folder.

With <code>--json</code>, an export prints an object instead of the raw text:

${codeBlock('ts', `// --export svg --json
{ format: 'svg'; file: string | null; width: number; height: number; text: string }
// --export mermaid --json
{ format: 'mermaid'; file: string | null; nodes: MermaidNode[]; edges: MermaidEdge[]; text: string }
// --export html --json
{ format: 'html'; file: string | null; bytes: number; text: string }`)}

<code>file</code> is the absolute path written with <code>--out</code>, or <code>null</code>.

${typeSections(mermaid)}

## Event feed

The page lists what changed while it was open. Each event has one of these kinds: ${feedKinds.map((k) => `<code>${esc(k)}</code>`).join(', ')}.

${typeSections(feed)}

## Endpoints of the page

<code>buckets inspect</code> listens on <code>127.0.0.1</code> on a free port. It answers only GET requests and rejects a <code>Host</code> or <code>Origin</code> header that is not its own address. Nothing it serves writes to the project.

${table(['Method', 'Path', 'Returns'], routes.map(([m, p]) => [`<code>${esc(m)}</code>`, `<code>${esc(p)}</code>`, ROUTE_TEXT[p]]))}
`;
}

/* ---------- index ---------- */
pages['index.md'] = front('Reference', 'Reference pages generated from the slopbuckets source code.') +
`# Reference

${GEN}

These pages are rebuilt from the code on every docs build, so they match the CLI version they were built with (${esc(pkg.version)}).

${table(['Page', 'Source of truth'], [
  ['<a href="./cli">CLI reference</a>', '<code>buckets --help</code>, <code>cli/src/commands/</code>'],
  ['<a href="./rules">Rule ids</a>', '<code>cli/src/core/types.ts</code> and the rule code'],
  ['<a href="./lock">Lock differences and environment codes</a>', '<code>cli/src/core/types.ts</code>, <code>cli/src/core/lock.ts</code>, <code>cli/src/output/text.ts</code>'],
  ['<a href="./report">Check report</a>', '<code>cli/src/core/types.ts</code>, <code>cli/src/core/recursive.ts</code>'],
  ['<a href="./lockfile">Lock file</a>', '<code>cli/src/core/types.ts</code>, <code>cli/src/core/lock.ts</code>'],
  ['<a href="./config">Config reference</a>', '<code>site/schema/v1.json</code>'],
  ['<a href="./links">Links registry</a>', '<code>cli/src/core/links.ts</code>, <code>cli/src/commands/link.ts</code>'],
  ['<a href="./hooks">Claude Code hooks</a>', '<code>cli/src/hooks/core.ts</code>, <code>cli/src/hooks/adapters/claude.ts</code>, <code>cli/src/commands/settings.ts</code>'],
  ['<a href="./inspect">Inspect snapshot</a>', '<code>cli/src/inspect/</code>, <code>cli/src/web/inspect-app.ts</code>'],
  ['<a href="./adapter-protocol">Adapter protocol</a>', '<code>adapters/ts/src/protocol.ts</code>'],
])}
`;

/* ---------- write ---------- */
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [name, text] of Object.entries(pages)) writeFileSync(path.join(out, name), text.replace(/\n{3,}/g, '\n\n'));
// The agents of `buckets init --agent`, for the install steps in llms.txt (docs/scripts/llms.mjs). Not a page.
writeFileSync(path.join(out, AGENTS_JSON), `${JSON.stringify(agentList, null, 2)}\n`);
console.log(`docs: generated ${Object.keys(pages).length} reference pages in ${path.relative(repo, out)}`);

/* ---------- the logo, shared with the landing page ---------- */
mkdirSync(path.resolve(here, '../public'), { recursive: true });
writeFileSync(path.resolve(here, '../public/logo.svg'), read('site/logo.svg'));
