import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import type { ProfileDepth, TaskPayload } from '../types.js';
import { fail, guard, ok } from './result.js';

const DEPTH = z.enum(['basic', 'full']);

function enqueueAll(deps: Deps, payloads: TaskPayload[]): { enqueued: number; deduped: number; taskIds: number[] } {
  let enqueued = 0;
  let deduped = 0;
  const taskIds: number[] = [];
  deps.db.transaction(() => {
    for (const p of payloads) {
      const id = deps.db.enqueueTask(p);
      if (id === undefined) deduped++;
      else {
        enqueued++;
        taskIds.push(id);
      }
    }
  });
  return { enqueued, deduped, taskIds };
}

export function registerApplicantsTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    'applicants_sync',
    {
      title: 'Sync the applicant list of a job',
      description:
        'Queue a crawl of the applicant LIST for one job (or every known job): names, headlines, locations, applied dates, application ids and profile links, 25 per page. Thousands of applicants mean many pages, so the crawl runs in chunks of pagesPerRun pages per worker turn, persists progress after every page, and resumes automatically across restarts and working-hours windows. Hidden "Not a fit" applicants are included by default. This does NOT open individual applications (use applicants_fetch_details for contact info, resumes and profiles). Progress: queue_status or jobs_list.',
      inputSchema: {
        jobId: z.string().optional().describe('LinkedIn job id (from jobs_list). Omit with allJobs=true to sync every known job.'),
        allJobs: z.boolean().default(false).describe('Sync every job known locally'),
        pagesPerRun: z.number().int().min(1).max(60).default(12).describe('List pages (25 applicants each) per worker turn before the scheduler re-checks caps'),
        includeNotAFit: z.boolean().default(true).describe('Enable the Ratings filter so applicants marked "Not a fit" are included'),
        restart: z.boolean().default(false).describe('Ignore saved progress and start from the first page again'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
    },
    guard(async ({ jobId, allJobs, pagesPerRun, includeNotAFit, restart }) => {
      const jobIds = jobId ? [jobId] : allJobs ? deps.db.listJobs('all').map((j) => j.jobId) : [];
      if (!jobIds.length) return fail(new Error('Provide jobId, or allJobs=true after jobs_sync has stored jobs.'));
      for (const id of jobIds) {
        if (!deps.db.getJob(id)) {
          // Unknown job: register a placeholder so applicants can reference it (title filled by the next jobs_sync)
          deps.db.upsertJob({ jobId: id, title: `Job ${id}`, status: 'unknown', url: `https://www.linkedin.com/hiring/jobs/${id}/applicants/`, syncedAt: new Date().toISOString() });
        }
        if (restart) deps.db.clearSyncProgress(id);
      }
      const result = enqueueAll(
        deps,
        jobIds.map((id) => ({ type: 'sync_applicants', jobId: id, pagesPerRun, includeNotAFit, startOffset: restart ? 0 : undefined })),
      );
      deps.worker.start();
      return ok({
        ...result,
        jobs: jobIds.map((id) => ({ jobId: id, title: deps.db.getJob(id)?.title, applicantsStored: deps.db.countApplicants(id), progress: deps.db.getSyncProgress(id) })),
        note: 'Running in the background. A job with 2,000 applicants is ~80 pages; at normal pacing that is a few hours of list crawling inside working hours. Check queue_status.',
      });
    }),
  );

  server.registerTool(
    'applicants_fetch_details',
    {
      title: 'Fetch application details, resumes and profiles',
      description:
        'Queue the deep fetch for applicants: open each application page (contact email/phone when shared, screening answers, rating, applied date), download the resume, and (includeProfile) then visit the LinkedIn profile for the full structured profile. One applicant at a time, paced like a recruiter, within working hours and daily caps, so thousands of applicants take days to weeks by design. Defaults to only applicants not fetched yet. Returns how many were queued and a time estimate. Track with queue_status; read results with applicants_list / applicant_get / applicants_export.',
      inputSchema: {
        jobId: z.string().optional().describe('Fetch all applicants of this job (subject to onlyMissing/limit)'),
        applicationIds: z.array(z.string()).optional().describe('Explicit application ids instead of a whole job'),
        downloadResume: z.boolean().default(true),
        includeProfile: z.boolean().default(true).describe('Also queue the full LinkedIn profile after the application page'),
        profileDepth: DEPTH.default('full').describe("'full' visits detail sections when Voyager is unavailable; 'basic' reads only the main profile page"),
        savePdf: z.boolean().default(false).describe('Reserved: LinkedIn "Save to PDF" is a Chrome download, which crashes Chrome 154 under automation, so it is currently skipped with a warning; the structured profile is stored instead'),
        onlyMissing: z.boolean().default(true).describe('Skip applicants whose details were already fetched (with downloadResume, applicants whose resume is still missing are included)'),
        limit: z.number().int().min(1).max(10000).optional().describe('Queue at most this many applicants now'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
    },
    guard(async ({ jobId, applicationIds, downloadResume, includeProfile, profileDepth, savePdf, onlyMissing, limit }) => {
      let targets: Array<{ applicationId: string; jobId: string }> = [];
      if (applicationIds?.length) {
        for (const id of applicationIds) {
          const a = deps.db.getApplicant(id);
          if (!a) return fail(new Error(`Unknown applicationId ${id}. Run applicants_sync first.`));
          const resumeMissing = downloadResume && a.hasResume !== false && !a.resumePath;
          if (onlyMissing && a.detailFetchedAt && !resumeMissing) continue;
          targets.push({ applicationId: id, jobId: a.jobId });
        }
      } else if (jobId) {
        if (onlyMissing) {
          // Applicants without details, plus (when resumes are wanted) those whose resume is still missing.
          const ids = new Set(deps.db.applicantIdsNeeding(jobId, 'detail').map((x) => x.applicationId));
          if (downloadResume) for (const x of deps.db.applicantIdsNeeding(jobId, 'resume')) ids.add(x.applicationId);
          targets = [...ids].map((applicationId) => ({ applicationId, jobId }));
        } else {
          targets = deps.db.listApplicantIds(jobId);
        }
      } else {
        return fail(new Error('Provide jobId or applicationIds.'));
      }
      if (limit) targets = targets.slice(0, limit);
      const thenProfile = includeProfile ? { depth: profileDepth as ProfileDepth, savePdf } : undefined;
      const result = enqueueAll(
        deps,
        targets.map((t) => ({ type: 'fetch_application', jobId: t.jobId, applicationId: t.applicationId, downloadResume, thenProfile })),
      );
      deps.worker.start();
      const caps = deps.scheduler.effectiveCaps();
      const pending = deps.db.pendingByType();
      const detailsQueued = pending.fetch_application ?? 0;
      const profilesQueued = (pending.fetch_profile ?? 0) + (includeProfile ? result.enqueued : 0);
      return ok({
        ...result,
        targeted: targets.length,
        queueNow: pending,
        effectiveDailyCaps: caps,
        estimate: {
          detailDays: Math.ceil(detailsQueued / Math.max(1, caps.applicants)),
          profileDays: includeProfile ? Math.ceil(profilesQueued / Math.max(1, caps.profiles)) : 0,
          note: 'Estimates assume work-hour windows every work day. Caps ramp up over the first days on purpose; raise them cautiously with pacing_set.',
        },
      });
    }),
  );

  server.registerTool(
    'applicants_fetch_profiles',
    {
      title: 'Fetch full LinkedIn profiles only',
      description:
        'Queue full-profile fetches for applicants whose profile URL is known (from the list or application page) without re-opening their application. Use when details were fetched with includeProfile=false. Paced like a person; profile views are the most rate-sensitive action.',
      inputSchema: {
        jobId: z.string().optional(),
        applicationIds: z.array(z.string()).optional(),
        depth: DEPTH.default('full'),
        savePdf: z.boolean().default(false).describe('Reserved: currently skipped with a warning (Chrome download crash), the structured profile is stored instead'),
        onlyMissing: z.boolean().default(true).describe('Skip applicants whose profile was already fetched'),
        limit: z.number().int().min(1).max(10000).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
    },
    guard(async ({ jobId, applicationIds, depth, savePdf, onlyMissing, limit }) => {
      let targets: Array<{ applicationId: string; jobId: string; profileUrl: string }> = [];
      let missingUrl = 0;
      const consider = (a: { applicationId: string; jobId: string; profileUrl?: string; profileFetchedAt?: string }) => {
        if (onlyMissing && a.profileFetchedAt) return;
        if (!a.profileUrl) {
          missingUrl++;
          return;
        }
        targets.push({ applicationId: a.applicationId, jobId: a.jobId, profileUrl: a.profileUrl });
      };
      if (applicationIds?.length) {
        for (const id of applicationIds) {
          const a = deps.db.getApplicant(id);
          if (!a) return fail(new Error(`Unknown applicationId ${id}`));
          consider(a);
        }
      } else if (jobId) {
        if (onlyMissing) for (const x of deps.db.applicantIdsNeeding(jobId, 'profile')) consider({ applicationId: x.applicationId, jobId, profileUrl: x.profileUrl });
        else for (const x of deps.db.listApplicantIds(jobId)) consider(x);
      } else {
        return fail(new Error('Provide jobId or applicationIds.'));
      }
      if (limit) targets = targets.slice(0, limit);
      const result = enqueueAll(
        deps,
        targets.map((t) => ({ type: 'fetch_profile', jobId: t.jobId, applicationId: t.applicationId, profileUrl: t.profileUrl, depth: depth as ProfileDepth, savePdf })),
      );
      deps.worker.start();
      const caps = deps.scheduler.effectiveCaps();
      return ok({
        ...result,
        targeted: targets.length,
        skippedNoProfileUrl: missingUrl,
        estimateDays: Math.ceil((deps.db.pendingByType().fetch_profile ?? 0) / Math.max(1, caps.profiles)),
        note: missingUrl ? 'Applicants without a profile URL need applicants_fetch_details first (the application page links to the profile).' : undefined,
      });
    }),
  );
}
