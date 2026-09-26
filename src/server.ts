import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from './deps.js';
import { registerSessionTools } from './tools/session.tools.js';
import { registerJobsTools } from './tools/jobs.tools.js';
import { registerApplicantsTools } from './tools/applicants.tools.js';
import { registerQueueTools } from './tools/queue.tools.js';
import { registerDataTools } from './tools/data.tools.js';
import { registerDebugTools } from './tools/debug.tools.js';

export const SERVER_NAME = 'linkedin-applicants-mcp';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = `LinkedIn applicants exporter for job posters. It drives the user's OWN logged-in Google Chrome (visible window, real profile) to read the hiring dashboard for jobs they posted: posted jobs → applicant lists → each application (contact info, screening answers, rating, resume file) → the applicant's full LinkedIn profile. Everything that touches LinkedIn runs in a background queue paced like a recruiter (working hours, daily caps with a warm-up ramp, hourly cap, random breaks, log-normal delays, shuffled order); thousands of applicants therefore take days to weeks by design, never try to hurry it, and prefer 'slow' over raising caps. Safe workflow: browser_status → browser_open_login (human signs in) → jobs_sync → jobs_list → applicants_sync(jobId) → applicants_fetch_details(jobId) → poll queue_status → read with applicants_list / applicant_get / resume_text, export with applicants_export. If queue_status shows needsHuman, the user must solve the LinkedIn checkpoint in the Chrome window, then call queue_resume. Data tools read only the local database and are instant. The server never rates, messages or otherwise writes anything on LinkedIn.`;

/** Build the MCP server with all tools and prompts registered. */
export function createServer(deps: Deps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerSessionTools(server, deps);
  registerJobsTools(server, deps);
  registerApplicantsTools(server, deps);
  registerQueueTools(server, deps);
  registerDataTools(server, deps);
  registerDebugTools(server, deps);

  server.registerPrompt(
    'review_applicants',
    {
      title: 'Review applicants against criteria',
      description: 'Score every stored applicant of a job against hiring criteria using the local data (resume text, profile, screening answers) and produce a ranked table.',
      argsSchema: {
        jobId: z.string().describe('Job id from jobs_list'),
        criteria: z.string().describe('What a strong candidate looks like (skills, seniority, location, must-haves)'),
      },
    },
    ({ jobId, criteria }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Review the applicants of LinkedIn job ${jobId} against these criteria:\n\n${criteria}\n\nSteps: (1) call applicants_list with jobId="${jobId}" and page through all results (limit 100, follow nextOffset). (2) For each applicant call applicant_get (or resume_text) to read the resume text, structured profile and screening answers; skip nothing that has data. (3) Score each applicant 1-10 on the criteria, note must-have gaps, and flag missing data (no resume / profile not fetched yet). (4) Output a ranked markdown table: rank, name, headline, location, score, key strengths, gaps, applicationId, profileUrl. (5) End with a short list of applicants whose details are still missing so I can run applicants_fetch_details for them. Do not contact anyone and do not invent facts not present in the data.`,
          },
        },
      ],
    }),
  );

  return server;
}
