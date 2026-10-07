// The recursive check: the current project and every project nested inside it, at any depth, each checked on its
// own and joined into one report. A nested project lives in some `X/_/` of its parent and never reaches it by import.
import path from 'node:path';
import type { InfoResponse } from '@slopbuckets/adapter-ts';
import { runCheck, type CheckOptions, type CheckResult } from './check.js';
import { loadConfig } from './config.js';
import { readLinksManifest } from './links.js';
import { CONFIG_FILE } from './paths.js';
import { scanProject } from './scan.js';
import { resolveScripts, withScriptRuns } from './scripts.js';
import type { CheckReport, Context, ExitCode, Violation } from './types.js';

export interface ProjectRun {
  /** Relative to the project where the check started, `.` for that project. */
  path: string;
  dir: string;
  result: CheckResult;
}

export interface RecursiveOptions extends Omit<CheckOptions, 'file'> {
  /** False checks only the starting project. */
  recursive?: boolean;
}

/** `rel` joined to the path of its parent project, both relative to the starting project. */
export function joinProject(parent: string, rel: string): string {
  return parent === '.' ? rel : `${parent}/${rel}`;
}

/** The exit code of several projects: 3 if any had an environment problem, then 1, then 2, then 0. */
export function aggregateExitCode(codes: ExitCode[]): ExitCode {
  if (codes.includes(3)) return 3;
  if (codes.includes(1)) return 1;
  if (codes.includes(2)) return 2;
  return 0;
}

/**
 * The message of a violation in a project. The messages about the config name buckets.config.json without a folder,
 * so in a nested project they start with the path of its config, relative to the project where the check ran.
 */
function nestedConfigMessage(violation: Violation, project: string): string {
  if (project === '.' || violation.rule !== 'config-invalid' || violation.file !== CONFIG_FILE) return violation.message;
  return `In ${project}/${CONFIG_FILE}: ${violation.message}`;
}

/** Joins per-project reports into one, adding `project` to every violation and lock change. */
export function joinReports(runs: { path: string; report: CheckReport }[]): CheckReport {
  const report: CheckReport = {
    exitCode: aggregateExitCode(runs.map((r) => r.report.exitCode)),
    violations: runs.flatMap((r) => r.report.violations.map((v) => ({ ...v, message: nestedConfigMessage(v, r.path), project: r.path }))),
    lockChanges: runs.flatMap((r) => r.report.lockChanges.map((c) => ({ ...c, project: r.path }))),
    projects: runs.map((r) => ({ path: r.path, exitCode: r.report.exitCode })),
  };
  const env = runs.find((r) => r.report.environment);
  if (env?.report.environment) {
    const { code, message } = env.report.environment;
    report.environment = { code, message: env.path === '.' ? message : `In the nested project ${env.path}: ${message}` };
  }
  return report;
}

export async function runRecursiveCheck(ctx: Context, projectDir: string, options: RecursiveOptions = {}): Promise<{ report: CheckReport; runs: ProjectRun[] }> {
  // One check runs each script at most once. A caller that already started one, such as buildSnapshot, keeps its runs.
  if (ctx.scriptRuns === undefined) ctx = withScriptRuns(ctx);
  const runs: ProjectRun[] = [];
  const { recursive = true, ...checkOptions } = options;
  const visit = async (dir: string, rel: string): Promise<void> => {
    const result = await runCheck(ctx, dir, checkOptions);
    runs.push({ path: rel, dir, result });
    if (!recursive) return;
    for (const nested of result.nestedProjects) await visit(path.join(dir, nested), joinProject(rel, nested));
  };
  await visit(projectDir, '.');
  return { report: joinReports(runs.map((r) => ({ path: r.path, report: r.result.report }))), runs };
}

/**
 * The starting project and its nested projects, without analyzing any code. A project whose config is missing or
 * invalid is listed, but nothing below it is found.
 */
export function discoverProjects(ctx: Context, projectDir: string, recursive = true): { path: string; dir: string }[] {
  const out: { path: string; dir: string }[] = [];
  let info: ReturnType<Context['adapter']['info']> | null = null;
  try {
    info = ctx.adapter.info();
  } catch {
    info = null;
  }
  const visit = (dir: string, rel: string): void => {
    out.push({ path: rel, dir });
    if (!recursive || info === null) return;
    for (const nested of scanNested(ctx, dir, info)) visit(path.join(dir, nested), joinProject(rel, nested));
  };
  visit(projectDir, '.');
  return out;
}

/**
 * The projects nested directly in the project at `dir`, relative to it, sorted. Empty when its config is missing or
 * invalid, or when one of its scripts fails.
 */
export function nestedProjectsOf(ctx: Context, dir: string): string[] {
  try {
    return scanNested(ctx, dir, ctx.adapter.info());
  } catch {
    return [];
  }
}

function scanNested(ctx: Context, dir: string, info: Pick<InfoResponse, 'extensions' | 'dmzExtension'>): string[] {
  const config = loadConfig(dir);
  if (config.kind !== 'ok') return [];
  const scripts = resolveScripts(ctx, dir, config.config);
  if ('violations' in scripts) return [];
  const manifest = readLinksManifest(dir);
  const links = new Set(manifest.kind === 'ok' ? Object.keys(manifest.links) : []);
  const layout = scanProject(dir, config.config, { extensions: info.extensions, dmzExtension: info.dmzExtension, links, scripts: scripts.values });
  return [...layout.nestedProjects].sort();
}
