// Code conventions that CI checks. Exit code 1 lists every place that breaks one:
//   - a function over 150 lines or with a cyclomatic complexity over 30 (adapters/ts/src/scan.ts is exempt: its
//     lexer is one loop on purpose)
//   - a unit test file that ran over 30 s, read from the vitest JSON report given with --unit-report
//   - a unit test that waits on real time: a sleep through setTimeout, or a wall-time measurement
//   - a second definition of a shared helper
//   - a command that returns a numeric literal as its exit code, or parses its arguments without parseCommand
//   - a test that creates a temporary folder without the shared test support (adapters/ts/src/test-support.ts)
//
// Usage: node scripts/quality.mjs [--unit-report <vitest json>]
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(path.join(repo, 'cli', 'package.json'))('typescript');

const MAX_LINES = 150;
const MAX_COMPLEXITY = 30;
// The slowest file takes 8.5 s on a developer machine and 16.4 s on a CI runner. A tighter limit fails on the speed of
// the machine instead of on the size of the file.
const MAX_TEST_FILE_MS = 30_000;
const COMPLEXITY_EXEMPT = new Set(['adapters/ts/src/scan.ts']);
/** Helpers that have one definition. A second `function x` or `const x =` anywhere in the sources is a problem. */
const SHARED_HELPERS = ['toPosix', 'isRecord', 'isObject', 'stripBom', 'parseJson', 'samePath', 'message', 'unexpectedError', 'findProjectDir', 'retry', 'removeFolder', 'makeTempDir'];
/** The only file that may create a temporary folder for tests. */
const TEST_SUPPORT = 'adapters/ts/src/test-support.ts';

const problems = [];
const report = (file, line, text) => problems.push(`${file}:${line}: ${text}`);

/** Every source file of the packages and the battery, relative to the repository, with `/`. */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(repo, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', '.test-tmp', 'golden'].includes(entry.name)) walk(rel);
      } else if (/\.(ts|js|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(rel);
    }
  };
  walk('cli/src');
  walk('adapters/ts/src');
  for (const name of readdirSync(path.join(repo, 'examples'))) if (/\.ts$/.test(name)) out.push(`examples/${name}`);
  return out.sort();
}

const isTest = (file) => /\.test\.ts$/.test(file) || /(^|\/)testing\//.test(file) || /test-kit\.ts$|test-fixture\.ts$|test-support\.ts$|test-global-setup\.ts$/.test(file) || file.startsWith('examples/');
const isUnitTest = (file) => /\.test\.ts$/.test(file) && !file.startsWith('examples/');

const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);
const BRANCH_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
]);
const BRANCH_OPERATORS = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);

/** 1 plus the branches of the body, without the bodies of nested functions, which count on their own. */
function complexity(fn) {
  let n = 1;
  const visit = (node) => {
    if (node !== fn && FUNCTION_KINDS.has(node.kind)) return;
    if (BRANCH_KINDS.has(node.kind)) n++;
    else if (ts.isBinaryExpression(node) && BRANCH_OPERATORS.has(node.operatorToken.kind)) n++;
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return n;
}

function functionName(fn, sf) {
  if (fn.name) return fn.name.getText(sf);
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent)) return parent.name.getText(sf);
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText(sf);
  return '(anonymous)';
}

