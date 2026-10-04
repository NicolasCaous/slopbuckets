import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject, readFile } from '../testing/fixture.js';
import { appendItemEdits, JsoncText, removeItemEdits, removePropertyEdits, setPropertyEdits, UnsafeEdit, type JsonArray, type JsonObject } from './jsonc.js';
import { addLinkExclude, addLinkPath, bundlerInstructions, linkTarget, removeLinkExclude, removeLinkPath } from './tsconfig-paths.js';

afterEach(cleanupProjects);

const LINK = 'root/web/_/links/api';

function paths(doc: JsoncText): JsonObject {
  const options = doc.property(doc.root, 'compilerOptions')!.value;
  return doc.property(options, 'paths')!.value as JsonObject;
}

function set(text: string, key: string, value: unknown): string {
  const doc = new JsoncText(text);
  return doc.apply(setPropertyEdits(doc, paths(doc), key, value));
}

function remove(text: string, key: string): string {
  const doc = new JsoncText(text);
  return doc.apply(removePropertyEdits(doc, paths(doc), key));
}

describe('JSONC editing', () => {
  it('parses comments, trailing commas and a byte order mark, and gives plain values', () => {
    const doc = new JsoncText('﻿{\n  // c\n  "a": [1, "x",], /* d */ "b": { "c": null },\n}\n');
    expect(doc.valueOf(doc.root)).toEqual({ a: [1, 'x'], b: { c: null } });
    expect(() => new JsoncText('{ "a": }')).toThrow(UnsafeEdit);
    expect(() => new JsoncText('{ "a": 1 } x')).toThrow(UnsafeEdit);
  });

  it('adds a property in the style of the object and keeps comments and the byte order mark', () => {
    const multi = '﻿{\n  "compilerOptions": {\n    "paths": {\n      "@root/*": ["./root/*"] // own code\n    }\n  }\n}\n';
    expect(set(multi, '@api/*', ['./x/*'])).toBe('﻿{\n  "compilerOptions": {\n    "paths": {\n      "@root/*": ["./root/*"], // own code\n      "@api/*": ["./x/*"]\n    }\n  }\n}\n');
    const trailing = '{\n  "compilerOptions": {\n    "paths": {\n      "@root/*": ["./root/*"],\n    },\n  },\n}\n';
    expect(set(trailing, '@api/*', ['./x/*'])).toBe('{\n  "compilerOptions": {\n    "paths": {\n      "@root/*": ["./root/*"],\n      "@api/*": ["./x/*"],\n    },\n  },\n}\n');
    expect(set('{ "compilerOptions": { "paths": { "@root/*": ["./root/*"] } } }', '@api/*', ['./x/*'])).toBe(
      '{ "compilerOptions": { "paths": { "@root/*": ["./root/*"], "@api/*": ["./x/*"] } } }',
    );
    expect(set('{\r\n  "compilerOptions": {\r\n    "paths": {}\r\n  }\r\n}\r\n', '@api/*', ['./x/*'])).toBe(
      '{\r\n  "compilerOptions": {\r\n    "paths": {\r\n      "@api/*": ["./x/*"]\r\n    }\r\n  }\r\n}\r\n',
    );
  });

  it('replaces an existing value, but not one that holds a comment', () => {
    expect(set('{ "compilerOptions": { "paths": { "@api/*": ["./old/*"] } } }', '@api/*', ['./x/*'])).toBe('{ "compilerOptions": { "paths": { "@api/*": ["./x/*"] } } }');
    expect(() => set('{ "compilerOptions": { "paths": { "@api/*": [/* keep */ "./old/*"] } } }', '@api/*', ['./x/*'])).toThrow(UnsafeEdit);
  });

  it('removes a property with its comma, in every position', () => {
    const text = '{\n  "compilerOptions": {\n    "paths": {\n      "a": [1],\n      "b": [2],\n      "c": [3]\n    }\n  }\n}\n';
    expect(remove(text, 'a')).toBe('{\n  "compilerOptions": {\n    "paths": {\n      "b": [2],\n      "c": [3]\n    }\n  }\n}\n');
    expect(remove(text, 'b')).toBe('{\n  "compilerOptions": {\n    "paths": {\n      "a": [1],\n      "c": [3]\n    }\n  }\n}\n');
    expect(remove(text, 'c')).toBe('{\n  "compilerOptions": {\n    "paths": {\n      "a": [1],\n      "b": [2]\n    }\n  }\n}\n');
    expect(remove('{ "compilerOptions": { "paths": { "a": [1], "b": [2] } } }', 'a')).toBe('{ "compilerOptions": { "paths": { "b": [2] } } }');
    expect(remove('{ "compilerOptions": { "paths": { "a": [1] } } }', 'a')).toBe('{ "compilerOptions": { "paths": {} } }');
    expect(remove('{ "compilerOptions": { "paths": { "a": [1], } } }', 'b')).toBe('{ "compilerOptions": { "paths": { "a": [1], } } }');
    // A comment after the previous comma stays where it is, with its line break.
    expect(remove('{ "compilerOptions": { "paths": { "a": [1], // keep\n "b": [2] } } }', 'b')).toBe('{ "compilerOptions": { "paths": { "a": [1] // keep\n } } }');
    expect(() => remove('{ "compilerOptions": { "paths": { "a": [1], /* keep */ "b": [2] } } }', 'b')).toThrow(UnsafeEdit);
  });
});

