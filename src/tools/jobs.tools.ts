import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { guard, ok, sleep } from './result.js';

const JOB_STATUS = z.enum(['all', 'open', 'closed', 'paused', 'draft', 'unknown']);

export function registerJobsTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    'jobs_sync',
    {
      title: 'Sync posted jobs from LinkedIn',
      description:
        'Queue a crawl of your posted jobs (/my-items/posted-jobs/, open and optionally closed) and store them locally. Runs in the background paced like a person (roughly 1–3 minutes). With wait=true the call blocks up to 2 minutes and returns the jobs found. Afterwards use jobs_list.',
      inputSchema: {
        includeClosed: z.boolean().default(true).describe('Also crawl the Closed tab'),
        wait: z.boolean().default(false).describe('Block until the sync finishes (max 120 s)'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
    },
    guard(async ({ includeClosed, wait }) => {
      const { db, worker } = deps;
      const taskId = db.enqueueTask({ type: 'sync_jobs', includeClosed });
      worker.start();
      let taskStatus = taskId ? db.getTask(taskId)?.status : 'deduped';
      if (wait) {
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          const pending = db.listTasks({ type: 'sync_jobs', limit: 5 }).find((t) => t.status === 'pending' || t.status === 'running');
          if (!pending) break;
          if (!worker.isRunning()) {
            // worker owned by another process or refused to start: try to run inline once
            const ran = await worker.runOnce();
            if (!ran) await sleep(3000);
          } else await sleep(3000);
        }
        taskStatus = taskId ? db.getTask(taskId)?.status : taskStatus;
      }
      const jobs = db.listJobs('all');
      const status = worker.status();
      return ok({
        taskId: taskId ?? null,
        deduped: taskId === undefined,
        taskStatus,
        workerRunning: worker.isRunning() || status.running,
        needsHuman: status.needsHuman,
        needsHumanReason: status.needsHumanReason,
        nextEligibleAt: status.nextEligibleAt,
        jobsKnown: jobs.length,
        jobs: wait ? jobs.slice(0, 100) : undefined,
        note: wait ? undefined : 'Running in the background. Check queue_status, then jobs_list.',
      });
    }),
  );

  server.registerTool(
    'jobs_list',
    {
      title: 'List known jobs',
      description: 'List the posted jobs stored locally (from jobs_sync) with per-job progress counters: applicants stored, details fetched, resumes stored, profiles fetched, and applicant-list sync progress.',
      inputSchema: { status: JOB_STATUS.default('all').describe('Filter by job status') },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    guard(async ({ status }) => {
      const jobs = deps.db.listJobs(status).map((j) => ({ ...j, raw: undefined, syncProgress: deps.db.getSyncProgress(j.jobId) }));
      return ok({ count: jobs.length, jobs });
    }),
  );
}
