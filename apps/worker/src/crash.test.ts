import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installCrashHandlers } from './crash';
import type { Logger } from './log';

describe('crash handlers', () => {
  it('log the error name only and shut down gracefully', () => {
    const proc = new EventEmitter();
    const lines: string[] = [];
    const log: Logger = (level, event, fields) =>
      lines.push(JSON.stringify({ level, event, ...fields }));
    const shutdown = vi.fn();
    installCrashHandlers(proc, log, shutdown);

    const leak = new TypeError('postgres://app_user:secret@db/agile');
    proc.emit('unhandledRejection', leak);
    proc.emit(
      'uncaughtException',
      Object.assign(new Error('token=abc'), { name: 'JiraHttpError' }),
    );
    proc.emit('unhandledRejection', 'a string reason');

    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { level: 'error', event: 'unhandled_rejection', error: 'TypeError' },
      { level: 'error', event: 'uncaught_exception', error: 'JiraHttpError' },
      { level: 'error', event: 'unhandled_rejection', error: 'unknown' },
    ]);
    expect(lines.join('\n')).not.toMatch(/secret|token=abc|a string reason/);
    expect(shutdown.mock.calls).toEqual([
      ['unhandledRejection'],
      ['uncaughtException'],
      ['unhandledRejection'],
    ]);
  });
});