describe('JSONC editing of an empty container with comments', () => {
  it('adds a property after the comment of an empty object and keeps the comment', () => {
    const multi = '{\n  "compilerOptions": {\n    "paths": {\n      // aliases go here\n    }\n  }\n}\n';
    expect(set(multi, '@api/*', ['./x/*'])).toBe('{\n  "compilerOptions": {\n    "paths": {\n      // aliases go here\n      "@api/*": ["./x/*"]\n    }\n  }\n}\n');
    const opening = '{\n  "compilerOptions": {\n    "paths": { // aliases go here\n    }\n  }\n}\n';
    expect(set(opening, '@api/*', ['./x/*'])).toBe('{\n  "compilerOptions": {\n    "paths": { // aliases go here\n      "@api/*": ["./x/*"]\n    }\n  }\n}\n');
    expect(set('{ "compilerOptions": { "paths": { /* none */ } } }', '@api/*', ['./x/*'])).toBe('{ "compilerOptions": { "paths": { /* none */ "@api/*": ["./x/*"] } } }');
    const crlf = '{\r\n  "compilerOptions": {\r\n    "paths": {\r\n      /* aliases */\r\n    }\r\n  }\r\n}\r\n';
    expect(set(crlf, '@api/*', ['./x/*'])).toBe('{\r\n  "compilerOptions": {\r\n    "paths": {\r\n      /* aliases */\r\n      "@api/*": ["./x/*"]\r\n    }\r\n  }\r\n}\r\n');
  });

  it('appends and removes array items in the style of the array', () => {
    const exclude = (doc: JsoncText): JsonArray => doc.property(doc.root, 'exclude')!.value as JsonArray;
    const append = (text: string, value: string): string => {
      const doc = new JsoncText(text);
      return doc.apply(appendItemEdits(doc, exclude(doc), value));
    };
    const removeAt = (text: string, index: number): string => {
      const doc = new JsoncText(text);
      return doc.apply(removeItemEdits(doc, exclude(doc), index));
    };
    expect(append('{ "exclude": [] }', 'b')).toBe('{ "exclude": ["b"] }');
    expect(append('{ "exclude": ["a"] }', 'b')).toBe('{ "exclude": ["a", "b"] }');
    expect(append('{\n  "exclude": [\n    "a" // keep\n  ]\n}\n', 'b')).toBe('{\n  "exclude": [\n    "a", // keep\n    "b"\n  ]\n}\n');
    expect(append('{ "exclude": [ /* none yet */ ] }', 'b')).toBe('{ "exclude": [ /* none yet */ "b" ] }');
    expect(removeAt('{ "exclude": ["a", "b"] }', 1)).toBe('{ "exclude": ["a"] }');
    expect(removeAt('{ "exclude": ["a", "b"] }', 0)).toBe('{ "exclude": ["b"] }');
    expect(removeAt('{ "exclude": ["a"] }', 0)).toBe('{ "exclude": [] }');
    expect(() => removeAt('{ "exclude": ["a", /* keep */ "b"] }', 1)).toThrow(UnsafeEdit);
  });
});

