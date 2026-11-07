// `buckets fix import-private [--bucket <name>] [--public <file>] [--dry-run]`: routes every private import that the
// engine reports (import-private, and the private imports inside dependency-undeclared) through a public file. It
// adds the named re-exports to the public file of the imported bucket, `export type { }` for names the target declares
// as types (interface, type alias) or every import takes as types only, and points each importing statement at the
// public file, in the specifier style it used: a tsconfig alias stays an alias, a relative path stays relative, an
// extension stays. The names of a statement stay as written, renames included, because the public file re-exports
// each name under its own name. A default export is the exception: a public file holds one default at most, so it
// re-exports `default as <defaultExportName>`, and the statement takes that name, as the check message says. It never
// edits dependsOn: an undeclared dependency stays reported for the agent to decide.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADAPTER_ABI, analyze, resolveImports, type FileAnalysis } from '@slopbuckets/adapter-ts';
import { stderrStyle, type Context, type Io } from '../context/index.js';
import {
  asType,
  CONFIG_FILE,
  defaultExportName,
  EXIT_CODES,
  publicFiles,
  reexportSpecifier,
  renderEnvironment,
  type BucketsConfigV2,
  type ImportRef,
  type Violation,
} from '../contract/index.js';
import { findProjectDir, JsoncText, parseJson, setPropertyEdits, type JsonObject } from '../files/index.js';
import { parseCommand } from './io.js';

const USAGE = 'Usage: buckets fix import-private [--bucket <name>] [--public <file>] [--dry-run]';

const EXT = /\.(tsx?|mts|cts|jsx?|mjs|cjs)$/;
const JS_EXT: Record<string, string> = { '.ts': '.js', '.tsx': '.js', '.mts': '.mjs', '.cts': '.cjs' };

/** The private imports of one imported bucket, in one project. */
interface Group {
  project: string;
  to: string;
  /** The public files the engine reported, [] for a closed bucket. */
  public: string[];
  imports: ImportRef[];
  /** Importing buckets that have no dependsOn entry for `to`. */
  undeclared: Set<string>;
}

/** How a specifier ends: no extension, the extension of the file, or the .js form of a .ts file. */
type ExtStyle = 'none' | 'same' | 'js';

function extStyle(specifier: string, file: string): ExtStyle {
  const written = EXT.exec(specifier)?.[0];
  if (written === undefined) return 'none';
  return written === path.extname(file) ? 'same' : 'js';
}

/** `base` (a specifier without extension) for `file` in the style. 'none' also offers the form without `/index`. */
function styled(base: string, file: string, style: ExtStyle): string[] {
  const ext = path.extname(file);
  if (style === 'same') return [base + ext];
  if (style === 'js') return [base + (JS_EXT[ext] ?? ext)];
  const short = base.endsWith('/index') ? base.slice(0, -'/index'.length) : '';
  return short !== '' && short !== '.' && short !== '..' && !short.endsWith('/.') && !short.endsWith('/..') ? [short, base] : [base];
}

/**
 * The alias form of `publicFile` for a specifier that is not relative: `@billing/charge` resolves to
 * src/billing/charge.ts, so the alias `@billing/` stands for src/billing/, and src/billing/index.ts is
 * `@billing/index`. Null when the specifier and the target share no trailing path segment.
 */
function aliasBase(specifier: string, target: string, publicFile: string): string | null {
  const s = specifier.replace(EXT, '').split('/');
  const t = target.replace(EXT, '').split('/');
  if (t.at(-1) === 'index' && s.at(-1) !== 'index') t.pop();
  let k = 0;
  while (k < s.length && k < t.length && s[s.length - 1 - k] === t[t.length - 1 - k]) k++;
  if (k === 0) return null;
  const dir = t.slice(0, t.length - k);
  const p = publicFile.replace(EXT, '').split('/');
  if (dir.some((segment, i) => p[i] !== segment)) return null;
  return [...s.slice(0, s.length - k), ...p.slice(dir.length)].join('/');
}

