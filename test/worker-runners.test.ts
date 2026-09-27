import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DeferredError, TaskCancelledError } from '../src/errors.js';
import type { SyncApplicantsOptions } from '../src/linkedin/applicants.js';
import { defaultPacing, loadConfig } from '../src/config.js';
import type { ScrapeContext } from '../src/linkedin/context.js';
import { syncApplicantList } from '../src/linkedin/applicants.js';
import { silentLogger } from '../src/log.js';
import { Scheduler } from '../src/queue/scheduler.js';
import { BLANK_PAGE_RETRY_MS, Worker, type WorkerDeps } from '../src/queue/worker.js';
import { Db } from '../src/storage/db.js';
import type { PacingSettings } from '../src/types.js';

// The production sync_applicants runner with the LinkedIn crawl replaced by a stub; everything else is real.
vi.mock('../src/linkedin/applicants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/linkedin/applicants.js')>();
  return { ...actual, syncApplicantList: vi.fn() };
});

function makeDeps() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'li-runners-'));
  const cfg = loadConfig({ dataDir: tmp });
  const db = new Db(':memory:');
  const pacing: PacingSettings = { ...defaultPacing('normal'), workHoursStart: '00:00', workHoursEnd: '23:59', workDays: [0, 1, 2, 3, 4, 5, 6], warmupProbability: 0, breakEveryActions: [1000, 1000], rampStart: 0, rampPerDay: 0 };
  const scheduler = new Scheduler(db, () => pacing, () => new Date(new Date().setHours(12, 0, 0, 0)), () => 0);
  const fakeCtx = { page: {}, human: { delayMs: () => 1 }, capture: {}, assertHealthy: async () => {}, cfg, db, log: silentLogger } as unknown as ScrapeContext;
  const deps: WorkerDeps = { cfg, db, log: silentLogger, session: { isConnected: () => true } as never, scheduler, getPacing: () => pacing, ownerKind: 'cli', sleep: async () => {}, createContext: async () => fakeCtx };
  return { deps, db };
}

const progress = { jobId: 'j1', nextOffset: 1025, pagesVisited: 41, totalReported: 1005, stored: 955, complete: true, stoppedEarly: true, uiVariant: 'hiring_pro' as const };

describe('sync_applicants runner', () => {
  it('queues the table sweep while the list task is still running', async () => {
    const { deps, db } = makeDeps();
    vi.mocked(syncApplicantList).mockImplementationOnce(async (ctx) => {
      ctx.db.setSyncProgress(progress);
      return { jobId: 'j1', applicants: [], totalReported: 1005, pagesVisited: 1, complete: true, uiVariant: 'hiring_pro' };
    });
    const list = db.enqueueTask({ type: 'sync_applicants', jobId: 'j1', pagesPerRun: 12, includeNotAFit: false })!;
    expect(await new Worker(deps).runOnce()).toBe(true);
    expect(db.taskStatus(list)).toBe('done');
    const sweep = db.db.prepare("SELECT id, status, priority, payload FROM tasks WHERE id <> ? AND type = 'sync_applicants'").get(list) as { id: number; status: string; priority: number; payload: string } | undefined;
    expect(sweep).toBeDefined();
    expect(sweep!.status).toBe('pending');
    expect(JSON.parse(sweep!.payload)).toMatchObject({ jobId: 'j1', sweep: true, sort: 'DateApplied', startOffset: 0 });
    expect(db.recentEvents(10, 'list-sweep').length).toBe(1);
  });

  it('does not queue a second sweep when the sweep itself ends short', async () => {
    const { deps, db } = makeDeps();
    vi.mocked(syncApplicantList).mockImplementationOnce(async (ctx) => {
      ctx.db.setSyncProgress({ ...progress, sweeps: 1 });
      return { jobId: 'j1', applicants: [], totalReported: 1005, pagesVisited: 1, complete: true, uiVariant: 'hiring_pro' };
    });
    db.enqueueTask({ type: 'sync_applicants', jobId: 'j1', pagesPerRun: 12, sort: 'DateApplied', sweep: true, startOffset: 0 });
    expect(await new Worker(deps).runOnce()).toBe(true);
    expect(db.taskCounts().pending ?? 0).toBe(0);
  });

  it('makes every opened sweep row obey the application cap and queue_cancel', async () => {
    const { deps, db } = makeDeps();
    let hooks: SyncApplicantsOptions | undefined;
    vi.mocked(syncApplicantList).mockImplementationOnce(async (ctx, _jobId, opts) => {
      hooks = opts;
      ctx.db.setSyncProgress({ ...progress, sweeps: 1 });
      return { jobId: 'j1', applicants: [], totalReported: 1005, pagesVisited: 1, complete: true, uiVariant: 'hiring_pro' };
    });
    const id = db.enqueueTask({ type: 'sync_applicants', jobId: 'j1', pagesPerRun: 12, sort: 'DateApplied', sweep: true, startOffset: 0 })!;
    expect(await new Worker(deps).runOnce()).toBe(true);
    expect(hooks?.beforeRowOpen).toBeTypeOf('function');
    const beforeRow = async () => hooks!.beforeRowOpen!();
    // fresh day, cap not reached: rows may be opened, and each open counts as an application
    await expect(beforeRow()).resolves.toBeUndefined();
    deps.getPacing().dailyApplicantCap = 1;
    hooks!.afterRowOpen!();
    await expect(beforeRow()).rejects.toBeInstanceOf(DeferredError);
    // queue_cancel between two rows stops the sweep at once
    deps.getPacing().dailyApplicantCap = 100;
    db.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(id); // as queue_cancel does to a running task
    await expect(beforeRow()).rejects.toBeInstanceOf(TaskCancelledError);
  });

  it('waits a while before retrying a page that rendered nothing', async () => {
    const { deps, db } = makeDeps();
    vi.mocked(syncApplicantList).mockResolvedValueOnce({ jobId: 'j1', applicants: [], totalReported: 1005, pagesVisited: 1, complete: false, nextOffset: 500, blank: true, uiVariant: 'hiring_pro' });
    const id = db.enqueueTask({ type: 'sync_applicants', jobId: 'j1', pagesPerRun: 12 })!;
    const before = Date.now();
    expect(await new Worker(deps).runOnce()).toBe(true);
    const t = db.db.prepare('SELECT status, run_after, payload FROM tasks WHERE id = ?').get(id) as { status: string; run_after: string; payload: string };
    expect(t.status).toBe('pending');
    expect(Date.parse(t.run_after)).toBeGreaterThanOrEqual(before + BLANK_PAGE_RETRY_MS - 1000);
    expect(JSON.parse(t.payload).startOffset).toBe(500);
  });
});
