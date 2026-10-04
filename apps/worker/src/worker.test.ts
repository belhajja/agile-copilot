import { readFileSync } from 'node:fs';
import { SKILL_RUN_MAX_MS, SKILL_TICK_CRON, SKILL_TICK_QUEUE } from '@agile/automation';
import { parseWorkerEnv } from '@agile/config';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import { SYNC_TICK_QUEUE, startSyncQueue } from '@agile/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from './log';
import {
  type RunningWorker,
  startWorker,
  WORKER_STOP_BACKSTOP_MS,
  WORKER_STOP_TIMEOUT_MS,
} from './worker';

describe('worker', () => {
  let tdb: TestDatabase;
  let worker: RunningWorker | undefined;
  const events: string[] = [];
  const lines: string[] = [];
  const log: Logger = (_level, event, fields) => {
    events.push(event);
    lines.push(JSON.stringify({ event, ...fields }));
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
  });
  afterAll(async () => {
    await worker?.stop();
    await tdb?.stop();
  });

  it('starts, schedules the sync and skill ticks, answers health checks and stops cleanly', async () => {
    const env = parseWorkerEnv({
      DATABASE_URL: tdb.appUrl,
      BETTER_AUTH_SECRET: 's'.repeat(32),
      BETTER_AUTH_URL: 'http://localhost:3000',
      ENCRYPTION_KEYS: `v1:${Buffer.alloc(32, 3).toString('base64')}`,
      SYNC_INTERVAL_MINUTES: '30',
    });
    worker = await startWorker({ ...env, WORKER_HEALTH_PORT: 0 }, log);
    expect(events).toContain('worker_started');

    const res = await fetch(`http://127.0.0.1:${worker.healthPort}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect((await fetch(`http://127.0.0.1:${worker.healthPort}/other`)).status).toBe(404);
    expect(
      (await fetch(`http://127.0.0.1:${worker.healthPort}/health`, { method: 'POST' })).status,
    ).toBe(405);

    const probe = await startSyncQueue(tdb.appUrl, { role: 'producer' });
    try {
      expect(
        (await probe.getSchedules())
          .map((s) => [s.name, s.cron])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      ).toEqual([
        [SYNC_TICK_QUEUE, '*/30 * * * *'],
        [SKILL_TICK_QUEUE, SKILL_TICK_CRON],
      ]);
    } finally {
      await probe.stop({ graceful: false });
    }

    // Logs never carry the connection string or keys.
    const all = lines.join('\n');
    expect(all).not.toContain(tdb.appUrl);
    expect(all).not.toContain('ENCRYPTION');

    const port = worker.healthPort;
    // Stopping aborts running syncs first (they end as `interrupted` and release their lease).
    const shutdownSignal = worker.signal;
    expect(shutdownSignal.aborted).toBe(false);
    await worker.stop();
    expect(shutdownSignal.aborted).toBe(true);
    worker = undefined;
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it('waits on stop longer than a run and its delivery, within the container grace period (M3)', () => {
    expect(WORKER_STOP_TIMEOUT_MS).toBeGreaterThanOrEqual(SKILL_RUN_MAX_MS + 10_000);
    expect(WORKER_STOP_BACKSTOP_MS).toBeGreaterThan(WORKER_STOP_TIMEOUT_MS);
    const compose = readFileSync(
      new URL('../../../docker-compose.selfhost.yml', import.meta.url),
      'utf8',
    );
    const worker = compose.slice(compose.indexOf('\n  worker:'));
    const grace = /stop_grace_period: (\d+)s/.exec(worker)?.[1];
    expect(Number(grace) * 1000).toBeGreaterThanOrEqual(WORKER_STOP_BACKSTOP_MS + 5_000);
  });

  it('reports 503 without details when the database is unreachable', async () => {
    const { startHealthServer } = await import('./health');
    const server = await startHealthServer(0, '127.0.0.1', async () => {
      throw new Error('postgres://user:secret@host/db');
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(res.status).toBe(503);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ status: 'unavailable' });
      expect(body).not.toContain('secret');
    } finally {
      await server.close();
    }
  });
});
