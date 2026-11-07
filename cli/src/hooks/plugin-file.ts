// Install and uninstall of the plugin file that a code-plugin harness (OpenCode, Pi, Amp) loads from the project. The
// file carries PLUGIN_MARKER, which is how slopbuckets tells its own file from a user's file of the same name: a user
// file is never overwritten, and slopbuckets writes its plugin under a second name instead.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { message } from '../output/index.js';
import type { InstallStep } from './adapter.js';
import { removeProjectFile, writeProjectFile } from './project-file.js';

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
      writeProjectFile(projectDir, file, spec.content);
      return { status: 'done', text: `Updated the slopbuckets plugin for ${spec.title} in ${rel}` };
    }
    if (!existsSync(primaryFile)) {
      writeProjectFile(projectDir, primaryFile, spec.content);
      return { status: 'done', text: `Installed the slopbuckets plugin for ${spec.title} in ${primary}` };
    }
    if (!existsSync(altFile)) {
      writeProjectFile(projectDir, altFile, spec.content);
      return { status: 'done', text: `Installed the slopbuckets plugin for ${spec.title} in ${alt}, because ${primary} is your own file and stays as it is` };
    }
    return {
      status: 'failed',
      text: `Could not install the slopbuckets plugin for ${spec.title}: ${primary} and ${alt} are your own files. Rename one of them and run \`buckets init\` again.`,
    };
  } catch (error) {
    return { status: 'failed', text: `Could not install the slopbuckets plugin for ${spec.title} in ${spec.dir}: ${message(error)}` };
  }
}

/** Removes the plugin files slopbuckets wrote, under either name, and the plugin folder when it is left empty. */
export function uninstallPluginFile(projectDir: string, spec: Omit<PluginFileSpec, 'content'>): InstallStep[] {
  const steps: InstallStep[] = [];
  for (const name of [spec.name, spec.altName]) {
    const rel = `${spec.dir}/${name}`;
    const file = path.join(projectDir, ...rel.split('/'));
    if (!existsSync(file) || !isOurs(file)) continue;
    try {
      removeProjectFile(projectDir, rel);
      steps.push({ status: 'done', text: `Removed the slopbuckets plugin for ${spec.title} from ${rel}` });
    } catch (error) {
      steps.push({ status: 'failed', text: `Could not remove ${rel}: ${message(error)}` });
    }
  }
  return steps;
}
