import { describe, expect, it } from 'vitest';
import { parseJson, stripBom } from './json.js';

const BOM = '﻿';

describe('UTF-8 byte order mark', () => {
  it('strips one leading BOM and nothing else', () => {
    expect(stripBom(`${BOM}{}`)).toBe('{}');
    expect(stripBom('{}')).toBe('{}');
    expect(stripBom(` ${BOM}`)).toBe(` ${BOM}`);
    expect(parseJson(`${BOM}{"a": 1}`)).toEqual({ a: 1 });
  });
});
