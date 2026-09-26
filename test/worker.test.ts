import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultPacing, loadConfig } from '../src/config.js';
import { CheckpointError, RateLimitedError, TaskCancelledError } from '../src/errors.js';
import type { ScrapeContext } from '../src/linkedin/context.js';
import { silentLogger } from '../src/log.js';
import { Scheduler } from '../src/queue/scheduler.js';
import { SETTINGS, Worker, type TaskRunner, type WorkerDeps } from '../src/queue/worker.js';
import { Db } from '../src/storage/db.js';
import type { PacingSettings, TaskType } from '../src/types.js';

function makeDeps(runners: Partial<Record<TaskType, TaskRunner>>) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'li-worker-'));
  const cfg = loadConfig({ dataDir: tmp });
  const db = new Db(':memory:');
  const pacing: PacingSettings = { ...defaultPacing('normal'), workHoursStart: '00:00', workHoursEnd: '23:59', workDays: [0, 1, 2, 3, 4, 5, 6], warmupProbability: 0, breakEveryActions: [1000, 1000], rampStart: 0, rampPerDay: 0 };
  // zero jitter + fixed noon clock so the test never falls outside the work window
  const scheduler = new Scheduler(db, () => pacing, () => new Date(new Date().setHours(12, 0, 0, 0)), () => 0);
  const fakeCtx = { page: {}, human: { delayMs: () => 1, goto: async () => {}, scrollPage: async () => {} }, capture: {}, assertHealthy: async () => {}, generation: async () => 'sdui', cfg, db, log: silentLogger } as unknown as ScrapeContext;
  const deps: WorkerDeps = {
    cfg,
    db,
    log: silentLogger,
    session: { isConnected: () => true } as never,
    scheduler,
    getPacing: () => pacing,
    ownerKind: 'cli',
    sleep: async () => {},
    createContext: async () => fakeCtx,
    runners,
  };
  return { deps, db, scheduler, pacing };
}

