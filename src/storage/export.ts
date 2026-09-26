import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Applicant } from '../types.js';
import type { Db } from './db.js';
import { ensureDir, safeName } from './files.js';

export interface ExportOptions {
  jobId?: string;
  format: 'csv' | 'json' | 'jsonl';
  /** Absolute output path; default <dataDir>/exports/applicants-<jobId|all>-<timestamp>.<ext> */
  outPath?: string;
  includeResumeText?: boolean;
  includeProfile?: boolean;
}

export const EXPORT_COLUMNS = [
  'applicationId',
  'jobId',
  'jobTitle',
  'fullName',
  'headline',
  'location',
  'email',
  'phone',
  'appliedAt',
  'rating',
  'profileUrl',
  'hasResume',
  'resumeFileName',
  'resumePath',
  'profilePath',
  'screeningAnswers',
  'detailFetchedAt',
  'profileFetchedAt',
  'listSyncedAt',
] as const;

/** One CSV cell: RFC 4180 quoting plus a formula guard (values starting with = + - @ tab CR get a leading quote). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV with UTF-8 BOM (Excel-friendly) and formula guard. */
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const lines = [columns.map(csvCell).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  return `﻿${lines.join('\n')}\n`;
}

export function applicantToRow(a: Applicant & { profile?: unknown }, jobTitle: string | undefined, opts: { includeResumeText?: boolean; includeProfile?: boolean; forCsv: boolean }): Record<string, unknown> {
  const row: Record<string, unknown> = {
    applicationId: a.applicationId,
    jobId: a.jobId,
    jobTitle,
    fullName: a.fullName,
    headline: a.headline,
    location: a.location,
    email: a.email,
    phone: a.phone,
    appliedAt: a.appliedAt,
    rating: a.rating,
    profileUrl: a.profileUrl,
    hasResume: a.hasResume,
    resumeFileName: a.resumeFileName,
    resumePath: a.resumePath,
    profilePath: a.profilePath,
    screeningAnswers: a.screeningAnswers ? (opts.forCsv ? JSON.stringify(a.screeningAnswers) : a.screeningAnswers) : undefined,
    detailFetchedAt: a.detailFetchedAt,
    profileFetchedAt: a.profileFetchedAt,
    listSyncedAt: a.listSyncedAt,
  };
  if (opts.includeResumeText) row.resumeText = a.resumeText;
  if (opts.includeProfile) row.profile = opts.forCsv && a.profile ? JSON.stringify(a.profile) : a.profile;
  return row;
}

function write(ws: fs.WriteStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Export applicants (with parsed detail/profile fields) to CSV / JSON / JSONL, streaming row by row so
 * thousands of applicants with resume text never have to be held in memory.
 */
export async function exportApplicants(db: Db, cfg: Config, opts: ExportOptions): Promise<{ path: string; count: number }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ext = opts.format === 'jsonl' ? 'jsonl' : opts.format;
  const outPath = opts.outPath ?? path.join(cfg.dataDir, 'exports', `applicants-${opts.jobId ? safeName(opts.jobId) : 'all'}-${stamp}.${ext}`);
  ensureDir(path.dirname(outPath));
  const columns: string[] = [...EXPORT_COLUMNS];
  if (opts.includeResumeText) columns.push('resumeText');
  if (opts.includeProfile) columns.push('profile');
  const titles = new Map<string, string | undefined>();
  const jobTitle = (jobId: string) => {
    if (!titles.has(jobId)) titles.set(jobId, db.getJob(jobId)?.title);
    return titles.get(jobId);
  };

  const ws = fs.createWriteStream(outPath, { encoding: 'utf8' });
  let count = 0;
  try {
    if (opts.format === 'csv') await write(ws, `﻿${columns.map(csvCell).join(',')}\n`);
    if (opts.format === 'json') await write(ws, '[\n');
    for (const a of db.iterateApplicantsFull(opts.jobId)) {
      const row = applicantToRow(a, jobTitle(a.jobId), { includeResumeText: opts.includeResumeText, includeProfile: opts.includeProfile, forCsv: opts.format === 'csv' });
      if (opts.format === 'csv') await write(ws, `${columns.map((c) => csvCell(row[c])).join(',')}\n`);
      else if (opts.format === 'jsonl') await write(ws, `${JSON.stringify(row)}\n`);
      else await write(ws, `${count ? ',\n' : ''}${JSON.stringify(row)}`);
      count++;
    }
    if (opts.format === 'json') await write(ws, '\n]\n');
  } finally {
    await new Promise<void>((resolve) => ws.end(resolve));
  }
  return { path: outPath, count };
}
