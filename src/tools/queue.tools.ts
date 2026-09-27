import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import type { PacingSettings } from '../types.js';
import { SETTINGS } from '../queue/worker.js';
import { fail, guard, ok } from './result.js';

const TASK_TYPE = z.enum(['sync_jobs', 'sync_applicants', 'fetch_application', 'fetch_profile']);
const TASK_STATUS = z.enum(['pending', 'running', 'done', 'failed', 'cancelled']);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function registerQueueTools(server: McpServer, deps: Deps): void {
  const { db, worker, scheduler, session } = deps;

  server.registerTool(
    'queue_status',
    {
      title: 'Queue and worker status',
      description:
        'Everything about the background work: worker state (running / paused / needsHuman), task counts by type and status, today\'s counters vs effective daily caps, whether we are inside the working-hours window and when the next window starts, per-job applicant-list sync progress, browser status and recent events. Poll this to follow long exports.',
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    guard(async () => {
      const pacing = deps.getPacing();
      const jobs = db.listJobs('all');
      return ok({
        worker: worker.status(),
        tasks: db.taskCounts(),
        pendingByType: db.pendingByType(),
        effectiveDailyCaps: scheduler.effectiveCaps(),
        effectiveHourlyCap: scheduler.effectiveHourlyCap(),
        inWorkWindow: scheduler.inWorkWindow(),
        nextWindowStart: scheduler.inWorkWindow() ? undefined : scheduler.nextWindowStart().toISOString(),
        pacing: { speed: pacing.speed, workHours: `${pacing.workHoursStart}-${pacing.workHoursEnd}`, workDays: pacing.workDays, timezone: pacing.timezone ?? 'system', rampDay: scheduler.daysSinceFirstAction() },
        browser: await session.status(),
        syncProgress: jobs.map((j) => db.getSyncProgress(j.jobId)).filter(Boolean),
        recentEvents: db.recentEvents(10),
      });
    }),
  );

  server.registerTool(
    'queue_start',
    { title: 'Start the worker', description: 'Start (or resume) the background worker in this process. It only acts when tasks are pending and the scheduler allows it. No-op if another process (npm run worker) owns the queue.', annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true } },
    guard(async () => {
      db.setSetting(SETTINGS.paused, false);
      worker.start();
      return ok({ ...worker.status() });
    }),
  );

  server.registerTool(
    'queue_pause',
    { title: 'Pause the queue', description: 'Pause processing after the current task finishes. Tasks stay queued. Resume with queue_resume.', annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: true } },
    guard(async () => {
      db.setSetting(SETTINGS.paused, true);
      db.addEvent('info', 'control', 'queue paused by user');
      return ok({ ...worker.status(), paused: true });
    }),
  );

  server.registerTool(
    'queue_resume',
    {
      title: 'Resume the queue',
      description: 'Clear the paused flag and, by default, the needsHuman flag set after a LinkedIn checkpoint or login wall (call after you solved it in the Chrome window), then start the worker.',
      inputSchema: { clearNeedsHuman: z.boolean().default(true) },
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
    },
    guard(async ({ clearNeedsHuman }) => {
      db.setSetting(SETTINGS.paused, false);
      if (clearNeedsHuman) {
        db.deleteSetting(SETTINGS.needsHuman);
        db.deleteSetting(SETTINGS.needsHumanReason);
        scheduler.clearBreak();
      }
      db.addEvent('info', 'control', 'queue resumed by user', { clearNeedsHuman });
      worker.start();
      return ok({ ...worker.status() });
    }),
  );

  server.registerTool(
    'queue_cancel',
    {
      title: 'Cancel queued tasks',
      description:
        'Cancel tasks matching the filters (type / jobId / applicationId); without filters every queued task. Pending tasks leave the queue. A running list sync or sweep stops after its current page; a running application or profile fetch finishes the page it is on, stays cancelled and queues nothing further. Done work is untouched.',
      inputSchema: { type: TASK_TYPE.optional(), jobId: z.string().optional(), applicationId: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    guard(async ({ type, jobId, applicationId }) => {
      const cancelled = db.cancelTasks({ type, jobId, applicationId });
      db.addEvent('info', 'control', `cancelled ${cancelled} tasks`, { type, jobId, applicationId });
      return ok({ cancelled, tasks: db.taskCounts() });
    }),
  );

  server.registerTool(
    'queue_retry_failed',
    {
      title: 'Retry failed tasks',
      description: 'Put failed tasks back into the queue with a fresh attempt budget (optionally filtered by type / jobId). Useful after fixing a login problem or when LinkedIn had a bad day.',
      inputSchema: { type: TASK_TYPE.optional(), jobId: z.string().optional() },
      annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: true },
    },
    guard(async ({ type, jobId }) => {
      const retried = db.retryFailedTasks({ type, jobId });
      worker.start();
      return ok({ retried, tasks: db.taskCounts() });
    }),
  );

  server.registerTool(
    'queue_tasks',
    {
      title: 'List tasks',
      description: 'Recent tasks with status, attempts and last error (filter by type / status / jobId). Use to see why something failed.',
      inputSchema: { type: TASK_TYPE.optional(), status: TASK_STATUS.optional(), jobId: z.string().optional(), limit: z.number().int().min(1).max(500).default(50) },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    guard(async ({ type, status, jobId, limit }) => ok({ tasks: db.listTasks({ type, status, jobId, limit }) })),
  );

  server.registerTool(
    'pacing_get',
    { title: 'Get pacing settings', description: 'Current human-pacing settings: speed, working hours/days, daily caps (with warm-up ramp), hourly cap, break pattern, delay table.', annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
    guard(async () => ok({ pacing: deps.getPacing(), effectiveDailyCaps: scheduler.effectiveCaps(), effectiveHourlyCap: scheduler.effectiveHourlyCap(), rampDay: scheduler.daysSinceFirstAction() })),
  );

  server.registerTool(
    'pacing_set',
    {
      title: 'Change pacing settings',
      description:
        'Adjust how fast/when the worker acts. Persisted. Slower is safer: the defaults mimic a recruiter reviewing applicants during office hours. Raising dailyProfileCap above ~100 or hourlyActionCap above ~60 materially increases the chance LinkedIn restricts the account.',
      inputSchema: {
        speed: z.enum(['slow', 'normal', 'brisk']).optional(),
        workHoursStart: z.string().regex(HHMM, 'HH:MM').optional(),
        workHoursEnd: z.string().regex(HHMM, 'HH:MM').optional(),
        workDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional().describe('0=Sunday … 6=Saturday'),
        timezone: z.string().optional().describe('IANA time zone, e.g. Europe/Berlin; empty string = system'),
        dailyApplicantCap: z.number().int().min(1).max(600).optional(),
        dailyProfileCap: z.number().int().min(1).max(300).optional(),
        hourlyActionCap: z.number().int().min(1).max(200).optional(),
        rampStart: z.number().int().min(0).max(600).optional().describe('Day-1 cap; 0 disables the warm-up ramp'),
        rampPerDay: z.number().int().min(0).max(200).optional(),
        dailyCapVariance: z
          .number()
          .min(0)
          .max(0.5)
          .optional()
          .describe("Day-to-day spread of the caps: each day's caps and each hour's cap are drawn within this fraction of the configured value (0.35 = up to 35 percent lower, so a cap of 120 becomes anything from 78 to 120; the configured cap is never exceeded). 0 = exact numbers every day"),
        randomizeOrder: z.boolean().optional(),
        warmupProbability: z.number().min(0).max(0.5).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: true },
    },
    guard(async (patch) => {
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<PacingSettings> & { timezone?: string };
      if (clean.timezone !== undefined) {
        if (clean.timezone === '') clean.timezone = undefined;
        else {
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: clean.timezone }).format(new Date());
          } catch {
            return fail(new Error(`Unknown time zone: ${clean.timezone}`));
          }
        }
      }
      const cur = deps.getPacing();
      const start = clean.workHoursStart ?? cur.workHoursStart;
      const end = clean.workHoursEnd ?? cur.workHoursEnd;
      if (start >= end) return fail(new Error(`workHoursStart (${start}) must be before workHoursEnd (${end})`));
      const warnings: string[] = [];
      if ((clean.dailyProfileCap ?? cur.dailyProfileCap) > 100) warnings.push('dailyProfileCap > 100 is above what practitioners consider safe for a normal account.');
      if ((clean.hourlyActionCap ?? cur.hourlyActionCap) > 60) warnings.push('hourlyActionCap > 60 looks like a burst to LinkedIn.');
      if (clean.rampStart === 0) warnings.push('Warm-up ramp disabled: new automation at full speed is the most common restriction trigger.');
      const pacing = deps.setPacing(clean);
      db.addEvent('info', 'control', 'pacing changed', clean);
      return ok({ pacing, effectiveDailyCaps: scheduler.effectiveCaps(), effectiveHourlyCap: scheduler.effectiveHourlyCap(), warnings });
    }),
  );
}
