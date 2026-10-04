import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { flushOnSigterm } from './shutdown';

/** A stand-in for `process`: signals and exit, nothing else. */
const fakeProcess = () => {
  const proc = new EventEmitter() as EventEmitter & { exit: (code?: number) => void };
  const exits: (number | undefined)[] = [];
  proc.exit = (code?: number) => {
    exits.push(code);
  };
  return { proc, exits };
};

describe('flushOnSigterm', () => {
  it('holds the exit Next.js asks for on SIGTERM until the flush has finished', async () => {
    const { proc, exits } = fakeProcess();
    let done!: () => void;
    const flush = vi.fn(() => new Promise<void>((resolve) => (done = resolve)));
    flushOnSigterm(flush, { proc, timeoutMs: 10_000 });
    proc.emit('SIGTERM');
    expect(flush).toHaveBeenCalledOnce();
    proc.exit(143); // Next's own handler, once its requests are done
    await new Promise((r) => setTimeout(r, 10));
    expect(exits).toEqual([]);
    done();
    await vi.waitFor(() => expect(exits).toEqual([143]));
  });

  it('never waits longer than the timeout, and survives a failing flush', async () => {
    vi.useFakeTimers();
    try {
      const { proc, exits } = fakeProcess();
      flushOnSigterm(() => new Promise<void>(() => {}), { proc, timeoutMs: 10_000 });
      proc.emit('SIGTERM');
      proc.exit(143);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(exits).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(exits).toEqual([143]);

      const failing = fakeProcess();
      flushOnSigterm(() => Promise.reject(new Error('network down')), {
        proc: failing.proc,
        timeoutMs: 10_000,
      });
      failing.proc.emit('SIGTERM');
      failing.proc.exit(143);
      await vi.advanceTimersByTimeAsync(0);
      expect(failing.exits).toEqual([143]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves exit alone until SIGTERM', () => {
    const { proc, exits } = fakeProcess();
    const flush = vi.fn(async () => {});
    flushOnSigterm(flush, { proc });
    proc.exit(0);
    expect(exits).toEqual([0]);
    expect(flush).not.toHaveBeenCalled();
  });
});
