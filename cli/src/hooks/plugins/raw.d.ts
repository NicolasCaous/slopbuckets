// A `?raw` import is the text of the file: vitest reads it natively, and the build through the plugin in
// cli/tsup.config.ts.
declare module '*?raw' {
  const text: string;
  export default text;
}
