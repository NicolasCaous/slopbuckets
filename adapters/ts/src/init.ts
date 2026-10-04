// `init`: writes the settings slopbuckets needs into the project's tool configs.
// Each step compares before writing, so a second run changes nothing. Files are
// edited in place, one property at a time, so comments and formatting survive.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { folderReach, loadTypeScript, readProjectConfig, type TypeScript } from './env.js';
import { AdapterEnvironmentError } from './errors.js';
import { parseJson } from './json.js';
import { JsoncDocument, UnsafeEdit } from './jsonc-edit.js';
import { aliasKey, checkBuildFolders, checkCompilerOptions, expectedAliasTarget } from './project-config.js';
import { ABI_VERSION, type BucketsConfig, type InitRequest, type InitResponse } from './protocol.js';

type Json = Record<string, unknown>;
type Change = InitResponse['changed'][number];

export function initProject(projectDir: string, request: InitRequest): InitResponse {
  projectDir = path.resolve(projectDir);
  const ts = loadTypeScript(projectDir);
  const changed: Change[] = [];
  const push = (change: Change | undefined) => {
    if (change !== undefined) changed.push(change);
  };
  push(initTsconfig(ts, projectDir, request.config));
  push(initExclude(ts, projectDir, request.config, request.nestedProjects ?? []));
  push(initNestCli(ts, projectDir, request.config));
  push(initJest(ts, projectDir, request.config));
  return { abi: ABI_VERSION, changed };
}

function initTsconfig(ts: TypeScript, projectDir: string, config: BucketsConfig): Change | undefined {
  // The effective options include `extends`, so a base config that already has the settings counts.
  // In a solution-style tsconfig.json, the settings belong in the referenced app config, which this picks.
  const effective = readProjectConfig(ts, projectDir, config.root);
  if (effective.unchosen !== undefined) return { file: 'tsconfig.json', written: false, description: `not changed, because ${effective.unchosen}` };
  const file = effective.file;
  const name = effective.name;
  const configDir = path.dirname(file);
  const problems = checkCompilerOptions(projectDir, config, effective.options, configDir);
  // Init does not rewrite "include", "exclude" or "rootDir" for the root folder: it says what to change instead.
  const buildNotes = effective.missesRoot ? [] : checkBuildFolders(projectDir, config, effective);
  if (problems.length === 0) {
    return buildNotes.length === 0 ? undefined : { file: name, written: false, description: `no change written, but ${buildNotes.map(lowerFirst).join('; ')}` };
  }

  const key = aliasKey(config);
  // Parsed `baseUrl` is absolute, and it may come from an extended config.
  const target = expectedAliasTarget(projectDir, config, effective.options.baseUrl, configDir);
  const wantAlias = problems.some((p) => p.startsWith('compilerOptions.paths'));
  const wantUnused = effective.options.noUnusedLocals !== true;
  if (!wantAlias && !wantUnused) return undefined;
  const done = [...(wantAlias ? [`alias ${key}`] : []), ...(wantUnused ? ['noUnusedLocals'] : [])];
  const note = effective.missesRoot
    ? `; its "include" does not cover ${config.root}/ yet, so add ${config.root}/ to it`
    : buildNotes.map((text) => `; ${lowerFirst(text)}`).join('');

  // What `compilerOptions` must gain if the child declares no `paths` of its own: the inherited entries plus the alias.
  const newPaths = { ...inheritedPaths(configDir, effective.options, key), [key]: [target] };
  const text = readFileSync(file, 'utf8');
  const doc = openDocument(ts, file, text);
  let updated: string;
  try {
    if (doc.root === undefined) throw new UnsafeEdit('the file is not a JSON object');
    const compilerOptions = doc.object(doc.root, 'compilerOptions');
    if (compilerOptions === undefined) {
      doc.set(doc.root, 'compilerOptions', { ...(wantAlias ? { paths: newPaths } : {}), ...(wantUnused ? { noUnusedLocals: true } : {}) });
    } else {
      if (wantAlias) {
        const paths = doc.object(compilerOptions, 'paths');
        if (paths === undefined) doc.set(compilerOptions, 'paths', newPaths);
        else doc.set(paths, key, [target]);
      }
      if (wantUnused) doc.set(compilerOptions, 'noUnusedLocals', true);
    }
    updated = doc.apply();
  } catch (error) {
    if (!(error instanceof UnsafeEdit)) throw error;
    const lines = [...(wantAlias ? [`"paths": { "${key}": ["${target}"] }`] : []), ...(wantUnused ? ['"noUnusedLocals": true'] : [])];
    const inherited = wantAlias && Object.keys(newPaths).length > 1 ? ` (also copy the "paths" entries inherited through "extends": ${JSON.stringify(newPaths)})` : '';
    return {
      file: name,
      written: false,
      description: `not changed, because ${error.message} and editing it would lose comments; add ${lines.join(' and ')} to "compilerOptions" by hand${inherited}${note}`,
    };
  }
  writeFileSync(file, updated);
  return { file: name, description: `${done.join(' and ')}${note}` };
}

