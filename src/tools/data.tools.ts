import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { exportApplicants } from '../storage/export.js';
import { clip, fail, guard, ok } from './result.js';

const RATING = z.enum(['good_fit', 'maybe', 'not_a_fit', 'unrated', 'unknown']);

export function registerDataTools(server: McpServer, deps: Deps): void {
  const { db } = deps;

  server.registerTool(
    'applicants_list',
    {
      title: 'List / search applicants',
      description:
        'Page through applicants stored locally, with filters and full-text search over name, headline, resume text and profile text (prefix matching, e.g. "kubern django"). Rows omit resume/profile bodies; use applicant_get for one applicant. Reads the local database only (no LinkedIn traffic).',
      inputSchema: {
        jobId: z.string().optional(),
        search: z.string().optional().describe('Full-text query over name, headline, resume text, profile text'),
        hasResume: z.boolean().optional(),
        hasProfile: z.boolean().optional(),
        hasDetail: z.boolean().optional().describe('Whether the application page was fetched (contact info, screening answers)'),
        rating: RATING.optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
        orderBy: z.enum(['appliedAt', 'fullName', 'listSyncedAt']).default('appliedAt'),
        order: z.enum(['asc', 'desc']).default('desc'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    guard(async (f) => {
      const { total, items } = db.listApplicants(f);
      return ok({ total, count: items.length, offset: f.offset, nextOffset: f.offset + items.length < total ? f.offset + items.length : null, items: items.map((a) => ({ ...a, raw: undefined })) });
    }),
  );

  server.registerTool(
    'applicant_get',
    {
      title: 'Get one applicant',
      description: 'Full local record for one applicant: list fields, application details (email/phone when shared, screening answers, rating), resume text (clipped to maxChars) and the structured LinkedIn profile. Local database only.',
      inputSchema: {
        applicationId: z.string(),
        includeResumeText: z.boolean().default(true),
        includeProfile: z.boolean().default(true),
        maxChars: z.number().int().min(500).max(200_000).default(20_000).describe('Clip resume text to this many characters'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    guard(async ({ applicationId, includeResumeText, includeProfile, maxChars }) => {
      const a = db.getApplicant(applicationId);
      if (!a) return fail(new Error(`No applicant with applicationId ${applicationId}`));
      const resume = includeResumeText ? clip(a.resumeText, maxChars) : undefined;
      return ok({
        ...a,
        raw: undefined,
        resumeText: resume?.text,
        resumeTextTruncated: resume?.truncated,
        resumeTextChars: resume?.totalChars,
        profile: includeProfile ? a.profile : undefined,
        job: db.getJob(a.jobId)?.title,
      });
    }),
  );

  server.registerTool(
    'resume_text',
    {
      title: 'Resume text',
      description: 'Plain text extracted from the downloaded resume (PDF/DOCX) of one applicant, clipped to maxChars. Empty when the resume was a scanned image or was not downloaded.',
      inputSchema: { applicationId: z.string(), maxChars: z.number().int().min(500).max(300_000).default(30_000) },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    guard(async ({ applicationId, maxChars }) => {
      const a = db.getApplicant(applicationId);
      if (!a) return fail(new Error(`No applicant with applicationId ${applicationId}`));
      const c = clip(a.resumeText, maxChars);
      return ok({ applicationId, fullName: a.fullName, resumePath: a.resumePath, resumeFileName: a.resumeFileName, hasResume: a.hasResume, ...c }, c.text ?? (a.resumePath ? 'Resume downloaded but no text could be extracted (scanned/image PDF?).' : 'No resume stored for this applicant.'));
    }),
  );

  server.registerTool(
    'applicants_export',
    {
      title: 'Export applicants to CSV / JSON',
      description: 'Write all stored applicants (optionally one job) to a CSV, JSON or JSONL file on disk and return the path. Streams, so thousands of rows are fine. CSV is Excel-friendly (UTF-8 BOM) and guards against formula injection.',
      inputSchema: {
        jobId: z.string().optional(),
        format: z.enum(['csv', 'json', 'jsonl']).default('csv'),
        includeResumeText: z.boolean().default(false),
        includeProfile: z.boolean().default(false).describe('Include the structured profile (JSON string in CSV)'),
        outPath: z.string().optional().describe('Absolute output path; default under the data directory /exports'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    },
    guard(async ({ jobId, format, includeResumeText, includeProfile, outPath }) => {
      const r = await exportApplicants(db, deps.cfg, { jobId, format, includeResumeText, includeProfile, outPath });
      return ok({ ...r, format });
    }),
  );
}
