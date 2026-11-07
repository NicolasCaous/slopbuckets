// Web Worker entry of the graph layout. cli/scripts/build-inspect.mjs bundles this file on its own and embeds it in
// the page as the string __INSPECT_WORKER__; index.ts starts it from a blob URL.
import { computeLayout, type LayoutInput } from './layout.js';

self.onmessage = (event: MessageEvent<{ id: number; input: LayoutInput }>) => {
  self.postMessage({ id: event.data.id, layout: computeLayout(event.data.input) });
};
