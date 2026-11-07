// Hand-written import scanner: one pass over the text, no TypeScript. The phase 0 spike checked it against the
// TypeScript AST on about 348k imports.
//
// scan(text) finds every `import`, `export ... from`, `import()`, `require()` and `import x = require()`, with the
// 1-based line of the keyword, the names used and whether each one is type-only. Imports and re-exports in the
// body of `declare module 'x' { ... }` count too. With `exports: true` it also lists the names the file
// exports and the lines that hold anything other than named re-exports, which the public file rules use.
// scan.diff.test.ts compares it with the TypeScript AST on the repo sources and a sample of node_modules.
//
// It skips comments, strings, template literals (with nested ${}) and regex literals, so text that looks like an import
// inside them is ignored. Known limits: JSX text with an unbalanced quote or backtick on one line, and a regex literal
// right after `)` (as in `if (x) /re/.test(y)`), which it reads as a division, and an exported variable statement lists
// only its first name (`export const a = 1, b = 2` gives a, `export const { a } = o` gives none). `typeof import('x')`
// counts as an import() without destructuring.

export interface ScannedName {
  name: string;
  typeOnly: boolean;
}

export interface ScannedImport {
  kind: 'static' | 'dynamic' | 'require';
  /** `export ... from`. */
  reexport: boolean;
  /** The specifier, or the source text of the argument when `literal` is false. */
  specifier: string;
  literal: boolean;
  line: number;
  /** `*` for a namespace import, export *, and import() or require() without destructuring (`const { a } = ...`, or
   * `.then(({ a }) => ...)` for import()). [] for `import 'x'`. */
  names: ScannedName[] | '*';
  /** Named re-exports: each name in the source module and the exported name. */
  exported?: { name: string; as: string; typeOnly: boolean }[];
  /** `export * as ns from`: the namespace name. Null for `export * from`. Undefined for anything else. */
  starAs?: string | null;
}

export interface ScannedExports {
  /** Every exported name with the line of its statement, whatever the statement. */
  names: { name: string; line: number; typeOnly: boolean }[];
  /** Lines that hold top-level code other than named re-exports, in order. */
  codeLines: number[];
}

export interface ScanResult {
  imports: ScannedImport[];
  exports?: ScannedExports;
}

const ID_START = new Uint8Array(128);
const ID_PART = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  const ch = String.fromCharCode(c);
  ID_START[c] = /[A-Za-z_$]/.test(ch) ? 1 : 0;
  ID_PART[c] = /[A-Za-z0-9_$]/.test(ch) ? 1 : 0;
}
// Tokens after which a `/` starts a regex literal instead of a division.
const REGEX_AFTER_KW = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);
const REGEX_AFTER_PUNCT = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '=>', '${']);
// Words after `export` (and `export declare`) that declare one named binding.
const DECLARES = new Set(['function', 'class', 'interface', 'type', 'enum', 'namespace', 'module', 'const', 'let', 'var', 'abstract', 'async']);

