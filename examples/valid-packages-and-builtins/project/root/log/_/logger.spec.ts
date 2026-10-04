import { describe, expect, it } from 'vitest';
import { logger } from '@root/log/_/logger';

describe('logger', () => {
  it('exposes info and error', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
  });
});
