// Message texts of slopbuckets 2.0. Pure functions, with no Node import, because the inspect page bundles this file
// for the browser. The texts are product: change them only on purpose, and update messages.test.ts with them.
import type { EnvironmentError } from './engine.js';
import { CONFIG_FILE, CONFIG_VERSION, REASON_MIN_WORDS, RULE_IDS, type RuleId } from './rules.js';
import {
  asType,
  violationBuckets,
  type Advice,
  type BucketImport,
  type ConfigInvalidViolation,
  type ConfigPath,
  type ConfigProblem,
  type ImportName,
  type ImportRef,
  type Reexported,
  type Violation,
  type ViolationOf,
} from './violation.js';

export const SUMMARY_MAX = 120;
export const HEADER_MAX = 140;
/** dependency-undeclared and package-undeclared show at most this many other buckets that declare the same target. */
export const DEPENDENTS_SHOWN = 3;
/** The SKILL section that the no-buckets message points to. */
export const FIRST_ARCHITECTURE_SECTION = 'The first architecture after buckets init';

const TAIL = 'Fix the code or edit buckets.config.json. Either is valid.';

/** The top-level fields of a slopbuckets 1.x config. */
const V1_FIELDS = ['root', 'alias', 'layout', 'access'];

/**
 * `text` with every control character and line or paragraph separator escaped (`\n`, `\u001b`), so a config key, a
 * path or a glob cannot add lines to a message an agent reads, or hide text on a terminal. Every line of a message
 * passes through here.
 */
export function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\u2028\u2029]/gu, (c) => {
    const short: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
    return short[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

/** Shortens `text` to `max` characters by replacing its middle with `...`. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(max - 3, 2);
  return `${text.slice(0, Math.ceil(keep / 2))}...${text.slice(text.length - Math.floor(keep / 2))}`;
}

/** Renders a config path: buckets.billing.dependsOn.log, ignore[0], buckets["Bad.Name"]. */
export function formatConfigPath(at: ConfigPath): string {
  return at
    .map((seg, i) => {
      if (typeof seg === 'number') return `[${seg}]`;
      if (/^[A-Za-z_$][\w$-]*$/.test(seg)) return i === 0 ? seg : `.${seg}`;
      return `[${JSON.stringify(seg)}]`;
    })
    .join('');
}

const where = (at: ConfigPath) => (at.length === 0 ? 'the top level' : formatConfigPath(at));

/** What the value at `at` is, for "reason is empty". */
function fieldName(at: ConfigPath): string {
  const last = at[at.length - 1];
  const parent = at[at.length - 2];
  if (at[0] === 'buckets' && (at[2] === 'dependsOn' || at[2] === 'packages') && at.length === 4) return 'reason';
  if (typeof last === 'number') return parent === 'projects' || parent === 'public' ? 'path' : 'glob';
  if (typeof last === 'string' && ['purpose', 'external', 'files', 'public', 'ignore', 'projects', 'buckets'].includes(last)) return last;
  return 'value';
}

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '');
  return s === '' ? 'bucket' : s;
}

