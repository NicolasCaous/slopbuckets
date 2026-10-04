// Sanity checks for the example cases. Needs no CLI build.
//  - every case.json parses and follows the case format
//  - every rule id, lock change kind and environment code is one of the SPEC.md values
//  - every project/ folder has the required files
//  - every case that expects a clean check type-checks with the root `typescript`

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, test } from 'vitest';
import { caseArgs, isCheckJson, listCaseNames, loadCase, runDir, validateCase } from './case-format.js';

/** This run's scratch folder, examples/.tmp/fixtures-<pid>-<time>/, removed when the file is done. */
const RUN_DIR = runDir('fixtures');

const caseNames = listCaseNames();

describe('example fixtures', () => {
  test('there are cases', () => {
    expect(caseNames.length).toBeGreaterThan(0);
  });

  for (const name of caseNames) {
    test(`${name} has a valid case.json and project`, () => {
      let problems: string[];
      try {
        problems = validateCase(loadCase(name));
      } catch (error) {
        problems = [`case.json does not parse: ${(error as Error).message}`];
      }
      expect(problems, `examples/${name}/case.json`).toEqual([]);
    });
  }
});

/** Copies project/ plus after/ minus "delete" to a scratch folder inside the repository and returns the TypeScript diagnostics. */
function typeCheck(name: string): string[] {
  const loaded = loadCase(name);
  const workDir = path.join(RUN_DIR, name);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(path.dirname(workDir), { recursive: true });
  cpSync(loaded.projectDir, workDir, { recursive: true });
  if (loaded.afterDir !== null) cpSync(loaded.afterDir, workDir, { recursive: true, force: true });
  for (const item of loaded.spec.delete ?? []) rmSync(path.join(workDir, item), { recursive: true, force: true });

  const configPath = path.join(workDir, 'tsconfig.json');
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => undefined,
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, { noEmit: true }, host);
  if (!parsed) return ['tsconfig.json could not be read'];
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  return diagnostics.map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (!diagnostic.file || diagnostic.start === undefined) return message;
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${path.relative(workDir, diagnostic.file.fileName).split(path.sep).join('/')}:${line + 1} ${message}`;
  });
}

/** Cases whose project must be valid TypeScript: a full or single-file check that expects no violations. */
const cleanCases = caseNames.filter((name) => {
  try {
    const { spec } = loadCase(name);
    return isCheckJson(caseArgs(spec)) && Array.isArray(spec.expect.violations) && spec.expect.violations.length === 0;
  } catch {
    return false;
  }
});

describe('clean example projects type-check', () => {
  afterAll(() => {
    rmSync(RUN_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  for (const name of cleanCases) {
    test(name, () => {
      if (!existsSync(path.join(loadCase(name).projectDir, 'tsconfig.json'))) return;
      expect(typeCheck(name), `tsc errors in examples/${name}`).toEqual([]);
    });
  }
});