describe('the tsconfig.json exclude entry of a link', () => {
  const OPTIONS = '{\n  "compilerOptions": {\n    "strict": true\n  },\n  "include": ["root"]\n}\n';

  it('adds an exclude after the other properties when the file has none, and removing the link restores the file', () => {
    const dir = makeProject({ 'tsconfig.json': OPTIONS });
    expect(addLinkExclude(dir, LINK)).toEqual({ status: 'added', line: `"exclude": ["${LINK}"]` });
    expect(readFile(dir, 'tsconfig.json')).toBe(`{\n  "compilerOptions": {\n    "strict": true\n  },\n  "include": ["root"],\n  "exclude": ["${LINK}"]\n}\n`);
    expect(addLinkExclude(dir, LINK).status).toBe('unchanged');
    expect(removeLinkExclude(dir, LINK)).toEqual({ status: 'removed', line: `"${LINK}"` });
    expect(readFile(dir, 'tsconfig.json')).toBe(OPTIONS);
    expect(removeLinkExclude(dir, LINK).status).toBe('absent');
  });

  it('appends to an exclude of its own, keeps its comments, and removes only its entry', () => {
    const text = '{\n  // build settings\n  "include": ["root"],\n  "exclude": [\n    "dist" // output\n  ]\n}\n';
    const dir = makeProject({ 'tsconfig.json': text });
    expect(addLinkExclude(dir, LINK).status).toBe('added');
    expect(readFile(dir, 'tsconfig.json')).toBe(`{\n  // build settings\n  "include": ["root"],\n  "exclude": [\n    "dist", // output\n    "${LINK}"\n  ]\n}\n`);
    // A pattern that already covers the folder counts as the entry.
    const covered = makeProject({ 'tsconfig.json': `{ "exclude": ["./${LINK}/**"] }` });
    expect(addLinkExclude(covered, LINK).status).toBe('unchanged');
    expect(removeLinkExclude(dir, LINK).status).toBe('removed');
    expect(readFile(dir, 'tsconfig.json')).toBe('{\n  // build settings\n  "include": ["root"],\n  "exclude": [\n    "dist" // output\n  ]\n}\n');
  });

  it('copies the exclude patterns it inherits through extends, rebased on the folder of tsconfig.json', () => {
    const dir = makeProject({
      'tsconfig.json': '{ "extends": "./config/base", "include": ["root"] }',
      'config/base.json': '{ "extends": "./outer.json", "exclude": ["../dist", "**/*.spec.ts"] }',
      'config/outer.json': '{ "exclude": ["ignored"] }',
    });
    expect(addLinkExclude(dir, LINK)).toEqual({ status: 'added', line: `"exclude": ["dist", "config/**/*.spec.ts", "${LINK}"]` });
    expect(readFile(dir, 'tsconfig.json')).toBe(`{ "extends": "./config/base", "include": ["root"], "exclude": ["dist", "config/**/*.spec.ts", "${LINK}"] }`);
  });

  it('copies outDir, which TypeScript excludes when no config declares exclude, also from a package config', () => {
    const dir = makeProject({
      'tsconfig.json': '{ "extends": "@acme/tsconfig/base.json", "compilerOptions": { "declarationDir": "types" } }',
      'node_modules/@acme/tsconfig/base.json': '{ "compilerOptions": { "outDir": "../../../build" } }',
    });
    expect(addLinkExclude(dir, LINK).line).toBe(`"exclude": ["build", "types", "${LINK}"]`);
  });

  it('prints the line to add when it cannot edit the file or read what it extends', () => {
    const missing = makeProject({ 'tsconfig.json': '{ "extends": "./nope.json" }' });
    expect(addLinkExclude(missing, LINK)).toMatchObject({ status: 'manual', line: `"exclude": ["${LINK}"]`, reason: expect.stringContaining('"./nope.json" that tsconfig.json extends was not found') });
    expect(readFile(missing, 'tsconfig.json')).toBe('{ "extends": "./nope.json" }');
    const notArray = makeProject({ 'tsconfig.json': '{ "exclude": "dist" }' });
    expect(addLinkExclude(notArray, LINK)).toMatchObject({ status: 'manual', line: `"${LINK}"` });
    expect(addLinkExclude(makeProject({}), LINK)).toMatchObject({ status: 'manual', reason: 'the project has no tsconfig.json' });
  });
});

