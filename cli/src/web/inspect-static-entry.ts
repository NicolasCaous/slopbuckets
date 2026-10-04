// The browser side of `buckets inspect --export html`, bundled into the file by the CLI (static-bundle.ts). It reads
// the data the CLI wrote into the page and gives the page script (assets/inspect.ts) `window.bucketsStatic`:
//
//   bucketsStatic.page(url)   the page for a URL (`#view=matrix` or `/?view=matrix`), as the HTML the server would send
//   bucketsStatic.file(link)  the file of a download link of the page, as { name, type, text }, or null
//
// The page script swaps pages with it instead of fetching them, so the file makes no request.
import { useCompiledMapCore } from '../inspect/map-svg.js';
import { STATIC_DATA_ID, staticDocument, staticExport, unpackStaticData, type StaticFileData } from './inspect-static.js';
import { compiledMapCore } from './map-core-compiled.js';

// The timeline and the exports draw maps with the map core, which the page cannot evaluate from text.
if (compiledMapCore !== null) useCompiledMapCore(compiledMapCore);

// The CLI compiles without the DOM library, so the two globals this file touches are declared here.
declare const document: { getElementById(id: string): { textContent: string | null } | null };
declare const window: { bucketsStatic?: unknown };

const holder = document.getElementById(STATIC_DATA_ID);
if (holder !== null && holder.textContent !== null) {
  const data = unpackStaticData(JSON.parse(holder.textContent) as StaticFileData);
  window.bucketsStatic = {
    page: (url: string): string => staticDocument(data, url),
    file: (link: string) => staticExport(data, link),
  };
}