/**
 * Keeps nested projects out of the build: adds each nested project folder that `include` reaches to `exclude` of
 * the chosen tsconfig. When the config declares no `exclude`, the new one also copies the entries it inherits
 * through `extends` (or that TypeScript adds for `outDir`), because a declared `exclude` replaces them.
 */
function initExclude(ts: TypeScript, projectDir: string, config: BucketsConfig, nestedProjects: readonly string[]): Change | undefined {
  if (nestedProjects.length === 0) return undefined;
  const effective = readProjectConfig(ts, projectDir, config.root);
  const coverage = effective.coverage;
  if (effective.unchosen !== undefined || coverage === undefined) return undefined;
  const name = effective.name;
  const configDir = path.dirname(effective.file);
  const wanted: string[] = [];
  const listed: string[] = [];
  for (const nested of nestedProjects) {
    const dir = path.resolve(projectDir, nested);
    const reach = folderReach(coverage, dir);
    if (reach === 'include') wanted.push(excludeEntry(configDir, dir));
    else if (reach === 'files') listed.push(nested);
  }
  const filesNote =
    listed.length === 0
      ? ''
      : `"files" lists files of the nested project${listed.length === 1 ? '' : 's'} ${listed.join(', ')}, which build${listed.length === 1 ? 's' : ''} with ${listed.length === 1 ? 'its' : 'their'} own tsconfig.json, so remove them from "files" by hand`;
  if (wanted.length === 0) return filesNote === '' ? undefined : { file: name, written: false, description: `not changed, because ${filesNote}` };
  const what = `exclude ${wanted.join(', ')} (nested project${wanted.length === 1 ? '' : 's'})${filesNote === '' ? '' : `; ${filesNote}`}`;

  const text = readFileSync(effective.file, 'utf8');
  const doc = openDocument(ts, effective.file, text);
  const declared = doc.root === undefined ? undefined : doc.property(doc.root, 'exclude');
  // Specs reach TypeScript relative to the config folder or absolute; written back relative to the edited file.
  const inherited = declared === undefined ? (coverage.patterns[0]?.excludes ?? []).map((spec) => excludeEntry(configDir, path.resolve(coverage.patterns[0]!.basePath, spec))) : [];
  const fresh = [...inherited.filter((entry) => !wanted.includes(entry)), ...wanted];
  let updated: string;
  try {
    if (doc.root === undefined) throw new UnsafeEdit('the file is not a JSON object');
    const exclude = doc.array(doc.root, 'exclude');
    if (exclude === undefined) doc.set(doc.root, 'exclude', fresh);
    else for (const entry of wanted) doc.append(exclude, entry);
    updated = doc.apply();
  } catch (error) {
    if (!(error instanceof UnsafeEdit)) throw error;
    const line =
      declared === undefined
        ? `add this line at the top level of ${name}: "exclude": ${JSON.stringify(fresh)}`
        : `add ${wanted.length === 1 ? 'this line' : 'these lines'} to the "exclude" array of ${name}: ${wanted.map((entry) => JSON.stringify(entry)).join(', ')}`;
    return { file: name, written: false, description: `not changed, because ${error.message} and editing it could lose comments; ${line}${filesNote === '' ? '' : `; ${filesNote}`}` };
  }
  writeFileSync(effective.file, updated);
  return { file: name, description: what };
}

/** An `exclude` entry for an absolute path, relative to the folder of the config and with `/`. */
function excludeEntry(configDir: string, absolute: string): string {
  const relative = path.relative(configDir, absolute).split(path.sep).join('/');
  return relative === '' ? '.' : relative;
}

/**
 * The `paths` entries the child inherits through `extends`, without the alias. Writing `paths` in the
 * child replaces the inherited object, so they are copied. Without `baseUrl`, targets resolve from the
 * config that declared them, so they are rewritten relative to the folder of the edited config.
 */
function inheritedPaths(configDir: string, options: { paths?: Record<string, string[]>; baseUrl?: string }, key: string): Record<string, string[]> {
  const paths = options.paths ?? {};
  const declaredIn = (options as { pathsBasePath?: string }).pathsBasePath;
  const result: Record<string, string[]> = {};
  for (const [pattern, targets] of Object.entries(paths)) {
    if (pattern === key) continue;
    result[pattern] =
      options.baseUrl !== undefined || declaredIn === undefined ? [...targets] : targets.map((t) => relativeTarget(configDir, path.resolve(declaredIn, t)));
  }
  return result;
}