describe('the tsconfig.json entry of a link', () => {
  it('computes the target from baseUrl when the file sets one', () => {
    const dir = makeProject({});
    expect(linkTarget(dir, LINK, undefined)).toBe(`./${LINK}/*`);
    expect(linkTarget(dir, LINK, '.')).toBe(`./${LINK}/*`);
    expect(linkTarget(dir, LINK, 'root')).toBe('./web/_/links/api/*');
    expect(linkTarget(dir, LINK, 'src')).toBe(`../${LINK}/*`);
  });

  it('adds, keeps and removes the entry, and leaves another target alone', () => {
    const original = '{\n  "compilerOptions": {\n    "paths": {\n      "@root/*": ["./root/*"]\n    }\n  }\n}\n';
    const dir = makeProject({ 'tsconfig.json': original });
    expect(addLinkPath(dir, '@api', LINK)).toEqual({ status: 'added', line: `"@api/*": ["./${LINK}/*"]` });
    expect(addLinkPath(dir, '@api', LINK).status).toBe('unchanged');
    expect(removeLinkPath(dir, '@api', LINK).status).toBe('removed');
    expect(readFile(dir, 'tsconfig.json')).toBe(original);
    expect(removeLinkPath(dir, '@api', LINK).status).toBe('absent');
    expect(removeLinkPath(dir, '@root', LINK).status).toBe('absent');
    expect(readFile(dir, 'tsconfig.json')).toBe(original);
  });

  it('points an entry that maps the alias elsewhere at the link', () => {
    const dir = makeProject({ 'tsconfig.json': '{ "compilerOptions": { "paths": { "@api/*": ["../api/root/*"] } } }' });
    expect(addLinkPath(dir, '@api', LINK).status).toBe('updated');
    expect(readFile(dir, 'tsconfig.json')).toBe(`{ "compilerOptions": { "paths": { "@api/*": ["./${LINK}/*"] } } }`);
  });

  it('adds the entry to a paths object that holds only a comment, and keeps the comment', () => {
    const text = '{\n  "compilerOptions": {\n    "paths": {\n      // links add their aliases here\n    }\n  }\n}\n';
    const dir = makeProject({ 'tsconfig.json': text });
    expect(addLinkPath(dir, '@api', LINK).status).toBe('added');
    expect(readFile(dir, 'tsconfig.json')).toBe(`{\n  "compilerOptions": {\n    "paths": {\n      // links add their aliases here\n      "@api/*": ["./${LINK}/*"]\n    }\n  }\n}\n`);
  });

  it('asks for a hand edit when the file has no paths of its own, cannot be parsed, or is missing', () => {
    for (const text of ['{ "extends": "./base.json" }', '{ "compilerOptions": {} }', '{ nope']) {
      const dir = makeProject({ 'tsconfig.json': text });
      const edit = addLinkPath(dir, '@api', LINK);
      expect(edit.status, text).toBe('manual');
      expect(edit.line).toBe(`"@api/*": ["./${LINK}/*"]`);
      expect(readFile(dir, 'tsconfig.json')).toBe(text);
    }
    expect(addLinkPath(makeProject({}), '@api', LINK)).toMatchObject({ status: 'manual', reason: 'the project has no tsconfig.json' });
  });

  it('prints bundler settings only for the configs it finds', () => {
    expect(bundlerInstructions(makeProject({}), '@api', LINK)).toEqual([]);
    const dir = makeProject({ 'vite.config.mts': '', 'next.config.js': '', 'webpack.config.cjs': '' });
    const lines = bundlerInstructions(dir, '@api', LINK);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("'@api': fileURLToPath(new URL('./root/web/_/links/api', import.meta.url))");
    expect(lines[1]).toContain('next.config.js (Next.js)');
    expect(lines[2]).toContain("resolve: { alias: { '@api': path.resolve(__dirname, './root/web/_/links/api') } }");
  });
});
