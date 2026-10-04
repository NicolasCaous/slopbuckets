// A stand-in for the browser script of `inspect --export html`. When web/static-bundle.ts bundles that script, it
// replaces this module with the map core source (assets/map-core.ts) as a compiled function, because the page of the
// file forbids `new Function`. Everywhere else the map core is evaluated from its text and this stays null.
import type { MapCore } from '../inspect/map-svg.js';

export const compiledMapCore: (() => MapCore) | null = null;
