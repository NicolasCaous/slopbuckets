// Install and uninstall of the plugin file that a code-plugin harness (OpenCode, Pi, Amp) loads from the project. The
// file carries PLUGIN_MARKER, which is how slopbuckets tells its own file from a user's file of the same name: a user
// file is never overwritten or removed, and slopbuckets writes its plugin under a second name instead.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { InstallStep } from './adapter.js';

/** The text in the header of every plugin file slopbuckets writes. */
export const PLUGIN_MARKER = 'slopbuckets:managed-plugin';

export interface PluginFileSpec {
  /** The harness name for messages, such as `OpenCode`. */
  title: string;
  /** The folder relative to the project, with forward slashes, such as `.opencode/plugins`. */
  dir: string;
  /** The file name slopbuckets prefers, such as `slopbuckets.ts`. */
  name: string;
  /** The file name used when a user file already has `name`. */
  altName: string;
  /** The full text of the plugin file. It must contain PLUGIN_MARKER. */
  content: string;
}

function isOurs(file: string): boolean {
  try {
    return readFileSync(file, 'utf8').includes(PLUGIN_MARKER);
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The project-relative paths of the two names, for messages. */
function names(spec: PluginFileSpec): { primary: string; alt: string } {
  return { primary: `${spec.dir}/${spec.name}`, alt: `${spec.dir}/${spec.altName}` };
}

/**
 * Writes the plugin file. An existing file of slopbuckets under either name is updated in place, so the harness never
 * loads two copies. A user file named like the plugin stays, and the plugin goes under `altName`.
 */
export function installPluginFile(projectDir: string, spec: PluginFileSpec): InstallStep {
  const { primary, alt } = names(spec);
  const dir = path.join(projectDir, ...spec.dir.split('/'));
  const primaryFile = path.join(dir, spec.name);
  const altFile = path.join(dir, spec.altName);
  try {
    for (const [file, rel] of [
      [primaryFile, primary],
      [altFile, alt],
    ] as const) {
      if (!existsSync(file) || !isOurs(file)) continue;
      if (readFileSync(file, 'utf8') === spec.content) return { status: 'kept', text: `The slopbuckets plugin for ${spec.title} in ${rel} is up to date` };
      writeFileSync(file, spec.content, 'utf8');
      return { status: 'done', text: `Updated the slopbuckets plugin for ${spec.title} in ${rel}` };
    }
    mkdirSync(dir, { recursive: true });
    if (!existsSync(primaryFile)) {
      writeFileSync(primaryFile, spec.content, 'utf8');
      return { status: 'done', text: `Installed the slopbuckets plugin for ${spec.title} in ${primary}` };
    }
    if (!existsSync(altFile)) {
      writeFileSync(altFile, spec.content, 'utf8');
      return { status: 'done', text: `Installed the slopbuckets plugin for ${spec.title} in ${alt}, because ${primary} is your own file and stays as it is` };
    }
    return {
      status: 'failed',
      text: `Could not install the slopbuckets plugin for ${spec.title}: ${primary} and ${alt} are your own files. Rename one of them and run \`buckets init\` again.`,
    };
  } catch (error) {
    return { status: 'failed', text: `Could not install the slopbuckets plugin for ${spec.title} in ${spec.dir}: ${errorText(error)}` };
  }
}

/** Removes the plugin files slopbuckets wrote, under either name, and the plugin folder when it is left empty. */
export function uninstallPluginFile(projectDir: string, spec: PluginFileSpec): InstallStep[] {
  const steps: InstallStep[] = [];
  const dir = path.join(projectDir, ...spec.dir.split('/'));
  const { primary, alt } = names(spec);
  for (const [name, rel] of [
    [spec.name, primary],
    [spec.altName, alt],
  ] as const) {
    const file = path.join(dir, name);
    if (!existsSync(file) || !isOurs(file)) continue;
    try {
      rmSync(file, { force: true });
      steps.push({ status: 'done', text: `Removed the slopbuckets plugin for ${spec.title} from ${rel}` });
    } catch (error) {
      steps.push({ status: 'failed', text: `Could not remove ${rel}: ${errorText(error)}` });
    }
  }
  if (steps.length > 0) {
    try {
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      // A folder that cannot be listed or removed stays.
    }
  }
  return steps;
}
