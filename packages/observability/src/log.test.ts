import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorName, log } from './log';

describe('log', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes info lines to stdout as one JSON object', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    log('info', 'worker_started', { jobs: 3 });
    const line = JSON.parse(String(out.mock.calls[0]?.[0]));
    expect(line).toEqual({
      time: expect.any(String),
      level: 'info',
      event: 'worker_started',
      jobs: 3,
    });
    expect(Number.isNaN(Date.parse(line.time))).toBe(false);
  });

  it('writes warnings and errors to stderr', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    log('warn', 'sync_error', { code: 'x' });
    log('error', 'queue_error');
    expect(err).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(err.mock.calls[1]?.[0]))).toMatchObject({
      level: 'error',
      event: 'queue_error',
    });
  });
});

describe('errorName', () => {
  it('keeps only the name of an error', () => {
    const error = new TypeError('secret token');
    expect(errorName(error)).toBe('TypeError');
    expect(errorName('secret token')).toBe('unknown');
  });
});
