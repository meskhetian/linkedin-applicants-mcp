import path from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../storage/db.js';
import type { BrowserSession } from '../browser/session.js';
import type { ScheduleDecision, Scheduler } from './scheduler.js';
import type { Logger, PacingSettings, Task, TaskPayload, TaskType, WorkerStatus } from '../types.js';
import { createScrapeContext, type ScrapeContext } from '../linkedin/context.js';
import { syncPostedJobs } from '../linkedin/jobs.js';
import { nextSweepSort, syncApplicantList } from '../linkedin/applicants.js';
import { fetchApplicationDetail } from '../linkedin/application.js';
import { BROWSER_LOST_RE, shouldSkipResumeDownload } from './resume-policy.js';
import { fetchProfile, profileToText } from '../linkedin/profile.js';
import { URLS } from '../linkedin/urls.js';
import { applicantDir, writeJson } from '../storage/files.js';
import { extractResumeText } from '../storage/extract.js';
import { randInt, sleep as realSleep } from '../browser/humanize.js';
import { BrowserNotConnectedError, CheckpointError, DeferredError, NotLoggedInError, RateLimitedError, TaskCancelledError, errorMessage, isRetryable } from '../errors.js';

const TASK_TYPES: TaskType[] = ['sync_jobs', 'sync_applicants', 'fetch_application', 'fetch_profile'];

/** Executes one task type against a live ScrapeContext. 'requeued' means the runner already re-scheduled the task. */
export type TaskRunner = (task: Task, ctx: ScrapeContext, deps: WorkerDeps) => Promise<'done' | 'requeued'>;