export function scan(text: string, options: { exports?: boolean } = {}): ScanResult {
  const n = text.length;
  let i = 0;
  let prev = ''; // previous significant token, for regex detection and member access
  let tok = ''; // current token text ('' at end), set by next()
  let tokStr: string | null = null; // string value when the token is a string literal
  let tokStart = 0;
  const imports: ScannedImport[] = [];
  const withExports = options.exports === true;
  const exportNames: ScannedExports['names'] = [];
  const codeLines: number[] = [];
  // Template literal nesting: each entry is the brace depth at which a ${ ... } closes.
  const tpl: number[] = [];
  let braces = 0;

  // Line of a position. Positions mostly grow, so the count resumes from the last answer.
  let linePos = 0;
  let lineNo = 1;
  function lineAt(pos: number): number {
    if (pos < linePos) {
      linePos = 0;
      lineNo = 1;
    }
    for (let p = text.indexOf('\n', linePos); p >= 0 && p < pos; p = text.indexOf('\n', p + 1)) {
      lineNo++;
      linePos = p + 1;
    }
    return lineNo;
  }
  function markCode(pos: number): void {
    if (!withExports) return;
    const line = lineAt(pos);
    if (codeLines[codeLines.length - 1] !== line) codeLines.push(line);
  }

  function skipTrivia(): void {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff || c === 0xa0 || c === 0x2028 || c === 0x2029 || c === 11 || c === 12) {
        i++;
      } else if (c === 47 /* / */) {
        const d = text.charCodeAt(i + 1);
        if (d === 47) {
          const e = text.indexOf('\n', i + 2);
          i = e < 0 ? n : e + 1;
        } else if (d === 42) {
          const e = text.indexOf('*/', i + 2);
          i = e < 0 ? n : e + 2;
        } else return;
      } else if (c === 35 /* # */ && i === 0 && text.charCodeAt(1) === 33) {
        // shebang
        const e = text.indexOf('\n');
        i = e < 0 ? n : e + 1;
      } else return;
    }
  }

  function readString(q: number): void {
    // i is at the opening quote. Strings end at the closing quote or at a line break (unterminated).
    let j = i + 1;
    let simple = true;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === q) break;
      if (c === 92) {
        simple = false;
        j += 2;
        continue;
      }
      if (c === 10 || c === 13) break;
      j++;
    }
    const raw = text.slice(i + 1, j);
    tokStr = simple ? raw : unescape(raw);
    i = j < n && text.charCodeAt(j) === q ? j + 1 : j;
  }

  // Skips template text from i (just after ` or after the } that closes ${) up to the closing ` or the next ${.
  // Returns the token: '`' at the end of the template, '${' when an expression starts (a regex may follow it).
  function skipTemplate(): string {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 92) i += 2;
      else if (c === 96) {
        i++;
        return '`';
      } else if (c === 36 && text.charCodeAt(i + 1) === 123) {
        i += 2;
        tpl.push(braces);
        braces++;
        return '${';
      } else i++;
    }
    return '`';
  }

  function skipRegex(): void {
    // i is at the opening /
    let j = i + 1;
    let cls = false;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 92) j += 2;
      else if (c === 10 || c === 13) break;
      else if (cls) {
        if (c === 93) cls = false;
        j++;
      } else if (c === 91) {
        cls = true;
        j++;
      } else if (c === 47) {
        j++;
        break;
      } else j++;
    }
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c < 128 && ID_PART[c]) j++;
      else break;
    }
    i = j;
  }

  function regexAllowed(): boolean {
    return prev === '' || REGEX_AFTER_PUNCT.has(prev) || REGEX_AFTER_KW.has(prev);
  }

  // Reads the next significant token into tok. Strings become tok = '"' with tokStr set. Template literals and regex
  // literals become tok = '`' and '/re/'. Updates prev with the token just consumed (the old tok).
  function next(): string {
    prev = tok;
    tokStr = null;
    skipTrivia();
    tokStart = i;
    if (i >= n) {
      tok = '';
      return tok;
    }
    const c = text.charCodeAt(i);
    if (c < 128 && ID_START[c]) {
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d < 128 ? ID_PART[d] : d > 127) j++;
        else break;
      }
      tok = text.slice(i, j);
      i = j;
      return tok;
    }
    if (c > 127) {
      // non-ASCII identifier
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d < 128 ? ID_PART[d] : d > 127 && d !== 0xa0 && d !== 0xfeff && d !== 0x2028 && d !== 0x2029) j++;
        else break;
      }
      tok = text.slice(i, j);
      i = j;
      return tok;
    }
    if (c === 39 || c === 34) {
      readString(c);
      tok = '"';
      return tok;
    }
    if (c === 96) {
      i++;
      tok = skipTemplate();
      return tok;
    }
    if (c >= 48 && c <= 57) {
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if ((d < 128 && ID_PART[d]) || d === 46) j++;
        else break;
      }
      tok = '0';
      i = j;
      return tok;
    }
    if (c === 47 && regexAllowed()) {
      skipRegex();
      tok = '/re/';
      return tok;
    }
    if (c === 123) {
      braces++;
    } else if (c === 125) {
      if (tpl.length && tpl[tpl.length - 1] === braces - 1) {
        tpl.pop();
        braces--;
        i++;
        tok = skipTemplate();
        return tok;
      }
      braces--;
    } else if (c === 61 && text.charCodeAt(i + 1) === 62) {
      i += 2;
      tok = '=>';
      return tok;
    } else if (c === 46 && text.charCodeAt(i + 1) === 46 && text.charCodeAt(i + 2) === 46) {
      i += 3;
      tok = '...';
      return tok;
    }
    tok = text[i]!;
    i++;
    return tok;
  }

  // Compares the current token. A function, because next() changes tok behind TypeScript's narrowing.
  const at = (t: string): boolean => tok === t;

  // Saves and restores the reader for lookahead.
  // The template stack is copied: a lookahead past the end of a ${} pops entries that a restore must bring back.
  type Saved = [number, string, string | null, string, number, number[], number];
  const save = (): Saved => [i, tok, tokStr, prev, braces, tpl.length === 0 ? [] : tpl.slice(), tokStart];
  const restore = (s: Saved): void => {
    [i, tok, tokStr, prev, braces] = s;
    tpl.length = 0;
    tpl.push(...s[5]);
    tokStart = s[6];
  };
  // The current token as a name: the string value for a quoted name, else the token text.
  const tokName = (): string => (tok === '"' ? tokStr! : tok);

  // After `{` of an import/export clause: reads specifiers up to `}`. Returns null when it is not a clause.
  function readClause(): { names: string[]; locals: string[]; types: boolean[] } | null {
    const names: string[] = [];
    const locals: string[] = [];
    const types: boolean[] = [];
    next();
    while (!at('}') && !at('')) {
      let isType = false;
      let name: string;
      if (at('type')) {
        const s = save();
        next();
        // `type` alone, `type as x`, `type,` and `type }` name a binding called type
        if (at(',') || at('}') || (at('as') && peekIsAsName())) {
          restore(s);
          name = 'type';
          next();
        } else {
          isType = true;
          name = tokName();
          next();
        }
      } else {
        name = tokName();
        next();
      }
      let local = name;
      if (at('as')) {
        next();
        local = tokName();
        next();
      }
      names.push(name);
      locals.push(local);
      types.push(isType);
      if (at(',')) next();
      else if (!at('}')) return null;
    }
    if (!at('}')) return null;
    return { names, locals, types };
  }
  // In `type as ...`: true when `as` is the rename keyword (type as x), false when `as` is the name (type as as x)
  function peekIsAsName(): boolean {
    const s = save();
    next(); // token after as
    const t = tok;
    restore(s);
    return t !== ',' && t !== '}' && t !== 'as';
  }

  function expectFrom(): string | null {
    if (!at('from')) return null;
    next();
    if (!at('"')) return null;
    return tokStr;
  }

  // At `(` after import or require: true for a method declaration such as `import(id: string): T` in an interface or
  // `async import(id) { ... }` in a class, which is not a call.
  function isMethodDecl(): boolean {
    const s = save();
    next();
    const t1 = tok;
    next();
    let decl = t1 !== ')' && (at(':') || (at('?') && (next(), at(':'))));
    if (!decl) {
      restore(s);
      let depth = 0;
      do {
        if (at('(')) depth++;
        else if (at(')')) depth--;
        if (depth > 0) next();
      } while (depth > 0 && !at(''));
      next();
      decl = at('{');
    }
    restore(s);
    return decl;
  }

  // From a token inside call parentheses, moves to the closing `)`.
  function skipToClose(): void {
    let depth = at('(') ? 2 : 1;
    while (!at('')) {
      next();
      if (at('(')) depth++;
      else if (at(')') && --depth === 0) return;
    }
  }

  // The source text of a non-literal first argument, from the current token to the `,` or `)` after it. Restores the
  // reader.
  function argText(): string {
    const start = tokStart;
    const s = save();
    // a template that starts with text and ${ has already entered the ${
    const inTpl = at('${') ? 1 : 0;
    const depth0 = braces - inTpl;
    const tpl0 = tpl.length - inTpl;
    let parens = 0;
    while (!at('') && !(parens === 0 && braces === depth0 && tpl.length === tpl0 && (at(')') || at(',')))) {
      if (at('(') || at('[')) parens++;
      else if (at(')') || at(']')) parens--;
      next();
    }
    const end = at('') ? i : tokStart;
    restore(s);
    return text.slice(start, end).trim();
  }

  // Reads `( 'spec' )` after import or require. Returns null for a method declaration.
  function readCallArg(): { spec: string; literal: boolean } | null {
    if (isMethodDecl()) return null;
    next();
    if (at('"')) {
      const spec = tokStr!;
      const s = save();
      next();
      if (at(')') || at(',')) {
        restore(s);
        return { spec, literal: true };
      }
      restore(s);
      return { spec: argText(), literal: false };
    }
    if (at('`')) {
      // a template without ${} is a literal
      const start = tokStart;
      const s = save();
      const end = i;
      next();
      if ((at(')') || at(',')) && text.charCodeAt(end - 1) === 96 && !text.slice(start, end).includes('${')) {
        restore(s);
        return { spec: text.slice(start + 1, end - 1), literal: true };
      }
      restore(s);
      return { spec: argText(), literal: false };
    }
    return { spec: argText(), literal: false };
  }

  // Handles `import` at token position. Returns true when tokens were consumed as an import.
  function onImport(stmt: boolean): boolean {
    const line = lineAt(tokStart);
    const s = save();
    next();
    if (at('(')) {
      const a = readCallArg();
      if (a) {
        const s2 = save();
        skipToClose();
        const names = thenNames();
        restore(s2);
        imports.push({ kind: 'dynamic', reexport: false, specifier: a.spec, literal: a.literal, line, names });
      }
      return true;
    }
    if (at('.')) return false; // import.meta
    if (!stmt) {
      restore(s);
      return false;
    }
    if (at('"')) {
      imports.push({ kind: 'static', reexport: false, specifier: tokStr!, literal: true, line, names: [] });
      return true;
    }
    let typeOnly = false;
    if (at('type')) {
      const s2 = save();
      next();
      if (at(',') || at('=') || (at('from') && peekString())) {
        restore(s2); // default import named `type`
      } else typeOnly = true;
    }
    const names: ScannedName[] = [];
    let namespace = false;
    if (!at('{') && !at('*') && !at('"')) {
      // default binding, or import x = require()
      next();
      if (at('=')) {
        next();
        if (at('require')) {
          next();
          if (at('(')) {
            const a = readCallArg();
            if (a) imports.push({ kind: 'require', reexport: false, specifier: a.spec, literal: a.literal, line, names: '*' });
            return true;
          }
        }
        return true; // import x = A.B
      }
      names.push({ name: 'default', typeOnly });
      if (at(',')) next();
    }
    if (at('*')) {
      next(); // as
      next(); // name
      next();
      namespace = true;
    } else if (at('{')) {
      const c = readClause();
      if (!c) return true;
      c.names.forEach((name, k) => names.push({ name, typeOnly: typeOnly || c.types[k]! }));
      next();
    }
    const spec = expectFrom();
    if (spec === null) return true;
    imports.push({ kind: 'static', reexport: false, specifier: spec, literal: true, line, names: namespace ? '*' : names });
    return true;
  }
  function peekString(): boolean {
    const s = save();
    next();
    const t = tok;
    restore(s);
    return t === '"';
  }

  // Handles `export` at statement start. Returns true when it was a re-export (`export ... from`). `top` is false in
  // the body of `declare module 'x' { ... }`, whose exports are not the file's.
  function onExport(top: boolean): boolean {
    const line = lineAt(tokStart);
    const names = withExports && top;
    const s = save();
    next();
    let typeOnly = false;
    if (at('type')) {
      next();
      if (!at('{') && !at('*')) {
        // export type X = ...
        if (names) exportNames.push({ name: tokName(), line, typeOnly: true });
        restore(s);
        return false;
      }
      typeOnly = true;
    }
    if (at('*')) {
      next();
      let as: string | null = null;
      if (at('as')) {
        next();
        as = tokName();
        next();
      }
      const spec = expectFrom();
      if (spec !== null) {
        imports.push({ kind: 'static', reexport: true, specifier: spec, literal: true, line, names: '*', starAs: as });
        if (names && as !== null) exportNames.push({ name: as, line, typeOnly });
        finishReexport();
        return true;
      }
      restore(s);
      return false;
    }
    if (at('{')) {
      const c = readClause();
      if (c) {
        next();
        const types = c.types.map((t) => typeOnly || t);
        if (names) c.locals.forEach((name, k) => exportNames.push({ name, line, typeOnly: types[k]! }));
        const spec = expectFrom();
        if (spec !== null) {
          const exported = c.names.map((name, k) => ({ name, as: c.locals[k]!, typeOnly: types[k]! }));
          imports.push({ kind: 'static', reexport: true, specifier: spec, literal: true, line, names: c.names.map((name, k) => ({ name, typeOnly: types[k]! })), exported });
          finishReexport();
          return true;
        }
      }
      restore(s);
      return false;
    }
    if (at('import')) {
      // export import x = require('y'), export import x = A.B
      if (names) {
        const s2 = save();
        next();
        const typeOnly = at('type') && (next(), !at('='));
        if (!at('=')) exportNames.push({ name: tokName(), line, typeOnly });
        restore(s2);
      }
      onImport(true);
      return false;
    }
    if (names) declaredName(line);
    restore(s);
    return false;
  }

  // At the token after `export` in a declaration: records the declared name. Does not restore the reader.
  function declaredName(line: number): void {
    if (at('default')) {
      exportNames.push({ name: 'default', line, typeOnly: false });
      return;
    }
    if (at('declare')) next();
    if (!DECLARES.has(tok)) return; // export = x, export as namespace X
    if (at('abstract') || at('async')) next();
    const typeOnly = at('interface') || at('type');
    if (at('const')) {
      next();
      if (at('enum')) next();
    } else {
      next();
      if (at('*')) next(); // function*
    }
    if (tok.length > 0 && (ID_START[tok.charCodeAt(0)] || tok.charCodeAt(0) > 127)) exportNames.push({ name: tok, line, typeOnly });
  }

  // Consumes an optional `with { ... }` / `assert { ... }` and `;` after a re-export.
  function finishReexport(): void {
    let s = save();
    next();
    if (at('with') || at('assert')) {
      next();
      if (at('{')) {
        while (!at('}') && !at('')) next();
        s = save();
        next();
      }
    }
    if (!at(';')) restore(s);
  }

  // At `{` of an object binding pattern: reads the property keys up to the matching `}`. '*' when a key cannot be
  // named: a rest element or a computed key.
  function readPattern(): string[] | '*' {
    const names: string[] = [];
    let star = false;
    let depth = 1;
    let expectKey = true;
    while (depth > 0) {
      next();
      if (at('')) break;
      if (depth === 1 && expectKey && (at('...') || at('['))) star = true;
      if (at('{') || at('[') || at('(')) {
        depth++;
        expectKey = false;
      } else if (at('}') || at(']') || at(')')) depth--;
      else if (depth === 1 && at(',')) expectKey = true;
      else if (depth === 1 && expectKey) {
        names.push(tokName());
        expectKey = false;
      }
    }
    return star ? '*' : names;
  }

  // At the `)` that closes import(...): the keys of `.then(({ a, b: c }) => ...)`, also with `async` or `function`,
  // else '*'. Restores the reader.
  function thenNames(): ScannedName[] | '*' {
    const s = save();
    let names: string[] | '*' = '*';
    next();
    if (at('?')) next(); // ?.then
    if (at('.') && (next(), at('then')) && (next(), at('('))) {
      next();
      if (at('async')) next();
      if (at('function')) {
        next();
        if (!at('(')) next(); // function name
      }
      if (at('(') && (next(), at('{'))) names = readPattern();
    }
    restore(s);
    return names === '*' || names.length === 0 ? '*' : names.map((name) => ({ name, typeOnly: false }));
  }

  // `const { a, b: c } = await import('x')` or `= require('x')`. Called at const/let/var.
  function onDeclaration(): void {
    const s = save();
    next();
    if (!at('{')) {
      restore(s);
      return;
    }
    const names = readPattern();
    next();
    if (!at('=')) {
      restore(s);
      return;
    }
    next();
    if (at('await')) next();
    const isImport = at('import');
    if (isImport || at('require')) {
      const line = lineAt(tokStart);
      next();
      if (at('(')) {
        const a = readCallArg();
        if (a) {
          // move to the closing paren so the main loop does not see the call again
          skipToClose();
          // `= await import('x').then(...)` or `= require('x').y`: the names do not come from the module itself
          const s2 = save();
          next();
          const chained = at('.') || at('?') || at('[');
          restore(s2);
          let own: ScannedName[] | '*' = names === '*' || names.length === 0 ? '*' : names.map((name) => ({ name, typeOnly: false }));
          if (chained) own = isImport ? thenNames() : '*';
          imports.push({ kind: isImport ? 'dynamic' : 'require', reexport: false, specifier: a.spec, literal: a.literal, line, names: own });
          return;
        }
      }
    }
    restore(s);
  }

  // At `declare`: true for `declare module 'x' {`, whose body holds import and export statements.
  function isAmbientModule(): boolean {
    const s = save();
    const yes = (next(), at('module')) && (next(), at('"')) && (next(), at('{'));
    restore(s);
    return yes;
  }

  next();
  prev = '';
  let ambient = false; // in the body of `declare module 'x' {`
  while (!at('')) {
    const atTop = braces === 0 && tpl.length === 0;
    const inModule = ambient && braces === 1 && tpl.length === 0;
    // `x.import(`, `function require(` and `async require(` are not imports
    const memberAccess = prev === '.' || prev === 'function';
    if (!memberAccess && at('import')) {
      if (atTop) markCode(tokStart);
      onImport(atTop || inModule);
    } else if (!memberAccess && at('require')) {
      if (atTop) markCode(tokStart);
      const line = lineAt(tokStart);
      const s = save();
      next();
      if (at('(')) {
        const a = readCallArg();
        if (a) imports.push({ kind: 'require', reexport: false, specifier: a.spec, literal: a.literal, line, names: '*' });
      } else restore(s);
    } else if ((atTop || inModule) && at('export') && !memberAccess) {
      const start = tokStart;
      if (!onExport(atTop) && atTop) markCode(start);
    } else if (!memberAccess && (at('const') || at('let') || at('var'))) {
      if (atTop) markCode(tokStart);
      onDeclaration();
    } else if (atTop && !at(';')) {
      if (at('declare')) ambient = isAmbientModule();
      else if (at('}')) ambient = false;
      markCode(tokStart);
    }
    next();
  }
  return withExports ? { imports, exports: { names: exportNames, codeLines } } : { imports };
}

function unescape(raw: string): string {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (_, e: string) => {
    if (e[0] === 'u') return String.fromCodePoint(parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16));
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e === '\n' || e === '\r\n' || e === '\r') return '';
    return ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' } as Record<string, string>)[e] ?? e;
  });
}
