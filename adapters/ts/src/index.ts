import { analyzeProject } from './analyze.js';
import { AdapterEnvironmentError } from './errors.js';
import { initProject } from './init.js';
import {
  ABI_VERSION,
  type AnalyzeRequest,
  type AnalyzeResponse,
  type InfoResponse,
  type InitRequest,
  type InitResponse,
} from './protocol.js';

export * from './protocol.js';
export { AdapterEnvironmentError } from './errors.js';

export function info(): InfoResponse {
  return {
    abi: ABI_VERSION,
    name: 'ts',
    version: '1.0.0',
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    dmzExtension: '.ts',
  };
}

/** Writes the tsconfig.json alias and noUnusedLocals, and adjusts nest-cli.json and the Jest config when they exist. */
export async function init(projectDir: string, request: InitRequest): Promise<InitResponse> {
  checkAbi(request.abi);
  return guard(() => initProject(projectDir, request));
}

/** Describes the requested DMZ and code files. Rule violations come back as data; only environment problems throw. */
export async function analyze(projectDir: string, request: AnalyzeRequest): Promise<AnalyzeResponse> {
  checkAbi(request.abi);
  return guard(() => analyzeProject(projectDir, request));
}

function checkAbi(abi: number): void {
  if (abi !== ABI_VERSION) {
    throw new AdapterEnvironmentError('adapter-failed', `adapter-ts speaks protocol ${ABI_VERSION}, but the request uses protocol ${abi}`);
  }
}

/** Turns unexpected errors into AdapterEnvironmentError('adapter-failed'), so the CLI has one error type to map to exit code 3. */
function guard<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof AdapterEnvironmentError) throw error;
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    throw new AdapterEnvironmentError('adapter-failed', `adapter-ts failed: ${detail}`);
  }
}