function joinAnd(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const MISSING_EXAMPLE: Record<string, string> = {
  version: JSON.stringify(CONFIG_VERSION),
  purpose: '"<one-line purpose>"',
  files: '["<glob>"]',
  dependsOn: '{}',
  packages: '{}',
  buckets: '{}',
};

/** The error line (without indent) and the fix of a config problem. */
export function configProblemText(problem: ConfigProblem): { error: string; fix: string } {
  const { error, fix } = problemText(problem);
  return { error: oneLine(error), fix: oneLine(fix) };
}

function problemText(problem: ConfigProblem): { error: string; fix: string } {
  switch (problem.kind) {
    case 'json':
      return { error: `not valid JSON: ${problem.message}`, fix: `fix the JSON syntax of ${CONFIG_FILE}` };
    case 'invalid': {
      const at = formatConfigPath(problem.at);
      return { error: `${at}: must be ${problem.expected}`, fix: `write ${at} as ${problem.expected}` };
    }
    case 'missing': {
      const at = where(problem.at);
      const error = `${at}: "${problem.field}" is missing`;
      if (problem.field === 'public') {
        const bucket = String(problem.at[1]);
        return { error, fix: `add "public" to ${at}: the path of a file of ${bucket}, a list of such paths, or null if ${bucket} exports nothing` };
      }
      return { error, fix: `add "${problem.field}": ${MISSING_EXAMPLE[problem.field] ?? '<value>'} to ${at}` };
    }
    case 'unknown-field': {
      const at = where(problem.at);
      if (problem.at.length === 0 && V1_FIELDS.includes(problem.field)) {
        return {
          error: `${at}: unknown field "${problem.field}"`,
          fix: 'this is a slopbuckets 1.x config; rename it to buckets.config.1x.json, run buckets init, and design the buckets again',
        };
      }
      const known =
        problem.at.length === 0
          ? '; the top level takes only $schema, version, ignore, projects and buckets'
          : problem.at.length === 2 && problem.at[0] === 'buckets'
            ? `; ${at} takes only purpose, files, public, dependsOn, packages and external`
            : '';
      return { error: `${at}: unknown field "${problem.field}"`, fix: `remove "${problem.field}" from ${at}${known}` };
    }
    case 'empty': {
      const at = formatConfigPath(problem.at);
      const name = fieldName(problem.at);
      const bucket = String(problem.at[1]);
      const error = `${at}: ${name} is empty`;
      switch (name) {
        case 'reason': {
          const dep = String(problem.at[3]);
          return { error, fix: `write a one-line reason, for example "${dep}": "<why ${bucket} needs ${dep}>"` };
        }
        case 'purpose':
          return { error, fix: `write one line in ${at} that says what ${bucket} does` };
        case 'external':
          return { error, fix: `write one line in ${at} that says which code outside the project uses it, or remove "external"` };
        case 'files':
          return { error, fix: `add a glob such as "src/${bucket}/**" to ${at}` };
        case 'public':
          return { error, fix: `set ${at} to the path of a file of ${bucket}, a list of such paths, or null` };
        case 'glob':
          return { error, fix: `write a glob in ${at}, or remove the entry` };
        case 'path':
          return problem.at[problem.at.length - 2] === 'public'
            ? { error, fix: `write the path of a file of ${bucket} in ${at}, or remove the entry` }
            : { error, fix: `write a folder in ${at}, or remove the entry` };
        default:
          return { error, fix: `write a value in ${at}` };
      }
    }
    case 'multiline': {
      const at = formatConfigPath(problem.at);
      return { error: `${at}: ${fieldName(problem.at)} has more than one line`, fix: `rewrite ${at} as one line` };
    }
    case 'bucket-name':
      return {
        error: `${formatConfigPath(['buckets', problem.name])}: bucket name must use lowercase letters, digits and -, starting with a letter`,
        fix: `rename the bucket to "${slug(problem.name)}" and update every dependsOn that names it`,
      };
    case 'unknown-bucket': {
      const at = formatConfigPath(['buckets', problem.bucket, 'dependsOn']);
      return {
        error: `${at}.${problem.dependency}: bucket ${problem.dependency} does not exist`,
        fix: `remove "${problem.dependency}" from ${at}, or add a bucket named ${problem.dependency}`,
      };
    }
    case 'bucket-renamed': {
      const refs = joinAnd(problem.referencedBy.map((b) => formatConfigPath(['buckets', b, 'dependsOn'])));
      const from = formatConfigPath(['buckets', problem.from]);
      return {
        error: `${from}: removed while dependsOn still names it, and ${formatConfigPath(['buckets', problem.to])} is new`,
        fix: `to rename ${problem.from} to ${problem.to}, rename the key and every dependsOn entry that names ${problem.from} in the same edit: ${refs}`,
      };
    }
    case 'package-name':
      return {
        error: `${formatConfigPath(['buckets', problem.bucket, 'packages', problem.name])}: "${problem.name}" is not a package name`,
        fix: `rename the key to "${problem.key}"; keys are package names without a subpath, and Node built-ins as node:<name>`,
      };
  }
}

const loc = (file: string, line: number) => `${file}:${line}`;

/** The specifier a public file uses to re-export `target`: './client' for src/payments/client.ts from src/payments/index.ts. */
export function reexportSpecifier(publicFile: string, target: string): string {
  const from = publicFile.split('/').slice(0, -1);
  const to = target.replace(/(\.d)?\.(tsx?|mts|cts|jsx?|mjs|cjs)$/, '').split('/');
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const up = from.length - i;
  const rest = to.slice(i).join('/');
  return up === 0 ? `./${rest}` : `${'../'.repeat(up)}${rest}`;
}

/** `charge, type Invoice`: the names an import takes, as written in an import statement. */
function nameList(names: readonly ImportName[]): string {
  return names.map((n) => (n.typeOnly ? `type ${n.name}` : n.name)).join(', ');
}

function importLine(i: ImportRef | BucketImport): string {
  const names = i.names.length === 0 ? '' : `${nameList(i.names)} from `;
  return `  ${loc(i.file, i.line)} imports ${names}${i.target}${'private' in i && i.private ? ' (private)' : ''}`;
}

/**
 * The name under which a public file re-exports the default export of `target`: the file name as an identifier,
 * HandyHand for src/icons/HandyHand.tsx, or the folder name for an index file. A public file holds one default
 * export at most, so it re-exports a private default under a name.
 * ponytail: a file named after a reserved word, such as delete.ts, gives a name that an import cannot bind.
 */
export function defaultExportName(target: string): string {
  const parts = target.replace(/(\.d)?\.(tsx?|mts|cts|jsx?|mjs|cjs)$/, '').split('/');
  const stem = parts.at(-1) === 'index' && parts.length > 1 ? parts.at(-2)! : parts.at(-1)!;
  const words = stem.split(/[^A-Za-z0-9_$]+/).filter((w) => w !== '');
  const name = words.map((w, k) => (k === 0 ? w : w[0]!.toUpperCase() + w.slice(1))).join('');
  return name === '' ? 'defaultExport' : /^[0-9]/.test(name) ? `_${name}` : name;
}

/** `default as HandyHand` for the default export of `target`, any other name as it is. */
const reexportName = (name: string, target: string): string => (name === 'default' ? `default as ${defaultExportName(target)}` : name);

/**
 * The re-export statements a public file needs so that `imports` can go through it: per target, one `export { }`
 * for the value names and one `export type { }` for the names that the target declares as types or that every
 * import takes as types only. A default export goes under its defaultExportName. An import without names gives the
 * placeholder `name`.
 */
export function reexportStatements(publicFile: string, imports: readonly ImportRef[]): string[] {
  const targets = new Map<string, { values: Set<string>; types: Set<string> }>();
  for (const i of imports) {
    const t = targets.get(i.target) ?? { values: new Set<string>(), types: new Set<string>() };
    targets.set(i.target, t);
    if (i.names.length === 0) t.values.add('name');
    for (const n of i.names) (asType(n) ? t.types : t.values).add(reexportName(n.name, i.target));
  }
  const out: string[] = [];
  for (const [target, { values, types }] of targets) {
    const spec = reexportSpecifier(publicFile, target);
    const typeOnly = [...types].filter((n) => !values.has(n)).sort();
    if (values.size > 0) out.push(`export { ${[...values].sort().join(', ')} } from '${spec}'`);
    if (typeOnly.length > 0) out.push(`export type { ${typeOnly.join(', ')} } from '${spec}'`);
  }
  return out;
}

/**
 * "import from src/payments/index.ts instead, and add the re-exports it lacks: ...", for private imports. The
 * statements leave out the names in `reexported`; when no name is left, only the import part remains.
 */
function throughPublic(to: string, publicList: readonly string[], imports: readonly ImportRef[], reexported: readonly Reexported[] = []): string {
  const missing = imports.flatMap((i) => {
    const names = i.names.filter((n) => !reexported.some((x) => x.target === i.target && x.name === n.name));
    return i.names.length > 0 && names.length === 0 ? [] : [{ ...i, names }];
  });
  const where = publicList.length === 1 ? publicList[0]! : `a public file of ${to}`;
  const defaults = [...new Set(imports.filter((i) => i.names.some((n) => n.name === 'default')).map((i) => `{ ${defaultExportName(i.target)} }`))];
  const named = defaults.length === 0 ? '' : `, with ${defaults.join(', ')} in place of the default import${defaults.length === 1 ? '' : 's'}`;
  if (missing.length === 0) return `import from ${where} instead${named}`;
  const statements = reexportStatements(publicList[0]!, missing).join(', ');
  if (publicList.length === 1) return `import from ${where} instead${named}, and add the re-exports it lacks: ${statements}`;
  return `import from ${where} instead${named}, and add the re-exports it lacks; in ${publicList[0]} they read: ${statements}`;
}

const publicLine = (to: string, list: readonly string[]) => `  ${to} public: ${list.length === 0 ? 'none' : list.join(', ')}`;
const cyclePath = (names: readonly string[]) => names.join(' -> ');

function prefixed(v: Violation, text: string): string {
  return v.project === '.' ? text : `${v.project}: ${text}`;
}

/** The lines of the full form of each rule. renderFull adds the project and the choose line. */
const FULL: { readonly [R in RuleId]: (v: ViolationOf<R>) => string[] } = {
  'config-invalid': (v) => {
    const { error, fix } = configProblemText(v.problem);
    return [`${CONFIG_FILE}: invalid, other rules skipped`, `  ${error}`, `  fix config: ${fix}`];
  },
  'config-cycle': (v) => [
    `${CONFIG_FILE}: cycle ${cyclePath([...v.cycle, v.cycle[0]!])}`,
    ...v.edges.map(
      (e) =>
        `  ${e.from} -> ${e.to} (${JSON.stringify(e.reason)}): ${e.import === null ? `no file of ${e.from} imports ${e.to}` : importLine(e.import).trimStart()}`,
    ),
    '  fix code: move the code that needs the reverse direction, so one dependency is no longer needed',
    '  fix config: remove one dependency of the cycle from dependsOn, or merge the buckets',
  ],
  'dependency-undeclared': (v) => {
    const many = v.imports.length > 1;
    const privates = v.imports.filter((i) => i.private);
    const head = privates.length === 0 ? '' : v.public.length === 0 ? `, ${v.to} is closed` : ', imports private files';
    const lines = [
      `${v.from} -> ${v.to}: undeclared dependency${head}`,
      ...v.imports.map(importLine),
      `  ${v.from}: ${v.fromPurpose}`,
      `  ${v.to}: ${v.toPurpose}`,
      ...(privates.length > 0 ? [publicLine(v.to, v.public)] : []),
      ...v.dependents.slice(0, DEPENDENTS_SHOWN).map((d) => `  ${d.bucket} depends on ${v.to}: ${d.reason}`),
    ];
    const code = many
      ? `  fix code: remove the imports by moving the code that needs them into ${v.to}, or by moving what they use from ${v.to} into ${v.from}`
      : `  fix code: remove the import by moving the code that needs it into ${v.to}, or by moving what it uses from ${v.to} into ${v.from}`;
    if (v.reversePath !== null) {
      const cycle = cyclePath([v.from, ...v.reversePath]);
      return [...lines, `  no config fix: declaring ${v.to} in buckets.${v.from}.dependsOn would create the cycle ${cycle}, so move the code`, code];
    }
    let config = `  fix config: add "${v.to}": "<one-line reason>" to buckets.${v.from}.dependsOn`;
    if (privates.length > 0) {
      config +=
        v.public.length === 0
          ? `, then set buckets.${v.to}.public to a file of ${v.to} that re-exports what ${v.from} needs`
          : `, then ${throughPublic(v.to, v.public, privates, v.reexported)}`;
    }
    if (v.reverseUndeclared) {
      lines.push(`  ${v.to} -> ${v.from} is undeclared too, and declaring both directions makes the cycle ${cyclePath([v.from, v.to, v.from])}, so declare one and move the code of the other`);
    }
    return [...lines, code, config];
  },
  'dependency-unused': (v) => [
    `${v.from} -> ${v.to}: declared but never imported (${JSON.stringify(v.reason)})`,
    `  fix code: if ${v.from} still needs ${v.to}, import from a public file of ${v.to}`,
    `  fix config: remove "${v.to}" from buckets.${v.from}.dependsOn`,
  ],
  'import-private': (v) => {
    const many = v.imports.length > 1;
    if (v.public.length === 0) {
      return [
        `${v.from} -> ${v.to}: ${v.to} is closed`,
        ...v.imports.map(importLine),
        publicLine(v.to, v.public),
        many ? '  fix code: remove the imports' : '  fix code: remove the import',
        `  fix config: set buckets.${v.to}.public to a file of ${v.to} that re-exports what ${v.from} needs`,
      ];
    }
    return [
      `${v.from} -> ${v.to}: ${many ? 'private files' : 'private file'}`,
      ...v.imports.map(importLine),
      publicLine(v.to, v.public),
      `  fix code: ${throughPublic(v.to, v.public, v.imports, v.reexported)}`,
    ];
  },
  'import-unresolved': (v) => {
    const at = loc(v.file, v.line);
    switch (v.kind) {
      case 'relative':
        return [`${at}: '${v.specifier}' does not resolve`, '  fix code: correct the path, or create the file it names'];
      case 'paths':
        if (v.pattern === null) return [`${at}: '${v.specifier}' names no file under the tsconfig baseUrl`, '  fix code: correct the path, or create the file it names'];
        return [
          `${at}: '${v.specifier}' matches the tsconfig paths pattern ${v.pattern} and does not resolve`,
          `  fix code: correct the path or the paths entry for ${v.pattern} in tsconfig.json, or create the file it names`,
        ];
      case 'workspace':
        return [
          `${at}: workspace package '${v.specifier}' does not resolve`,
          `  fix code: install the dependencies, or point '${v.specifier}' at its sources with a paths entry in tsconfig.json`,
        ];
    }
  },
  'import-ignored': (v) => [
    `${loc(v.file, v.line)} imports ignored file ${v.target}`,
    '  fix code: remove the import',
    `  fix config: take ${v.target} out of ignore and add it to a bucket's files`,
  ],
  'import-dynamic': (v) => [
    `${loc(v.file, v.line)}: ${v.call === 'import' ? 'dynamic import' : 'require'} with a non-literal path, cannot be checked`,
    '  fix code: use a string literal path or a static import',
  ],
  'import-namespace': (v) => {
    const at = loc(v.file, v.line);
    switch (v.form) {
      case 'import':
        return [
          `${at} imports * from ${v.to}, name each import`,
          `  fix code: replace it with import { a, b } from '${v.specifier}', naming only what ${v.from} uses`,
        ];
      case 'export':
        return [
          `${at} re-exports * from ${v.to}, name each export`,
          `  fix code: replace it with export { a, b } from '${v.specifier}', naming only what other files import`,
        ];
      case 'dynamic':
        return [
          `${at} imports * from ${v.to} with import(), name each import`,
          `  fix code: destructure what ${v.from} uses, as in const { a, b } = await import('${v.specifier}')`,
        ];
      case 'require':
        return [
          `${at} imports * from ${v.to} with require(), name each import`,
          `  fix code: destructure what ${v.from} uses, as in const { a, b } = require('${v.specifier}')`,
        ];
    }
  },
  'file-unowned': (v) => {
    if ('noBuckets' in v) {
      return [
        `${CONFIG_FILE}: no buckets yet, ${v.count === 1 ? '1 file is' : `${v.count} files are`} in no bucket`,
        ...v.folders.map((f) => `  ${f.folder} (${f.count === 1 ? '1 file' : `${f.count} files`})`),
        ...v.files.map((f) => `  ${f}`),
        `  fix config: design the first architecture as the SKILL section "${FIRST_ARCHITECTURE_SECTION}" says: read what each folder does, put tests, scripts and generated files in ignore, and give each domain its own bucket`,
      ];
    }
    if ('folder' in v) {
      return [
        `${v.folder} (${v.count} files): in no bucket and not ignored`,
        '  fix code: move the files into folders that buckets own',
        `  fix config: add ${v.folder} to a bucket's files, or to ignore if it is not product code, such as tests, scripts or generated files`,
      ];
    }
    return [
      `${v.file}: in no bucket and not ignored`,
      '  fix code: move the file into a folder that a bucket owns',
      "  fix config: add it to a bucket's files, or to ignore if it is not product code, such as a test, a script or a generated file",
    ];
  },
  'file-overlap': (v) => {
    const [first, ...rest] = v.owners;
    const owners = v.owners.map((o) => `${o.bucket} (${o.glob})`);
    return [
      `${v.file}: in ${joinAnd(owners)}`,
      '  fix code: move the file so only one glob matches it',
      `  fix config: add ${joinAnd(rest.map((o) => `"!${o.glob}"`))} to buckets.${first!.bucket}.files, or narrow ${joinAnd(rest.map((o) => `buckets.${o.bucket}.files`))}`,
    ];
  },
  'glob-empty': (v) => {
    const field = v.field === 'files' ? `buckets.${v.bucket}.files` : v.field;
    if (v.field === 'projects') {
      return [
        `projects: ${v.glob} has no ${CONFIG_FILE}`,
        `  fix code: create ${v.glob}/${CONFIG_FILE}`,
        `  fix config: remove "${v.glob}" from projects`,
      ];
    }
    const remove = `  fix config: remove "${v.glob}" from ${field}`;
    if (v.glob.startsWith('!')) return [`${field}: ${v.glob} excludes no file`, remove];
    if (v.field === 'ignore') return [`ignore: ${v.glob} matches no file`, remove];
    return [`${field}: ${v.glob} matches no file`, `  fix code: create a file that ${v.glob} matches`, remove];
  },
  'public-missing': (v) => {
    const config = `  fix config: in buckets.${v.bucket}.public, replace ${v.public} with an existing file of ${v.bucket} or remove it, and use null when no public file remains`;
    if (v.state === 'not-found') return [`buckets.${v.bucket}.public: ${v.public} does not exist`, `  fix code: create ${v.public}`, config];
    const state =
      v.state === 'other-bucket' ? `belongs to ${v.owner}, not to ${v.bucket}` : v.state === 'ignored' ? `is ignored, not in ${v.bucket}` : `is in no bucket, not in ${v.bucket}`;
    return [`buckets.${v.bucket}.public: ${v.public} ${state}`, `  fix code: move ${v.public} into a folder that buckets.${v.bucket}.files matches`, config];
  },
  'public-not-interface': (v) => {
    const at = `buckets.${v.bucket}.public: ${loc(v.public, v.line)}`;
    switch (v.kind) {
      case 'code':
        return [
          `${at} has code, public files only hold named re-exports`,
          `  fix code: move the code to another file of ${v.bucket} and re-export it by name from ${v.public}`,
        ];
      case 'export-star':
        return [`${at} uses export *, name each export`, `  fix code: replace it with export { a, b } from '${v.specifier}', naming only what other buckets import`];
      case 'foreign-reexport':
        return [
          `${at} re-exports from ${v.sourceBucket} (${v.source})`,
          `  fix code: remove the re-export; buckets that need it import from a public file of ${v.sourceBucket} and declare ${v.sourceBucket} in dependsOn`,
        ];
    }
  },
  'project-undeclared': (v) => [
    `${v.folder}/${CONFIG_FILE}: nested project not listed in projects`,
    `  fix code: delete ${v.folder}/${CONFIG_FILE} if it is not a project`,
    `  fix config: add "${v.folder}" to projects`,
  ],
  'export-unused': (v) => [
    `${v.bucket}: export ${v.name} is not imported by any bucket (${loc(v.public, v.line)})`,
    `  fix code: remove ${v.name} from ${v.public}, or import it where a bucket needs it`,
    `  fix config: if code outside this project uses it, add "external": "<one-line reason>" to buckets.${v.bucket}`,
  ],
  'package-undeclared': (v) => {
    const many = v.imports.length > 1;
    const declared = v.declaredBy.slice(0, DEPENDENTS_SHOWN);
    const remove = `  fix code: remove the ${many ? 'imports' : 'import'}`;
    return [
      `${v.bucket}: undeclared package ${v.package}`,
      ...v.imports.map((i) => `  ${loc(i.file, i.line)} imports '${i.specifier}'`),
      `  ${v.bucket}: ${v.purpose}`,
      ...declared.map((d) => `  ${d.bucket} declares ${v.package}: ${d.reason}`),
      declared.length === 0 ? remove : `${remove}, or move the code that needs ${v.package} into ${joinAnd(declared.map((d) => d.bucket))}`,
      `  fix config: add "${v.package}": "<one-line reason>" to buckets.${v.bucket}.packages`,
    ];
  },
  'package-unused': (v) => [
    `${v.bucket}: package ${v.package} declared but never imported (${JSON.stringify(v.reason)})`,
    `  fix code: if ${v.bucket} still needs ${v.package}, import it in a file of ${v.bucket}`,
    `  fix config: remove "${v.package}" from buckets.${v.bucket}.packages`,
  ],
};

function full(v: Violation): string[] {
  return (FULL[v.rule] as (v: Violation) => string[])(v);
}

export const CHOOSE_LINE = '  choose one fix:';

/**
 * The full form: what is wrong, where, and `fix code:` then `fix config:` lines. When both fix lines are there, a
 * `choose one fix:` line above them says that they are alternatives.
 */
export function renderFull(v: Violation): string {
  const lines = full(v);
  lines[0] = prefixed(v, lines[0]!);
  const first = lines.findIndex((line) => line.startsWith('  fix '));
  if (lines.some((line) => line.startsWith('  fix code: ')) && lines.some((line) => line.startsWith('  fix config: '))) lines.splice(first, 0, CHOOSE_LINE);
  return lines.map(oneLine).join('\n');
}

/**
 * Every violation in full form, one block each, except that the config-invalid violations of one project share the
 * block of the first one, under one header. A fix line already in that block is not repeated.
 */
function fullBlocks(list: readonly Violation[]): string[] {
  const blocks: string[][] = [];
  const configs = new Map<string, string[]>();
  for (const v of list) {
    const block = configs.get(v.project);
    if (v.rule === 'config-invalid' && block !== undefined) {
      for (const line of renderFull(v).split('\n').slice(1)) if (!line.startsWith('  fix ') || !block.includes(line)) block.push(line);
      continue;
    }
    const lines = renderFull(v).split('\n');
    if (v.rule === 'config-invalid') configs.set(v.project, lines);
    blocks.push(lines);
  }
  return blocks.map((lines) => lines.join('\n'));
}

/** `src/billing/invoice.ts:3 and 4 more`: the first import of a group and how many follow. */
function firstOf(imports: readonly { file: string; line: number }[]): string {
  const more = imports.length > 1 ? ` and ${imports.length - 1} more` : '';
  return `${loc(imports[0]!.file, imports[0]!.line)}${more}`;
}

/**
 * The subject, the problem and an optional location of a summary. renderSummary joins the subject and the problem with
 * ": ", except after a file and line that the problem starts a sentence from, as in the full form: `src/a.ts:5 imports`.
 */
const SUMMARY: { readonly [R in RuleId]: (v: ViolationOf<R>) => [subject: string, problem: string, location?: string] } = {
  'config-invalid': (v) => {
    if (v.problem.kind === 'json') return [CONFIG_FILE, 'not valid JSON'];
    const { error } = configProblemText(v.problem);
    const cut = error.indexOf(': ');
    return [error.slice(0, cut), error.slice(cut + 2), CONFIG_FILE];
  },
  'config-cycle': (v) => [CONFIG_FILE, `cycle ${cyclePath([...v.cycle, v.cycle[0]!])}`],
  'dependency-undeclared': (v) => {
    const privates = v.imports.some((i) => i.private);
    const head = !privates ? '' : v.public.length === 0 ? `, ${v.to} is closed` : ', imports private files';
    return [`${v.from} -> ${v.to}`, `undeclared dependency${head}`, firstOf(v.imports)];
  },
  'dependency-unused': (v) => [`${v.from} -> ${v.to}`, 'declared but never imported', `buckets.${v.from}.dependsOn`],
  'import-private': (v) => [`${v.from} -> ${v.to}`, v.public.length === 0 ? `${v.to} is closed` : v.imports.length > 1 ? 'private files' : 'private file', firstOf(v.imports)],
  'import-unresolved': (v) => [loc(v.file, v.line), `'${v.specifier}' does not resolve`],
  'import-ignored': (v) => [loc(v.file, v.line), `imports ignored file ${v.target}`],
  'import-dynamic': (v) => [loc(v.file, v.line), `non-literal ${v.call}()`],
  'import-namespace': (v) => [loc(v.file, v.line), `${v.form === 'export' ? 're-exports' : 'imports'} * from ${v.to}`],
  'file-unowned': (v) => {
    if ('noBuckets' in v) return [CONFIG_FILE, 'no buckets yet', `${v.count} ${v.count === 1 ? 'file' : 'files'} in no bucket`];
    return ['folder' in v ? `${v.folder} (${v.count} files)` : v.file, 'in no bucket'];
  },
  'file-overlap': (v) => [v.file, v.owners.length === 2 ? 'in two buckets' : `in ${v.owners.length} buckets`],
  'glob-empty': (v) => {
    if (v.field === 'projects') return ['projects', `${v.glob} has no ${CONFIG_FILE}`];
    return [
      v.field === 'files' ? `buckets.${v.bucket}.files` : 'ignore',
      `${v.glob} ${v.glob.startsWith('!') ? 'excludes' : 'matches'} no file`,
    ];
  },
  'public-missing': (v) => {
    const state = { 'not-found': 'does not exist', 'other-bucket': `belongs to ${v.owner}`, ignored: 'is ignored', unowned: 'is in no bucket' }[v.state];
    return [`buckets.${v.bucket}.public`, `${v.public} ${state}`];
  },
  'public-not-interface': (v) => {
    const text = v.kind === 'code' ? 'has code' : v.kind === 'export-star' ? 'uses export *' : `re-exports from ${v.sourceBucket}`;
    return [`buckets.${v.bucket}.public`, text, loc(v.public, v.line)];
  },
  'project-undeclared': (v) => [`${v.folder}/${CONFIG_FILE}`, 'not listed in projects'],
  'export-unused': (v) => [v.bucket, `export ${v.name} not imported by any bucket`, loc(v.public, v.line)],
  'package-undeclared': (v) => [v.bucket, `undeclared package ${v.package}`, firstOf(v.imports)],
  'package-unused': (v) => [v.bucket, `package ${v.package} declared but never imported`, `buckets.${v.bucket}.packages`],
};

function summaryParts(v: Violation): [subject: string, problem: string, location?: string] {
  return (SUMMARY[v.rule] as (v: Violation) => [subject: string, problem: string, location?: string])(v);
}

/** The one-line reminder for [OLD] and [RESOLVED], at most SUMMARY_MAX characters. */
export function renderSummary(v: Violation): string {
  const [subject0, problem, location0] = summaryParts(v).map((part) => (part === undefined ? part : oneLine(part))) as ReturnType<typeof summaryParts>;
  const prefix = v.project === '.' ? '' : `${oneLine(v.project)}: `;
  const join = v.rule === 'import-ignored' || v.rule === 'import-namespace' ? ' ' : ': ';
  const build = (s: string, l: string | undefined) => `${prefix}${s}${join}${problem}${l === undefined ? '' : ` (${l})`}`;
  let subject = subject0;
  let location = location0;
  let over = build(subject, location).length - SUMMARY_MAX;
  if (over > 0 && location !== undefined) {
    location = truncateMiddle(location, Math.max(12, location.length - over));
    over = build(subject, location).length - SUMMARY_MAX;
  }
  if (over > 0) subject = truncateMiddle(subject, Math.max(12, subject.length - over));
  return truncateMiddle(build(subject, location), SUMMARY_MAX);
}

export interface PendingParts {
  /** Not yet shown in full: rendered in full under [NEW]. */
  fresh: readonly Violation[];
  /** Already shown in full: one-line reminders under [OLD]. */
  old: readonly Violation[];
  /** Gone since the last list: one-line reminders under [RESOLVED], shown once. */
  resolved: readonly Violation[];
}

export function pendingHeader(count: number): string {
  return count === 0 ? 'buckets: 0 pending.' : `buckets: ${count} pending. ${TAIL} Full detail: buckets check`;
}

/**
 * The pre-tool context. Empty string when all three lists are empty: the hook then stays silent unless it has advice
 * to show, which goes under the list as renderAdviceNote.
 */
export function renderPending({ fresh, old, resolved }: PendingParts): string {
  if (fresh.length + old.length + resolved.length === 0) return '';
  const sections = [pendingHeader(fresh.length + old.length)];
  if (fresh.length > 0) sections.push(['[NEW]', fullBlocks(fresh).join('\n\n')].join('\n'));
  if (old.length > 0) sections.push(['[OLD]', ...old.map(renderSummary)].join('\n'));
  if (resolved.length > 0) sections.push(['[RESOLVED]', ...resolved.map(renderSummary)].join('\n'));
  return sections.join('\n\n');
}

function plural(count: number): string {
  return count === 1 ? '1 structure violation remains' : `${count} structure violations remain`;
}

export function stopHeader(count: number): string {
  return `buckets: ${plural(count)}. ${TAIL}`;
}

/** The stop note for violations that a stop of an earlier turn already showed. */
export const REPEATED_NOTE = 'These were also left at the end of an earlier turn. If you leave them, tell the user which ones and why.';

/** What the advice of a reason-generic tells to write, by the field it is about. */
function adviceFix(at: ConfigPath): string {
  const bucket = String(at[1]);
  const target = String(at[3]);
  switch (at[2]) {
    case 'purpose':
      return `say what ${bucket} does, so the next agent knows which code belongs in it`;
    case 'dependsOn':
      return `say what ${bucket} takes from ${target} and why, so the next agent can judge the dependency`;
    case 'packages':
      return `say what ${bucket} uses ${target} for`;
    default:
      return 'say which code outside the project uses the public files, such as the npm package entry';
  }
}

/** The full form of one piece of advice: what it is about and one `fix config:` line. */
export function renderAdvice(a: Advice): string {
  const prefix = a.project === '.' ? '' : `${a.project}: `;
  const at = formatConfigPath(a.at);
  const lines =
    a.advice === 'reason-generic'
      ? [
          `${prefix}${at}: ${JSON.stringify(a.text)} ${a.why === 'generic' ? 'only names a bucket and a generic verb' : `has fewer than ${REASON_MIN_WORDS} words`}`,
          `  fix config: ${adviceFix(a.at)}`,
        ]
      : [
          `${prefix}${at}: ${a.glob} matches ${a.count} of ${a.total} source files (${Math.round((100 * a.count) / a.total)}%)`,
          `  those ${a.count} files are outside every rule: no bucket owns them and none of their imports is checked`,
          '  fix config: keep only tests, scripts, tool configs and generated files in ignore, and put product code in buckets',
        ];
  return lines.map(oneLine).join('\n');
}

/** The heading above the advice in the stop text and in `buckets check`. */
export function adviceHeader(count: number): string {
  return `buckets advice: ${count === 1 ? '1 note' : `${count} notes`} on the config. Advice does not fail the check or block the turn.`;
}

function adviceSection(advice: readonly Advice[]): string[] {
  return advice.length === 0 ? [] : [adviceHeader(advice.length), ...advice.map(renderAdvice)];
}

/**
 * The advice alone, under adviceHeader: the clean-stop note, and the block a pre-tool adds after the pending list when
 * an edit of the config wrote a purpose or reason that gets advice. Empty string when there is no advice.
 */
export function renderAdviceNote(advice: readonly Advice[]): string {
  return adviceSection(advice).join('\n\n');
}

export interface StopOptions {
  /** Shown after the violations, under adviceHeader. */
  advice?: readonly Advice[];
  /** Every violation was also in the block of a stop of an earlier turn: adds REPEATED_NOTE. */
  repeated?: boolean;
}

/** The stop and subagent-stop block reason: a header, every violation in full form, the repeated note, then the advice. */
export function renderStop(list: readonly Violation[], options: StopOptions = {}): string {
  return [stopHeader(list.length), ...fullBlocks(list), ...(options.repeated === true ? [REPEATED_NOTE] : []), ...adviceSection(options.advice ?? [])].join('\n\n');
}

/**
 * The interrupt when an edit makes a config invalid. Takes the config-invalid violations of one config. By default it
 * is the pre-edit deny reason. `applied: true` is the form for an adapter that only runs after the edit landed.
 */
export function renderInterrupt(list: readonly ConfigInvalidViolation[], options: { applied?: boolean } = {}): string {
  const project = list[0]?.project ?? '.';
  const file = project === '.' ? CONFIG_FILE : `${oneLine(project)}/${CONFIG_FILE}`;
  const lines = [
    options.applied === true
      ? `buckets: ${file} is now invalid. Every other check is off until it is fixed.`
      : `buckets: edit not applied, ${file} would be invalid.`,
  ];
  for (const v of list) {
    const { error, fix } = configProblemText(v.problem);
    lines.push(`  ${error}`, `  fix config: ${fix}`);
  }
  return lines.join('\n');
}

/** The first line of `buckets check`. `unchecked` counts the projects that could not be checked. */
export function checkHeader(count: number, unchecked = 0): string {
  const violations = `${count} structure ${count === 1 ? 'violation' : 'violations'}`;
  if (unchecked > 0) {
    const projects = unchecked === 1 ? '1 project' : `${unchecked} projects`;
    const problems = unchecked === 1 ? 'the problem' : 'the problems';
    if (count === 0) return `buckets check: could not check ${projects}. Fix ${problems} below and run buckets check again.`;
    return `buckets check: ${violations}, and could not check ${projects}. ${TAIL}`;
  }
  if (count === 0) return 'buckets check: no structure violations.';
  return `buckets check: ${violations}. ${TAIL}`;
}

/**
 * The message of the config-newer environment error. `version` is the version the config declares, `cli` the version
 * of this slopbuckets, such as '2.0.0'.
 */
export function configNewerMessage(version: string, cli: string): string {
  return `${CONFIG_FILE} has version "${version}", which needs slopbuckets ${version} or later, and this is slopbuckets ${cli}. Run buckets update, then run buckets check again.`;
}

/** One project that could not be checked, as `buckets check` prints it. */
export function renderEnvironment(e: EnvironmentError): string {
  return oneLine(`${e.project === '.' ? '' : `${e.project}: `}cannot check (${e.code}): ${e.message}`);
}

/** Text output of `buckets check`: a header, every violation in full form, the environment errors, then the advice. */
export function renderCheck(list: readonly Violation[], environment: readonly EnvironmentError[] = [], advice: readonly Advice[] = []): string {
  return [checkHeader(list.length, environment.length), ...fullBlocks(list), ...environment.map(renderEnvironment), ...adviceSection(advice)].join('\n\n');
}

/** The last line of `buckets check --summary` when there are violations. */
export const SUMMARY_TAIL = 'Run buckets check without --summary to see each violation with its fixes.';

/**
 * Text output of `buckets check --summary`: the check header, the number of violations per rule (in RULE_IDS order)
 * and per bucket (sorted by name, `<project>: <bucket>` for a nested project, `no bucket` last), the advice per id,
 * then every environment error in full. A violation of two buckets counts for each. Hooks never use it.
 */
export function renderCheckSummary(list: readonly Violation[], environment: readonly EnvironmentError[] = [], advice: readonly Advice[] = []): string {
  const sections = [checkHeader(list.length, environment.length)];
  if (list.length > 0) {
    const byRule = RULE_IDS.map((r) => [r, list.filter((v) => v.rule === r).length] as const).filter(([, n]) => n > 0);
    const buckets = new Map<string, number>();
    let none = 0;
    for (const v of list) {
      const names = violationBuckets(v);
      if (names.length === 0) none++;
      for (const b of new Set(names)) {
        const name = v.project === '.' ? b : `${v.project}: ${b}`;
        buckets.set(name, (buckets.get(name) ?? 0) + 1);
      }
    }
    const byBucket: (readonly [string, number])[] = [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (none > 0) byBucket.push(['no bucket', none]);
    const width = String(list.length).length;
    const table = (rows: readonly (readonly [string, number])[]) => rows.map(([name, n]) => oneLine(`  ${String(n).padStart(width)} ${name}`));
    sections.push(['By rule:', ...table(byRule)].join('\n'), ['By bucket:', ...table(byBucket)].join('\n'));
  }
  if (advice.length > 0) {
    const ids = [...new Set(advice.map((a) => a.advice))].map((id) => `${advice.filter((a) => a.advice === id).length} ${id}`);
    sections.push(`Advice: ${ids.join(', ')}. Advice does not fail the check.`);
  }
  sections.push(...environment.map(renderEnvironment));
  if (list.length > 0) sections.push(SUMMARY_TAIL);
  return sections.join('\n\n');
}