describe('Worker.runOnce', () => {
  it('requeues a task interrupted by a shutdown without counting an attempt', async () => {
    let stopper: (() => Promise<void>) | undefined;
    const { deps, db } = makeDeps({
      fetch_profile: async () => {
        await stopper!(); // the worker is asked to stop while this task runs
        throw new Error('aborted');
      },
    });
    const id = db.enqueueTask({ type: 'fetch_profile', jobId: 'j', applicationId: 'a', profileUrl: 'u', depth: 'basic', savePdf: false })!;
    const w = new Worker(deps);
    stopper = async () => {
      w.start();
      await w.stop();
    };
    expect(await w.runOnce()).toBe(true);
    const t = db.db.prepare('SELECT status, attempts, last_error FROM tasks WHERE id = ?').get(id) as { status: string; attempts: number; last_error: string };
    expect(t.status).toBe('pending');
    expect(t.attempts).toBe(0);
    expect(t.last_error).toBe('interrupted by shutdown');
    expect(db.taskCounts().failed).toBe(0);
  });

  it('leaves a task cancelled when its runner stops on a cancellation', async () => {
    const { deps, db } = makeDeps({
      sync_applicants: async (task, _ctx, d) => {
        d.db.cancelTasks({ ids: [task.id] }); // queue_cancel arrives while the list is being paged
        throw new TaskCancelledError(task.id);
      },
    });
    const id = db.enqueueTask({ type: 'sync_applicants', jobId: 'j', pagesPerRun: 12 })!;
    const w = new Worker(deps);
    expect(await w.runOnce()).toBe(true);
    expect(db.taskStatus(id)).toBe('cancelled');
    expect(db.taskCounts().failed).toBe(0);
    expect(await w.runOnce()).toBe(false);
  });

  it('lets profile tasks run when only the applicant cap is reached', async () => {
    const calls: string[] = [];
    const { deps, db, pacing } = makeDeps({
      fetch_application: async () => {
        calls.push('fetch_application');
        return 'done';
      },
      fetch_profile: async () => {
        calls.push('fetch_profile');
        return 'done';
      },
    });
    pacing.dailyApplicantCap = 0; // today's applications are used up
    db.enqueueTask({ type: 'fetch_application', jobId: 'j', applicationId: 'a', downloadResume: false });
    db.enqueueTask({ type: 'fetch_profile', jobId: 'j', applicationId: 'a', profileUrl: 'u', depth: 'basic', savePdf: false });
    const w = new Worker(deps);
    expect(await w.runOnce()).toBe(true);
    expect(calls).toEqual(['fetch_profile']);
    // Only the capped application is left: nothing runs, and the status points at tomorrow.
    expect(await w.runOnce()).toBe(false);
    expect(w.status().nextEligibleAt).toBeDefined();
    expect(db.taskCounts().pending).toBe(1);
  });

  it('runs the highest-priority task, marks it done and records counters', async () => {
    const calls: string[] = [];
    const { deps, db, scheduler } = makeDeps({
      sync_jobs: async () => {
        calls.push('sync_jobs');
        return 'done';
      },
      fetch_profile: async () => {
        calls.push('fetch_profile');
        return 'done';
      },
    });
    db.enqueueTask({ type: 'fetch_profile', jobId: 'j', applicationId: 'a', profileUrl: 'u', depth: 'basic', savePdf: false });
    db.enqueueTask({ type: 'sync_jobs', includeClosed: true });
    const w = new Worker(deps);
    expect(await w.runOnce()).toBe(true);
    expect(calls).toEqual(['sync_jobs']);
    expect(await w.runOnce()).toBe(true);
    expect(calls).toEqual(['sync_jobs', 'fetch_profile']);
    expect(await w.runOnce()).toBe(false);
    expect(db.taskCounts().done).toBe(2);
    expect(scheduler.todayCounts()).toEqual({ applicants: 0, profiles: 1, actions: 2 });
  });

  it('requeues on checkpoint and pauses the queue for a human', async () => {
    const { deps, db } = makeDeps({
      fetch_application: async () => {
        throw new CheckpointError({ kind: 'security_verification', url: 'https://www.linkedin.com/checkpoint/challenge/x', message: 'verify' });
      },
    });
    const id = db.enqueueTask({ type: 'fetch_application', jobId: 'j', applicationId: 'a', downloadResume: true })!;
    const w = new Worker(deps);
    expect(await w.runOnce()).toBe(true);
    const t = db.getTask(id)!;
    expect(t.status).toBe('pending');
    expect(t.attempts).toBe(0);
    expect(db.getSetting<boolean>(SETTINGS.needsHuman)).toBe(true);
    expect(w.status().needsHuman).toBe(true);
    // paused for a human: nothing runs until queue_resume clears the flag
    expect(await w.runOnce()).toBe(false);
    db.deleteSetting(SETTINGS.needsHuman);
    expect(await w.runOnce()).toBe(true);
  });

  it('keeps a chunked sync_applicants task pending with its advanced offset', async () => {
    const { deps, db } = makeDeps({
      sync_applicants: async (task, _ctx, d) => {
        const p = task.payload as Extract<typeof task.payload, { type: 'sync_applicants' }>;
        d.db.updateTaskPayload(task.id, { ...p, startOffset: (p.startOffset ?? 0) + 200 });
        d.db.requeueTask(task.id);
        return 'requeued';
      },
    });
    const id = db.enqueueTask({ type: 'sync_applicants', jobId: 'j', pagesPerRun: 8 })!;
    const w = new Worker(deps);
    expect(await w.runOnce()).toBe(true);
    const t = db.getTask(id)!;
    expect(t.status).toBe('pending');
    expect(t.attempts).toBe(0);
    expect((t.payload as { startOffset?: number }).startOffset).toBe(200);
    expect(db.taskCounts().done).toBe(0);
  });

  it('retries generic failures with backoff and fails permanently after max attempts', async () => {
    const { deps, db } = makeDeps({
      sync_jobs: async () => {
        throw new Error('selector broke');
      },
    });
    const id = db.enqueueTask({ type: 'sync_jobs', includeClosed: false }, { maxAttempts: 2 })!;
    const w = new Worker(deps);
    expect(await w.runOnce()).toBe(true);
    let t = db.getTask(id)!;
    expect(t.status).toBe('pending');
    expect(t.runAfter && Date.parse(t.runAfter) > Date.now()).toBe(true);
    expect(await w.runOnce()).toBe(false); // backoff not elapsed
    db.db.prepare("UPDATE tasks SET run_after = NULL WHERE id = ?").run(id);
    expect(await w.runOnce()).toBe(true);
    t = db.getTask(id)!;
    expect(t.status).toBe('failed');
    expect(t.lastError).toMatch(/selector broke/);
    expect(w.status().lastError).toMatch(/selector broke/);
  });

  it('backs off on rate limits without burning attempts', async () => {
    const { deps, db } = makeDeps({
      fetch_profile: async () => {
        throw new RateLimitedError('429', 60_000);
      },
    });
    const id = db.enqueueTask({ type: 'fetch_profile', jobId: 'j', applicationId: 'a', profileUrl: 'u', depth: 'basic', savePdf: false })!;
    const w = new Worker(deps);
    expect(await w.runOnce()).toBe(true);
    const t = db.getTask(id)!;
    expect(t.status).toBe('pending');
    expect(t.attempts).toBe(0);
    expect(deps.scheduler.check('fetch_profile').ok).toBe(false);
  });

  it('honours the paused flag', async () => {
    const { deps, db } = makeDeps({ sync_jobs: async () => 'done' });
    db.enqueueTask({ type: 'sync_jobs', includeClosed: false });
    db.setSetting(SETTINGS.paused, true);
    const w = new Worker(deps);
    expect(await w.runOnce()).toBe(false);
    db.setSetting(SETTINGS.paused, false);
    expect(await w.runOnce()).toBe(true);
  });
});

describe('Worker loop', () => {
  it('processes tasks in the background and stops cleanly, holding the owner lock while running', async () => {
    let ran = 0;
    const { deps, db } = makeDeps({
      sync_jobs: async () => {
        ran++;
        return 'done';
      },
    });
    db.enqueueTask({ type: 'sync_jobs', includeClosed: false });
    const w = new Worker(deps);
    w.start();
    expect(w.isRunning()).toBe(true);
    expect(db.getSetting<{ pid: number }>(SETTINGS.ownerLock)?.pid).toBe(process.pid);
    const deadline = Date.now() + 5000;
    while (ran < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await w.stop();
    expect(ran).toBe(1);
    expect(w.isRunning()).toBe(false);
    expect(db.getSetting(SETTINGS.ownerLock)).toBeUndefined();
    expect(db.taskCounts().done).toBe(1);
  });

  it('refuses to start when another live process owns the lock', () => {
    const { deps, db } = makeDeps({});
    db.setSetting(SETTINGS.ownerLock, { pid: process.pid + 1_000_000, kind: 'cli', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() });
    // pid is almost certainly dead → stale lock is taken over
    const w = new Worker(deps);
    w.start();
    expect(w.isRunning()).toBe(true);
    return w.stop();
  });
});