function checkFunctions(file, sf) {
  const visit = (node) => {
    if (FUNCTION_KINDS.has(node.kind)) {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      const lines = end - start + 1;
      const name = functionName(node, sf);
      if (lines > MAX_LINES) report(file, start, `${name} has ${lines} lines, more than ${MAX_LINES}`);
      const c = complexity(node);
      if (c > MAX_COMPLEXITY) report(file, start, `${name} has a cyclomatic complexity of ${c}, more than ${MAX_COMPLEXITY}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** `function name` and `const name = (...) =>` or `= function` at any depth: the definitions of a helper. */
function definitions(sf) {
  const out = [];
  const isFunction = (node) => node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
  const visit = (node) => {
    const defines = ts.isFunctionDeclaration(node) || (ts.isVariableDeclaration(node) && isFunction(node.initializer));
    if (defines && node.name && ts.isIdentifier(node.name)) {
      out.push({ name: node.name.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const SLEEP = /new Promise\s*(?:<[^>]*>)?\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*setTimeout\(\s*\1\s*,/;
const WALL_TIME = /performance\.now\(\)/;
const TEMP_DIR = /\bmkdtemp(?:Sync)?\(|\btmpdir\(\)/;

function checkTestFile(file, text) {
  text.split('\n').forEach((line, i) => {
    if (isUnitTest(file) && SLEEP.test(line)) report(file, i + 1, 'waits on real time; use vi.useFakeTimers, or wait for the event itself');
    if (isUnitTest(file) && WALL_TIME.test(line)) report(file, i + 1, 'measures wall time; time budgets belong in scripts/bench.mjs');
    if (file !== TEST_SUPPORT && TEMP_DIR.test(line)) report(file, i + 1, `creates a temporary folder; use runFolder, makeTempDir or makeProject of the test support (${TEST_SUPPORT})`);
  });
}

function checkCommand(file, text, sf) {
  const exported = sf.statements.filter((s) => ts.isFunctionDeclaration(s) && s.name && /Command$/.test(s.name.text) && s.name.text !== 'parseCommand' && s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
  if (exported.length === 0) return;
  if (!text.includes('parseCommand(')) report(file, 1, 'a command parses its arguments with parseCommand (commands/io.ts)');
  if (/\bparseArgs\b/.test(text)) report(file, 1, 'a command calls util.parseArgs itself; use parseCommand (commands/io.ts)');
  const visit = (node) => {
    if (ts.isReturnStatement(node) && node.expression) {
      const literal = (e) => ts.isNumericLiteral(e) || (ts.isConditionalExpression(e) && (literal(e.whenTrue) || literal(e.whenFalse))) || (ts.isParenthesizedExpression(e) && literal(e.expression));
      if (literal(node.expression)) report(file, sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, `returns the exit code ${node.expression.getText(sf)}; use EXIT_CODES`);
    }
    ts.forEachChild(node, visit);
  };
  for (const fn of sf.statements) visit(fn);
}

const helperDefinitions = new Map(SHARED_HELPERS.map((name) => [name, []]));
for (const file of sources()) {
  const text = readFileSync(path.join(repo, file), 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  if (!isTest(file) && !COMPLEXITY_EXEMPT.has(file)) checkFunctions(file, sf);
  if (isTest(file)) checkTestFile(file, text);
  if (/^cli\/src\/commands\/[^/]+\.ts$/.test(file) && !isTest(file)) checkCommand(file, text, sf);
  // The plugin runtimes of cli/src/hooks/plugins/ run inside another program, so they cannot import the helpers.
  if (!file.startsWith('cli/src/hooks/plugins/')) for (const d of definitions(sf)) helperDefinitions.get(d.name)?.push(`${file}:${d.line}`);
}
for (const [name, places] of helperDefinitions) {
  if (places.length > 1) report(places[1].split(':')[0], places[1].split(':')[1], `${name} is defined ${places.length} times: ${places.join(', ')}`);
}

const reportAt = process.argv.indexOf('--unit-report');
if (reportAt !== -1) {
  const vitest = JSON.parse(readFileSync(path.resolve(process.argv[reportAt + 1]), 'utf8'));
  for (const result of vitest.testResults) {
    const ms = result.endTime - result.startTime;
    const file = path.relative(repo, result.name).split(path.sep).join('/');
    if (ms > MAX_TEST_FILE_MS && !file.startsWith('examples/')) report(file, 1, `ran for ${(ms / 1000).toFixed(1)} s, more than ${MAX_TEST_FILE_MS / 1000} s; split it by behavior`);
  }
}

if (problems.length > 0) {
  console.error(`quality: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('quality: every convention holds');
