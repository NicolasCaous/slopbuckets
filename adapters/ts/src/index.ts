// The TypeScript adapter, ABI 2: `info` and `analyze`. The CLI bundles it and calls it in-process. `resolveImports`,
// `emptyState` and the options of `analyze` are in-process extras that let the CLI keep resolution state in its cache.
export { analyze, info, resolveImports, type AdapterError, type AnalyzeOptions, type ResolveQuery } from './analyze.js';
export { AdapterEnvironmentError } from './errors.js';
export { sourcePattern, toPosix } from './paths.js';
export {
  ADAPTER_ABI,
  type AnalyzeRequest,
  type AnalyzeResponse,
  type FileAnalysis,
  type ImportedName,
  type ImportRecord,
  type ImportTarget,
  type InfoResponse,
  type NamedReexport,
  type PublicExports,
  type ResolutionInput,
  type StarReexport,
} from './protocol.js';
export { emptyState, type AdapterState, type ImportKind } from './resolve.js';