function relativeTarget(configDir: string, absolute: string): string {
  const relative = path.relative(configDir, absolute).split(path.sep).join('/');
  return relative.startsWith('../') || relative === '..' ? relative : `./${relative}`;
}

function initNestCli(ts: TypeScript, projectDir: string, config: BucketsConfig): Change | undefined {
  const file = path.join(projectDir, 'nest-cli.json');
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, 'utf8');
  const doc = openDocument(ts, file, text);
  if (doc.root === undefined) throw new AdapterEnvironmentError('adapter-failed', 'adapter-ts: nest-cli.json is not a JSON object');
  const root = doc.root;
  const json = jsonOf(ts, file, text);
  const done: string[] = [];
  if (json.sourceRoot !== config.root) done.push('sourceRoot');
  if (json.entryFile !== '_/main') done.push('entryFile');
  if (done.length === 0) return undefined;
  return write(file, doc, 'nest-cli.json', done.join(' and '), () => {
    if (done.includes('sourceRoot')) doc.set(root, 'sourceRoot', config.root);
    if (done.includes('entryFile')) doc.set(root, 'entryFile', '_/main');
  });
}

function initJest(ts: TypeScript, projectDir: string, config: BucketsConfig): Change | undefined {
  const file = path.join(projectDir, 'package.json');
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, 'utf8');
  let manifest: Json;
  try {
    manifest = asObject(parseJson(text));
  } catch (error) {
    throw new AdapterEnvironmentError('adapter-failed', `adapter-ts: package.json is not valid JSON: ${(error as Error).message}`);
  }
  const jest = manifest.jest;
  if (jest === null || typeof jest !== 'object' || Array.isArray(jest)) return undefined;
  const jestConfig = jest as Json;

  // Jest resolves <rootDir> from its own rootDir option, which defaults to the package folder.
  const rootDir = typeof jestConfig.rootDir === 'string' ? path.resolve(projectDir, jestConfig.rootDir) : projectDir;
  const relativeRoot = path.relative(rootDir, path.resolve(projectDir, config.root)).split(path.sep).join('/');
  const pattern = `^${escapeRegExp(config.alias)}/(.*)$`;
  const replacement = `<rootDir>/${relativeRoot === '' ? '' : `${relativeRoot}/`}$1`;

  const mapper = jestConfig.moduleNameMapper;
  if (mapper !== null && typeof mapper === 'object' && (mapper as Json)[pattern] === replacement) return undefined;

  const doc = openDocument(ts, file, text);
  const jestProperty = doc.root === undefined ? undefined : doc.property(doc.root, 'jest');
  if (jestProperty === undefined || !ts.isObjectLiteralExpression(jestProperty.initializer)) return undefined;
  const jestNode = jestProperty.initializer;
  return write(file, doc, 'package.json', `jest moduleNameMapper for ${config.alias}`, () => {
    const mapperNode = doc.property(jestNode, 'moduleNameMapper');
    if (mapperNode !== undefined && ts.isObjectLiteralExpression(mapperNode.initializer)) doc.set(mapperNode.initializer, pattern, replacement);
    else doc.set(jestNode, 'moduleNameMapper', { [pattern]: replacement });
  });
}

function openDocument(ts: TypeScript, file: string, text: string): JsoncDocument {
  const doc = new JsoncDocument(ts, file, text);
  if (doc.parseErrors.length > 0) {
    throw new AdapterEnvironmentError('adapter-failed', `adapter-ts: cannot parse ${path.basename(file)}: ${doc.parseErrors[0]}`);
  }
  return doc;
}

/** Writes the edits. A value that cannot be replaced without losing comments leaves the file alone and says what to add. */
function write(file: string, doc: JsoncDocument, name: string, description: string, edit: () => void): Change {
  let text: string;
  try {
    edit();
    text = doc.apply();
  } catch (error) {
    if (!(error instanceof UnsafeEdit)) throw error;
    return { file: name, written: false, description: `not changed, because ${error.message} and editing it would lose comments; set ${description} by hand` };
  }
  writeFileSync(file, text);
  return { file: name, description };
}

function jsonOf(ts: TypeScript, file: string, text: string): Json {
  const { config, error } = ts.parseConfigFileTextToJson(file, text.replace(/^﻿/, ''));
  if (error !== undefined) throw new AdapterEnvironmentError('adapter-failed', `adapter-ts: cannot parse ${path.basename(file)}`);
  return asObject(config);
}

function asObject(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