export interface WorkerDeps {
  cfg: Config;
  db: Db;
  log: Logger;
  session: BrowserSession;
  scheduler: Scheduler;
  getPacing: () => PacingSettings;
  ownerKind: 'mcp' | 'cli';
  /** Override runners (tests inject fakes; production uses defaultRunners()). */
  runners?: Partial<Record<TaskType, TaskRunner>>;
  /** Override the ScrapeContext factory (tests pass a fake page). */
  createContext?: (deps: WorkerDeps) => Promise<ScrapeContext>;
  /** Sleep function (tests make it instant). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Settings keys shared between MCP server and standalone worker (control plane lives in SQLite). */
export const SETTINGS = {
  pacing: 'pacing',
  /** Full effective pacing as computed by the MCP server (env defaults + overrides), for read-only consumers */
  pacingEffective: 'pacing.effective',
  paused: 'queue.paused',
  needsHuman: 'queue.needs_human',
  needsHumanReason: 'queue.needs_human_reason',
  ownerLock: 'queue.owner',
  lastError: 'queue.last_error',
  currentTask: 'queue.current_task',
} as const;

interface OwnerLock {
  pid: number;
  kind: 'mcp' | 'cli';
  startedAt: string;
  heartbeatAt: string;
}

const LOCK_STALE_MS = 120_000;

type PayloadOf<T extends TaskType> = Extract<TaskPayload, { type: T }>;

/** Production runners wrapping the linkedin/* modules. */
export function defaultRunners(): Record<TaskType, TaskRunner> {
  return {
    sync_jobs: async (task, ctx) => {
      const p = task.payload as PayloadOf<'sync_jobs'>;
      await syncPostedJobs(ctx, { includeClosed: p.includeClosed });
      return 'done';
    },

    sync_applicants: async (task, ctx, deps) => {
      const p = task.payload as PayloadOf<'sync_applicants'>;
      const r = await syncApplicantList(ctx, p.jobId, {
        startOffset: p.startOffset,
        maxPages: p.pagesPerRun ?? 12,
        includeNotAFit: p.includeNotAFit,
        sort: p.sort,
        sweep: p.sweep,
        // queue_cancel while a list is being paged: stop after the current page instead of finishing the chunk.
        onPage: () => {
          if (deps.db.taskStatus(task.id) === 'cancelled') throw new TaskCancelledError(task.id);
        },
      });
      if (!r.complete && r.nextOffset !== undefined) {
        // Chunk finished: advance the offset and let the scheduler (hours / caps / breaks) run before the next chunk.
        deps.db.updateTaskPayload(task.id, { ...p, startOffset: r.nextOffset });
        deps.db.requeueTask(task.id);
        return 'requeued';
      }
      const progress = deps.db.getSyncProgress(p.jobId);
      const sweepSort = nextSweepSort(progress, !!p.sweep);
      if (sweepSort && progress) {
        deps.db.enqueueTask({ type: 'sync_applicants', jobId: p.jobId, pagesPerRun: p.pagesPerRun, includeNotAFit: p.includeNotAFit, sort: sweepSort, sweep: true, startOffset: 0 }, { priority: task.priority });
        deps.db.addEvent('info', 'list-sweep', `List of job ${p.jobId} ended at ${progress.stored} of ${progress.totalReported}; a second pass in ${sweepSort} order is queued to pick up applicants LinkedIn's paging skipped.`, { jobId: p.jobId, sort: sweepSort });
        deps.log.info('list ended short of the reported total; sweep queued', { jobId: p.jobId, stored: progress.stored, totalReported: progress.totalReported, sort: sweepSort });
      }
      return 'done';
    },

    fetch_application: async (task, ctx, deps) => {
      const p = task.payload as PayloadOf<'fetch_application'>;
      const existing = deps.db.getApplicant(p.applicationId);
      const dir = applicantDir(deps.cfg, p.jobId, p.applicationId, existing?.fullName);
      const skipResume = shouldSkipResumeDownload(task, p.downloadResume);
      if (skipResume) {
        deps.log.warn('the browser was lost during the previous attempt of this application; fetching details without the resume this time', { applicationId: p.applicationId, lastError: task.lastError });
        deps.db.addEvent('warn', 'resume-skipped', `Resume download skipped for application ${p.applicationId} after Chrome closed during the previous attempt; run applicants_fetch_details later to retry it.`, { taskId: task.id });
      }
      const r = await fetchApplicationDetail(ctx, p.jobId, p.applicationId, { downloadResume: p.downloadResume && !skipResume, saveDir: dir });
      const resumeText = r.resumePath ? await extractResumeText(r.resumePath) : undefined;
      if (!existing) {
        deps.db.upsertApplicantFromList({ applicationId: p.applicationId, jobId: p.jobId, fullName: r.fullName ?? `Applicant ${p.applicationId}`, listSyncedAt: new Date().toISOString() });
      }
      deps.db.updateApplicantDetail(p.applicationId, {
        fullName: r.fullName,
        headline: r.headline,
        location: r.location,
        profileUrl: r.profileUrl,
        profileUrn: r.profileUrn,
        appliedAt: r.appliedAt,
        rating: r.rating,
        email: r.email,
        phone: r.phone,
        screeningAnswers: r.screeningAnswers,
        hasResume: r.hasResume,
        resumePath: r.resumePath,
        resumeFileName: r.resumeFileName,
        resumeText: resumeText || undefined,
        raw: skipResume ? { ...r.extra, resumeSkipped: 'browser closed during the previous attempt' } : r.extra,
      });
      if (r.resumePath && !resumeText) deps.log.warn('resume saved but no text could be extracted (scanned PDF?)', { applicationId: p.applicationId, path: r.resumePath });
      const profileUrl = r.profileUrl ?? existing?.profileUrl;
      if (p.thenProfile && profileUrl) {
        deps.db.enqueueTask({ type: 'fetch_profile', jobId: p.jobId, applicationId: p.applicationId, profileUrl, depth: p.thenProfile.depth, savePdf: p.thenProfile.savePdf });
      } else if (p.thenProfile) {
        deps.log.warn('no profile URL found for applicant; profile not queued', { applicationId: p.applicationId });
      }
      return 'done';
    },

    fetch_profile: async (task, ctx, deps) => {
      const p = task.payload as PayloadOf<'fetch_profile'>;
      const existing = deps.db.getApplicant(p.applicationId);
      const dir = applicantDir(deps.cfg, p.jobId, p.applicationId, existing?.fullName);
      const month = new Date().toISOString().slice(0, 7);
      let savePdf = p.savePdf;
      if (savePdf && deps.db.getCounter('save_pdf', month) >= deps.getPacing().savePdfMonthlyCap) {
        savePdf = false;
        deps.log.warn('monthly Save-to-PDF cap reached; skipping PDF for this profile', { month });
      }
      const profile = await fetchProfile(ctx, p.profileUrl, { depth: p.depth, strategy: deps.cfg.profileStrategy, savePdf, saveDir: dir });
      const profilePath = writeJson(path.join(dir, 'profile.json'), profile);
      deps.db.updateApplicantProfile(p.applicationId, profilePath, profile, profileToText(profile));
      if (profile.savedPdfPath) deps.db.incrementCounter('save_pdf', month);
      return 'done';
    },
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check only
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Single-threaded background loop: claim next task → scheduler.check → run with human pacing → persist →
 * pause between tasks. Pauses itself on checkpoints (needs_human), honours the paused flag, survives
 * restarts (tasks live in SQLite) and holds an owner lock so only one process drives the browser.
 */
export class Worker {
  private running = false;
  private stopping = false;
  private loop: Promise<void> | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private abort: AbortController | undefined;
  private current: Task | undefined;
  private consecutiveFailures = 0;
  private nextEligibleAt: Date | undefined;
  private lastError: string | undefined;
  private startedAt: string | undefined;
  private lastDeferReason: string | undefined;
  private readonly runners: Record<TaskType, TaskRunner>;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(protected readonly deps: WorkerDeps) {
    this.runners = { ...defaultRunners(), ...(deps.runners ?? {}) };
    this.sleepFn = deps.sleep ?? realSleep;
  }

  /** Start the loop (returns immediately). No-op if already running or if another live process owns the queue. */
  start(): void {
    if (this.running) return;
    const lock = this.otherLiveOwner();
    if (lock) {
      this.deps.log.warn('another worker process owns the queue; not starting', { pid: lock.pid, kind: lock.kind });
      return;
    }
    this.running = true;
    this.stopping = false;
    this.startedAt = new Date().toISOString();
    this.abort = new AbortController();
    this.touchLock();
    this.heartbeat = setInterval(() => this.touchLock(), 30_000);
    this.heartbeat.unref?.();
    this.loop = this.run()
      .catch((e) => this.deps.log.error('worker loop crashed', { error: errorMessage(e) }))
      .finally(() => {
        this.running = false;
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.releaseLock();
      });
  }

  /** Stop after the current task finishes (sleeps are interrupted immediately). */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.abort?.abort();
    await this.loop;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Run at most one eligible task now. Returns false if nothing ran. */
  async runOnce(): Promise<boolean> {
    if (this.isPaused()) return false;
    const { task, deferral } = this.pickTask();
    if (!task) {
      if (deferral) this.nextEligibleAt = deferral.resumeAt;
      return false;
    }
    await this.execute(task);
    return true;
  }

  status(): WorkerStatus {
    const base = readWorkerStatus(this.deps.db, this.deps.scheduler);
    return {
      ...base,
      running: this.running,
      currentTask: this.current ? { id: this.current.id, type: this.current.type, jobId: this.current.jobId, applicationId: this.current.applicationId, startedAt: this.current.startedAt } : base.currentTask,
      nextEligibleAt: this.nextEligibleAt?.toISOString() ?? base.nextEligibleAt,
      lastError: this.lastError ?? base.lastError,
      startedAt: this.startedAt ?? base.startedAt,
      ownerPid: this.running ? process.pid : base.ownerPid,
      ownerKind: this.running ? this.deps.ownerKind : base.ownerKind,
    };
  }

  // ---------------- internals ----------------

  /** Another live process currently drives the queue (and therefore the Chrome profile), if any. */
  externalOwner(): OwnerLock | undefined {
    return this.otherLiveOwner();
  }

  private otherLiveOwner(): OwnerLock | undefined {
    const lock = this.deps.db.getSetting<OwnerLock>(SETTINGS.ownerLock);
    if (!lock || lock.pid === process.pid) return undefined;
    const fresh = Date.now() - Date.parse(lock.heartbeatAt) < LOCK_STALE_MS;
    return fresh && pidAlive(lock.pid) ? lock : undefined;
  }

  private touchLock(): void {
    const now = new Date().toISOString();
    this.deps.db.setSetting(SETTINGS.ownerLock, { pid: process.pid, kind: this.deps.ownerKind, startedAt: this.startedAt ?? now, heartbeatAt: now } satisfies OwnerLock);
  }

  private releaseLock(): void {
    const lock = this.deps.db.getSetting<OwnerLock>(SETTINGS.ownerLock);
    if (lock?.pid === process.pid) this.deps.db.deleteSetting(SETTINGS.ownerLock);
  }

  private isPaused(): boolean {
    return !!this.deps.db.getSetting<boolean>(SETTINGS.paused) || !!this.deps.db.getSetting<boolean>(SETTINGS.needsHuman);
  }

  private async idle(minMs: number, maxMs = minMs): Promise<void> {
    if (this.stopping) return;
    try {
      await this.sleepFn(randInt(Math.round(minMs), Math.round(Math.max(minMs, maxMs))), this.abort?.signal);
    } catch {
      /* aborted */
    }
    // Always yield a macrotask so an instant sleep (tests) can never starve the event loop.
    await new Promise<void>((r) => setImmediate(r));
  }

  private async run(): Promise<void> {
    const { db, log, scheduler } = this.deps;
    log.info('worker started', { ownerKind: this.deps.ownerKind, pid: process.pid });
    while (!this.stopping) {
      try {
        if (this.isPaused()) {
          await this.idle(5_000, 15_000);
          continue;
        }
        const { task, deferral } = this.pickTask();
        if (!task) {
          if (!deferral) {
            await this.idle(15_000, 45_000);
            continue;
          }
          this.nextEligibleAt = deferral.resumeAt;
          if (this.lastDeferReason !== deferral.reason) {
            this.lastDeferReason = deferral.reason;
            db.addEvent('info', 'deferred', deferral.reason, { resumeAt: deferral.resumeAt.toISOString() });
            log.info('deferred by scheduler', { reason: deferral.reason, resumeAt: deferral.resumeAt.toISOString() });
          }
          const wait = Math.min(Math.max(deferral.resumeAt.getTime() - Date.now(), 5_000), 300_000);
          await this.idle(wait);
          continue;
        }
        this.lastDeferReason = undefined;
        this.nextEligibleAt = undefined;
        await this.execute(task);
      } catch (e) {
        log.error('worker iteration error', { error: errorMessage(e) });
        await this.idle(5_000, 15_000);
      }
    }
    log.info('worker stopped');
  }

  /**
   * Highest-priority runnable task. A task type that hit its daily cap only blocks itself: the other types keep
   * going (applications capped for today must not starve the profile queue). Global blocks (break, working hours,
   * hourly cap) stop the search. Returns the earliest deferral when nothing can run.
   */
  private pickTask(): { task?: Task; deferral?: Extract<ScheduleDecision, { ok: false }> } {
    const { db, scheduler } = this.deps;
    const randomize = this.deps.getPacing().randomizeOrder;
    const blocked: TaskType[] = [];
    let deferral: Extract<ScheduleDecision, { ok: false }> | undefined;
    for (;;) {
      const allowed = blocked.length ? TASK_TYPES.filter((t) => !blocked.includes(t)) : undefined;
      if (allowed && !allowed.length) break;
      const task = db.nextTask(randomize, allowed);
      if (!task) break;
      const decision = scheduler.check(task.type);
      if (decision.ok) return { task, deferral };
      if (!deferral || decision.resumeAt < deferral.resumeAt) deferral = decision;
      if (decision.scope !== 'type') break;
      blocked.push(task.type);
    }
    return { deferral };
  }

  private async execute(task: Task): Promise<void> {
    const { db, log, scheduler, session, cfg } = this.deps;
    db.markTaskRunning(task.id);
    this.current = task;
    db.setSetting(SETTINGS.currentTask, { id: task.id, type: task.type, jobId: task.jobId, applicationId: task.applicationId, startedAt: new Date().toISOString() });
    const tlog = log.child({ taskId: task.id, type: task.type, jobId: task.jobId, applicationId: task.applicationId });
    let ctx: ScrapeContext | undefined;
    try {
      ctx = this.deps.createContext ? await this.deps.createContext(this.deps) : createScrapeContext(session, { cfg, db, log: tlog }, await session.ensure());
      const result = await this.runners[task.type](task, ctx, this.deps);
      if (result === 'done') db.markTaskDone(task.id);
      const { breakMs } = scheduler.recordAction(task.type);
      this.consecutiveFailures = 0;
      this.lastError = undefined;
      db.addEvent('info', 'task', `${task.type} ${result}`, { id: task.id, jobId: task.jobId, applicationId: task.applicationId });
      tlog.info('task finished', { result });
      if (breakMs) {
        db.addEvent('info', 'break', `taking a ${Math.round(breakMs / 60_000)} min break`, { ms: breakMs });
        tlog.info('taking a break', { minutes: Math.round(breakMs / 60_000) });
        await this.idle(breakMs);
      } else {
        await this.pauseBetween(task.type, ctx);
      }
      if (!this.stopping && Math.random() < this.deps.getPacing().warmupProbability) await this.warmup(ctx);
    } catch (e) {
      await this.handleError(task, e, tlog);
    } finally {
      this.current = undefined;
      db.deleteSetting(SETTINGS.currentTask);
    }
  }

  private async pauseBetween(type: TaskType, ctx: ScrapeContext): Promise<void> {
    const kind = type === 'fetch_profile' ? 'betweenProfiles' : type === 'fetch_application' ? 'betweenApplicants' : 'betweenPages';
    const ms = ctx.human.delayMs(kind);
    this.deps.log.debug('pause between tasks', { kind, ms });
    await this.idle(ms);
  }

  /** Occasionally look at the feed between tasks, like a person would. */
  private async warmup(ctx: ScrapeContext): Promise<void> {
    try {
      await ctx.human.goto(ctx.page, URLS.feed);
      await ctx.assertHealthy();
      await this.idle(ctx.human.delayMs('read'));
      await ctx.human.scrollPage(ctx.page, { maxScrolls: randInt(2, 4) });
    } catch (e) {
      this.deps.log.debug('warmup skipped', { error: errorMessage(e) });
    }
  }

  private async handleError(task: Task, e: unknown, tlog: Logger): Promise<void> {
    const { db, scheduler } = this.deps;
    if (e instanceof TaskCancelledError) {
      db.addEvent('info', 'cancelled', `${task.type} stopped: cancelled while running`, { taskId: task.id, jobId: task.jobId });
      tlog.info('task cancelled while running; stopped after the current page');
      return;
    }
    const raw = errorMessage(e);
    // Only when Chrome itself is gone (crash, killed, closed by hand) does the retry policy skip the resume; a closed
    // tab produces the same Playwright text but leaves the session connected.
    const msg = !this.deps.session.isConnected() && BROWSER_LOST_RE.test(raw) ? `Browser lost: ${raw}` : raw;
    this.lastError = msg;
    db.setSetting(SETTINGS.lastError, msg);

    if (e instanceof CheckpointError || e instanceof NotLoggedInError) {
      db.requeueTask(task.id, undefined, msg);
      db.setSetting(SETTINGS.needsHuman, true);
      db.setSetting(SETTINGS.needsHumanReason, msg);
      db.addEvent('warn', 'checkpoint', msg, { taskId: task.id, url: e instanceof CheckpointError ? e.info.url : undefined });
      tlog.warn('LinkedIn wants a human, queue paused until browser_open_login / queue_resume', { error: msg });
      return;
    }
    if (e instanceof BrowserNotConnectedError) {
      db.requeueTask(task.id, new Date(Date.now() + 10 * 60_000).toISOString(), `Browser lost: ${raw}`);
      db.addEvent('error', 'browser', msg, { taskId: task.id });
      tlog.error('browser unavailable; retrying in 10 minutes', { error: msg });
      await this.idle(60_000, 120_000);
      return;
    }
    if (e instanceof RateLimitedError) {
      const ms = e.retryAfterMs ?? 2 * 3_600_000;
      db.requeueTask(task.id, new Date(Date.now() + ms).toISOString(), msg);
      scheduler.takeBreak(ms);
      db.addEvent('warn', 'rate-limit', msg, { taskId: task.id, pauseMs: ms });
      tlog.warn('rate limited; backing off', { minutes: Math.round(ms / 60_000) });
      return;
    }
    if (e instanceof DeferredError) {
      db.requeueTask(task.id, e.resumeAt.toISOString(), e.reason);
      return;
    }

    this.consecutiveFailures++;
    const status = db.markTaskFailed(task.id, msg, { retry: isRetryable(e), backoffMs: 5 * 60_000 * Math.max(1, task.attempts + 1) });
    db.addEvent('error', 'task-failed', msg, { taskId: task.id, type: task.type, status });
    tlog.error('task failed', { status, error: msg });
    if (this.consecutiveFailures >= 3) {
      const ms = randInt(20, 40) * 60_000;
      db.addEvent('warn', 'cooldown', `${this.consecutiveFailures} consecutive failures, cooling down (LinkedIn markup may have changed; try debug_snapshot)`, { pauseMs: ms });
      scheduler.takeBreak(ms);
      this.consecutiveFailures = 0;
    }
  }
}

/** Read-only status usable from a process that does not own the worker (reads settings/counters). */
export function readWorkerStatus(db: Db, scheduler: Scheduler): WorkerStatus {
  const lock = db.getSetting<OwnerLock>(SETTINGS.ownerLock);
  const lockAlive = !!lock && Date.now() - Date.parse(lock.heartbeatAt) < LOCK_STALE_MS && pidAlive(lock.pid);
  const current = db.getSetting<WorkerStatus['currentTask']>(SETTINGS.currentTask);
  return {
    running: lockAlive,
    paused: !!db.getSetting<boolean>(SETTINGS.paused),
    needsHuman: !!db.getSetting<boolean>(SETTINGS.needsHuman),
    needsHumanReason: db.getSetting<string>(SETTINGS.needsHumanReason),
    currentTask: lockAlive ? current : undefined,
    todayCounts: scheduler.todayCounts(),
    hourCount: scheduler.hourCount(),
    lastError: db.getSetting<string>(SETTINGS.lastError),
    ownerPid: lockAlive ? lock?.pid : undefined,
    ownerKind: lockAlive ? lock?.kind : undefined,
    startedAt: lockAlive ? lock?.startedAt : undefined,
  };
}