/** The specifiers that could replace `specifier` (of `file`, resolving to `target`), best first. */
function candidates(file: string, specifier: string, target: string, publicFile: string): string[] {
  const style = extStyle(specifier, target);
  const relative = styled(reexportSpecifier(file, publicFile), publicFile, style);
  if (specifier.startsWith('.')) return relative;
  const alias = aliasBase(specifier, target, publicFile);
  return [...(alias === null ? [] : styled(alias, publicFile, style)), ...relative];
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Quote and semicolon style of the `from` lines of a source text. Single quotes and semicolons when it has none. */
function codeStyle(text: string): { quote: string; semi: string } {
  const quote = /from\s*"/.test(text) && !/from\s*'/.test(text) ? '"' : "'";
  const semi = /from\s*['"][^'"\n]*['"][ \t]*\r?$/m.test(text) && !/from\s*['"][^'"\n]*['"]\s*;/.test(text) ? '' : ';';
  return { quote, semi };
}

/** The names a public file exports: exported name to its source file (null for a local declaration) and form. */
function exportsOf(analysis: FileAnalysis | undefined): Map<string, { source: string | null; name: string; typeOnly: boolean }> {
  const out = new Map<string, { source: string | null; name: string; typeOnly: boolean }>();
  for (const r of analysis?.exports?.reexports ?? []) {
    for (const n of r.names) out.set(n.as, { source: 'file' in r.target ? r.target.file : null, name: n.name, typeOnly: n.typeOnly });
  }
  for (const n of analysis?.exports?.names ?? []) if (!out.has(n.name)) out.set(n.name, { source: null, name: n.name, typeOnly: n.typeOnly });
  return out;
}

function analyzeFiles(projectDir: string, files: string[], publicFile?: string): Record<string, FileAnalysis> {
  const response = analyze(projectDir, { abi: ADAPTER_ABI, files, ...(publicFile === undefined ? {} : { publicFiles: [publicFile] }) });
  return 'files' in response ? response.files : {};
}

/** The path of `file` (relative to the cwd, or absolute) relative to the project, with `/`. */
function projectPath(io: Io, projectDir: string, file: string): string {
  return path.relative(projectDir, path.resolve(io.cwd, file)).split(path.sep).join('/');
}

/** The private imports of the violations, by project and imported bucket. */
function privateGroups(violations: readonly Violation[]): Map<string, Group> {
  const groups = new Map<string, Group>();
  const group = (project: string, to: string, pub: string[]): Group => {
    const key = `${project}\0${to}`;
    const g = groups.get(key) ?? { project, to, public: pub, imports: [], undeclared: new Set<string>() };
    groups.set(key, g);
    return g;
  };
  for (const v of violations) {
    if (v.rule === 'import-private') group(v.project, v.to, v.public).imports.push(...v.imports);
    if (v.rule === 'dependency-undeclared' && v.imports.some((i) => i.private)) {
      const g = group(v.project, v.to, v.public);
      g.imports.push(...v.imports.filter((i) => i.private).map(({ private: _, ...ref }) => ref));
      g.undeclared.add(v.from);
    }
  }
  return groups;
}

/** What fixGroup reports: the lines of the plan, and the imports it could not route. */
interface Report {
  out: string[];
  /** An import at `where` (file:line) that stays as it is, and why. Imports skipped for the same reason share a line. */
  skip(where: string, why: string): void;
  dryRun: boolean;
}

/** One group of private imports, with the paths and texts of its project, its public file and its config. */
interface Target {
  g: Group;
  projectDir: string;
  /** '' for the root project, `<project>/` for a nested one, before every path in the report. */
  prefix: string;
  publicFile: string;
  publicAbs: string;
  publicText: string | null;
  /** The public files the config lists for the bucket. */
  listed: string[];
  configFile: string;
  configText: string;
}

export async function fixCommand(ctx: Context, io: Io, args: string[]): Promise<number> {
  const fail = (text: string, code: number = EXIT_CODES.usage): number => {
    io.stderr(`${stderrStyle(io).error('buckets fix:')} ${text}\n`);
    return code;
  };
  const parsed = parseCommand(io, 'fix', USAGE, args, { bucket: { type: 'string' }, public: { type: 'string' }, 'dry-run': { type: 'boolean' } }, 1);
  if (typeof parsed === 'number') return parsed;
  const values = parsed.values as { bucket?: string; public?: string; 'dry-run'?: boolean };
  const { positionals } = parsed;
  if (positionals.length !== 1 || positionals[0] !== 'import-private') return fail(`name what to fix: import-private is the only one. ${USAGE}`);
  if (values.public !== undefined && values.bucket === undefined) return fail(`--public needs --bucket, to say which bucket the file belongs to. ${USAGE}`);
  const dryRun = values['dry-run'] === true;

  const root = findProjectDir(io.cwd, io.env);
  if (root === null) return fail(`found no ${CONFIG_FILE} in ${io.cwd} or above it. Run buckets init first.`, EXIT_CODES.environment);
  const result = await ctx.engine.checkAll(root, { recursive: true });
  if (result.environment.length > 0) {
    io.stderr(`${result.environment.map(renderEnvironment).join('\n')}\n`);
    return EXIT_CODES.environment;
  }

  // --bucket takes `<project>:<bucket>` for a nested project, like buckets show.
  const wanted = values.bucket?.includes(':') ? values.bucket : values.bucket === undefined ? undefined : `.:${values.bucket}`;
  const selected = [...privateGroups(result.violations).values()].filter((g) => wanted === undefined || `${g.project}:${g.to}` === wanted);
  if (selected.length === 0) {
    io.stdout(values.bucket === undefined ? 'No private imports to fix.\n' : `No private imports of ${values.bucket} to fix.\n`);
    return EXIT_CODES.ok;
  }

  const skipped = new Map<string, string[]>();
  const report: Report = {
    out: [],
    skip: (where, why) => {
      const list = skipped.get(why) ?? [];
      skipped.set(why, list);
      list.push(where);
    },
    dryRun,
  };
  for (const g of selected) {
    const target = targetOf(io, root, g, values.public, report);
    if (target !== null) fixGroup(target, report);
  }
  for (const [why, where] of skipped) {
    report.out.push(where.length === 1 ? `skipped ${where[0]}: ${why}` : `skipped ${where.length} imports, the first at ${where[0]}: ${why}`);
  }
  io.stdout(`${dryRun ? 'Dry run, nothing was written. The plan:\n' : ''}${report.out.join('\n')}\n`);
  return skipped.size > 0 ? EXIT_CODES.violations : EXIT_CODES.ok;
}

/** The public file a group goes through, or null for a bucket the config no longer has or a closed one. */
function targetOf(io: Io, root: string, g: Group, publicOption: string | undefined, report: Report): Target | null {
  const projectDir = path.join(root, g.project);
  const prefix = g.project === '.' ? '' : `${g.project}/`;
  const configFile = path.join(projectDir, CONFIG_FILE);
  const configText = readFileSync(configFile, 'utf8');
  const def = (parseJson(configText) as BucketsConfigV2).buckets[g.to];
  if (def === undefined) return null;
  if (def.public === null) {
    for (const i of g.imports) report.skip(`${prefix}${i.file}:${i.line}`, `${g.to} is closed ("public": null), so nothing of it may be imported. Give ${g.to} a public file in ${CONFIG_FILE} and run this again, or move the code.`);
    return null;
  }
  const listed = publicFiles(def.public);
  const publicFile = publicOption === undefined ? (listed[0] ?? '') : projectPath(io, projectDir, publicOption);
  const publicAbs = path.join(projectDir, publicFile);
  const publicText = existsSync(publicAbs) ? readFileSync(publicAbs, 'utf8') : null;
  return { g, projectDir, prefix, publicFile, publicAbs, publicText, listed, configFile, configText };
}

/** Routes the private imports of one group through its public file. */
function fixGroup(t: Target, report: Report): void {
  const publicAnalysis = analyzeFiles(t.projectDir, [t.publicFile], t.publicFile)[t.publicFile];
  const { planned, routed } = planNames(t, exportsOf(publicAnalysis), report);
  if (routed.length === 0) return;
  const importers = analyzeFiles(t.projectDir, [...new Set(routed.map((i) => i.file))]);
  addReexports(t, publicAnalysis, planned, routed, importers, report);
  rewriteImports(t, routed, importers, report);
  for (const from of [...t.g.undeclared].sort()) {
    report.out.push(`note: ${t.prefix === '' ? '' : `${t.g.project}: `}${from} still imports ${t.g.to} without a dependsOn entry. Declare it with a reason, or move the code. fix import-private never edits dependsOn.`);
  }
}

/** The re-exports a public file needs, by the name it exports: the source file, the name there, and the form. */
type Planned = Map<string, { source: string; name: string; typeOnly: boolean }>;

/** The name the public file exports a name of `target` under: its defaultExportName for `default`. */
const exportedAs = (name: string, target: string): string => (name === 'default' ? defaultExportName(target) : name);

/** Which names the public file needs, and the statements that can go through it. The others are skipped. */
function planNames(t: Target, exported: ReturnType<typeof exportsOf>, report: Report): { planned: Planned; routed: ImportRef[] } {
  const planned: Planned = new Map();
  const routed: ImportRef[] = [];
  for (const i of t.g.imports) {
    if (i.names.length === 0) {
      report.skip(`${t.prefix}${i.file}:${i.line}`, `the import takes no names, so a re-export cannot carry it. Import a named export of ${t.publicFile} instead, or move the code.`);
      continue;
    }
    const clash = i.names.find((n) => {
      const e = exported.get(exportedAs(n.name, i.target));
      const p = planned.get(exportedAs(n.name, i.target));
      if (e !== undefined) return e.source !== i.target || e.name !== n.name || (e.typeOnly && !asType(n));
      return p !== undefined && (p.source !== i.target || p.name !== n.name);
    });
    if (clash !== undefined) {
      const as = exportedAs(clash.name, i.target);
      const e = exported.get(as);
      const why =
        e !== undefined && e.source === i.target && e.name === clash.name
          ? `${as} only as a type`
          : clash.name === 'default'
            ? `${as}, the name a re-export of the default export of ${i.target} takes`
            : `${as} from another file`;
      report.skip(`${t.prefix}${i.file}:${i.line}`, `${t.publicFile} already exports ${why}. Change that export or this import by hand.`);
      continue;
    }
    for (const n of i.names) {
      const as = exportedAs(n.name, i.target);
      if (exported.has(as)) continue;
      const p = planned.get(as);
      planned.set(as, { source: i.target, name: n.name, typeOnly: (p?.typeOnly ?? true) && asType(n) });
    }
    routed.push(i);
  }
  return { planned, routed };
}

/**
 * The re-exports, one export { } and one export type { } per source file, in the style of the existing code, and the
 * public file in the config when --public named a new one.
 */
function addReexports(
  t: Target,
  publicAnalysis: FileAnalysis | undefined,
  planned: Planned,
  routed: ImportRef[],
  importers: Record<string, FileAnalysis>,
  report: Report,
): void {
  const first = routed[0];
  if (first === undefined) return;
  const sample = t.publicText !== null && /\bfrom\b/.test(t.publicText) ? t.publicText : readFileSync(path.join(t.projectDir, first.file), 'utf8');
  const { quote, semi } = codeStyle(sample);
  const firstSpec = importers[first.file]?.imports.find((r) => r.line === first.line)?.specifier ?? '';
  const reexportStyle = publicAnalysis?.exports?.reexports[0];
  const style = reexportStyle !== undefined && 'file' in reexportStyle.target ? extStyle(reexportStyle.specifier, reexportStyle.target.file) : extStyle(firstSpec, first.target);
  const bySource = new Map<string, { values: string[]; types: string[] }>();
  for (const [as, p] of planned) {
    const s = bySource.get(p.source) ?? { values: [], types: [] };
    bySource.set(p.source, s);
    (p.typeOnly ? s.types : s.values).push(p.name === as ? as : `${p.name} as ${as}`);
  }
  const added: string[] = [];
  for (const [source, { values, types }] of [...bySource].sort(([a], [b]) => a.localeCompare(b))) {
    const spec = styled(reexportSpecifier(t.publicFile, source), source, style).at(-1) ?? '';
    if (values.length > 0) added.push(`export { ${values.sort().join(', ')} } from ${quote}${spec}${quote}${semi}`);
    if (types.length > 0) added.push(`export type { ${types.sort().join(', ')} } from ${quote}${spec}${quote}${semi}`);
  }
  if (added.length > 0) {
    report.out.push(`${t.prefix}${t.publicFile}${t.publicText === null ? ' (new file)' : ''}:`, ...added.map((line) => `  + ${line}`));
    if (!report.dryRun) {
      // The line ending of the public file, or of the sample for a new or empty one.
      const eol = (t.publicText !== null && t.publicText.includes('\n') ? t.publicText : sample).includes('\r\n') ? '\r\n' : '\n';
      const before = t.publicText === null || t.publicText === '' ? '' : t.publicText.endsWith('\n') ? t.publicText : `${t.publicText}${eol}`;
      writeFileSync(t.publicAbs, `${before}${added.join(eol)}${eol}`, 'utf8');
    }
  }
  if (!t.listed.includes(t.publicFile)) {
    report.out.push(`${t.prefix}${CONFIG_FILE}: added ${t.publicFile} to the public files of ${t.g.to}`);
    if (!report.dryRun) {
      const doc = new JsoncText(t.configText);
      const bucket = doc.property(doc.property(doc.root, 'buckets')!.value, t.g.to)!.value as JsonObject;
      writeFileSync(t.configFile, doc.apply(setPropertyEdits(doc, bucket, 'public', [...t.listed, t.publicFile])), 'utf8');
    }
  }
}

const ID = '[A-Za-z_$][\\w$]*';

/**
 * The clause between `import` or `export` and `from` with the default export taken as `name`: `X` becomes
 * `{ name as X }`, `default as X` becomes `name as X`, and a re-exported `default` becomes `name as default`. Null for
 * a form it does not know.
 */
export function renameDefault(keyword: string, clause: string, name: string): string | null {
  const as = (local: string) => (local === name ? name : `${name} as ${local}`);
  if (keyword === 'export') {
    const out = clause.replace(new RegExp(`(?<!\\bas\\s+)\\bdefault\\b(?:\\s+as\\s+(${ID}))?`, 'g'), (_, local?: string) => (local === undefined ? `${name} as default` : as(local)));
    return out === clause ? null : out;
  }
  const head = new RegExp(`^(\\s+(?:type\\s+)?)(${ID})(?:\\s*,\\s*\\{([^}]*)\\})?(\\s*)$`).exec(clause);
  if (head !== null && head[2] !== 'type') {
    const rest = head[3]?.trim().replace(/,$/, '').trim() ?? '';
    return `${head[1]}{ ${[as(head[2]!), ...(rest === '' ? [] : [rest])].join(', ')} }${head[4]}`;
  }
  const out = clause.replace(new RegExp(`\\bdefault\\s+as\\s+(${ID})`), (_, local: string) => as(local));
  return out === clause ? null : out;
}

/** The importing statements, each pointed at the public file with the first candidate that resolves to it. */
function rewriteImports(t: Target, routed: ImportRef[], importers: Record<string, FileAnalysis>, report: Report): void {
  const edits = new Map<string, { line: number; from: string; to: string; rename: string | null }[]>();
  for (const i of routed) {
    const record = importers[i.file]?.imports.find((r) => r.line === i.line && 'file' in r.target && r.target.file === i.target);
    if (record === undefined) {
      report.skip(`${t.prefix}${i.file}:${i.line}`, `found no import of ${i.target} on this line. Change it by hand to import from ${t.publicFile}.`);
      continue;
    }
    const rename = i.names.some((n) => n.name === 'default') ? defaultExportName(i.target) : null;
    if (rename !== null && record.kind !== 'static') {
      report.skip(`${t.prefix}${i.file}:${i.line}`, `the ${record.kind} import takes the default export. Take ${rename} from ${t.publicFile} by hand.`);
      continue;
    }
    const options = candidates(i.file, record.specifier, i.target, t.publicFile);
    const resolved = resolveImports(t.projectDir, options.map((specifier) => ({ from: i.file, specifier, kind: 'static' as const })));
    // ponytail: a dry run before the public file exists cannot resolve anything, so it shows the first candidate.
    const resolves = (k: number): boolean => {
      const target = 'targets' in resolved ? resolved.targets[k] : undefined;
      return target !== undefined && 'file' in target && target.file === t.publicFile;
    };
    const pick = options.find((_, k) => resolves(k)) ?? options[0] ?? record.specifier;
    const list = edits.get(i.file) ?? [];
    edits.set(i.file, list);
    list.push({ line: i.line, from: record.specifier, to: pick, rename });
  }
  for (const [file, list] of [...edits].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => a.line - b.line);
    const abs = path.join(t.projectDir, file);
    let text = readFileSync(abs, 'utf8');
    const done: typeof list = [];
    // From the last statement up, so the offsets of the earlier ones stay valid.
    for (const e of [...list].reverse()) {
      const start = text.split('\n').slice(0, e.line - 1).join('\n').length + (e.line > 1 ? 1 : 0);
      const tail = text.slice(start);
      if (e.rename !== null) {
        const statement = new RegExp(`^[ \\t]*(import|export)\\b([^;]*?)\\bfrom(\\s*)(['"\`])${escape(e.from)}\\4`).exec(tail);
        const clause = statement === null ? null : renameDefault(statement[1]!, statement[2]!, e.rename);
        if (statement === null || clause === null) {
          report.skip(`${t.prefix}${file}:${e.line}`, `found no default import of the form it rewrites. Take ${e.rename} from ${t.publicFile} by hand.`);
          continue;
        }
        const head = statement[0].slice(0, statement[0].indexOf(statement[1]!));
        text = `${text.slice(0, start)}${head}${statement[1]}${clause}from${statement[3]}${statement[4]}${e.to}${statement[4]}${tail.slice(statement[0].length)}`;
      } else {
        const match = new RegExp(`(['"\`])${escape(e.from)}\\1`).exec(tail);
        if (match === null) {
          report.skip(`${t.prefix}${file}:${e.line}`, `found no specifier '${e.from}' from this line on. Change it by hand to import from ${t.publicFile}.`);
          continue;
        }
        const at = start + match.index;
        text = `${text.slice(0, at)}${match[1]}${e.to}${match[1]}${text.slice(at + match[0].length)}`;
      }
      done.unshift(e);
    }
    report.out.push(...done.map((e) => `${t.prefix}${file}:${e.line}: '${e.from}' -> '${e.to}'${e.rename === null ? '' : `, with { ${e.rename} } in place of the default import`}`));
    if (!report.dryRun) writeFileSync(abs, text, 'utf8');
  }
}
