#!/usr/bin/env node
/**
 * Local, read-mostly dashboard over the same SQLite database the MCP server and worker use.
 *   npm run dashboard            → http://127.0.0.1:4173
 * Binds to localhost only (applicant data is personal information). Never touches LinkedIn.
 * The only write it performs is creating export files under <data>/exports when you click Export.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { loadConfig } from './config.js';
import { Db } from './storage/db.js';
import { exportApplicants } from './storage/export.js';
import { Scheduler } from './queue/scheduler.js';
import { readWorkerStatus, SETTINGS } from './queue/worker.js';
import { mergePacing } from './bootstrap.js';
import type { ApplicantRating, PacingSettings } from './types.js';

const cfg = loadConfig();
const db = new Db(cfg.dbPath);
/** Prefer the effective pacing published by the MCP server (it holds the env the dashboard may not have). */
const getPacing = (): PacingSettings => db.getSetting<PacingSettings>(SETTINGS.pacingEffective) ?? mergePacing(cfg.pacingDefaults, db.getSetting<Partial<PacingSettings>>(SETTINGS.pacing));
const scheduler = new Scheduler(db, getPacing);
const PORT = Number.parseInt(process.env.LINKEDIN_MCP_DASHBOARD_PORT ?? '4173', 10);
const exportsDir = path.join(cfg.dataDir, 'exports');

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.rtf': 'application/rtf',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.csv': 'text/csv; charset=utf-8',
  '.jsonl': 'application/x-ndjson',
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

/** Serve a file that must live under `root` (blocks path traversal). */
function serveFile(res: http.ServerResponse, root: string, rel: string, download = false): void {
  const abs = path.resolve(root, decodeURIComponent(rel));
  if (!abs.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  const headers: Record<string, string> = { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' };
  if (download) headers['content-disposition'] = `attachment; filename="${path.basename(abs)}"`;
  res.writeHead(200, headers);
  fs.createReadStream(abs).pipe(res);
}

function fileUrl(abs: string | undefined): string | undefined {
  if (!abs) return undefined;
  const rel = path.relative(cfg.filesDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return `/files/${rel.split(path.sep).map(encodeURIComponent).join('/')}`;
}

function summary() {
  const pacing = getPacing();
  const jobs = db.listJobs('all');
  const total = (sql: string) => Number((db.db.prepare(sql).get() as { c: number }).c);
  return {
    now: new Date().toISOString(),
    dataDir: cfg.dataDir,
    jobs: jobs.length,
    applicants: total('SELECT COUNT(*) AS c FROM applicants'),
    details: total('SELECT COUNT(*) AS c FROM applicants WHERE detail_fetched_at IS NOT NULL'),
    resumes: total('SELECT COUNT(*) AS c FROM applicants WHERE resume_path IS NOT NULL'),
    profiles: total('SELECT COUNT(*) AS c FROM applicants WHERE profile_fetched_at IS NOT NULL'),
    withEmail: total('SELECT COUNT(*) AS c FROM applicants WHERE email IS NOT NULL'),
    tasks: db.taskCounts(),
    pendingByType: db.pendingByType(),
    worker: readWorkerStatus(db, scheduler),
    inWorkWindow: scheduler.inWorkWindow(),
    nextWindowStart: scheduler.inWorkWindow() ? null : scheduler.nextWindowStart().toISOString(),
    effectiveCaps: scheduler.effectiveCaps(),
    pacing: { speed: pacing.speed, workHours: `${pacing.workHoursStart}-${pacing.workHoursEnd}`, workDays: pacing.workDays, rampDay: scheduler.daysSinceFirstAction() },
    events: db.recentEvents(15),
    jobRows: jobs.map((j) => ({ ...j, raw: undefined, syncProgress: db.getSyncProgress(j.jobId) })),
  };
}

const RATINGS = new Set(['good_fit', 'maybe', 'not_a_fit', 'unrated', 'unknown']);
const bool = (v: string | null): boolean | undefined => (v === 'true' ? true : v === 'false' ? false : undefined);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const p = url.pathname;
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(HTML);
      return;
    }
    if (p === '/api/summary') return json(res, 200, summary());
    if (p === '/api/applicants') {
      const q = url.searchParams;
      const rating = q.get('rating');
      const r = db.listApplicants({
        jobId: q.get('jobId') || undefined,
        search: q.get('search') || undefined,
        hasResume: bool(q.get('hasResume')),
        hasProfile: bool(q.get('hasProfile')),
        hasDetail: bool(q.get('hasDetail')),
        rating: rating && RATINGS.has(rating) ? (rating as ApplicantRating) : undefined,
        limit: Math.min(Number.parseInt(q.get('limit') ?? '50', 10) || 50, 200),
        offset: Number.parseInt(q.get('offset') ?? '0', 10) || 0,
        orderBy: (q.get('orderBy') as 'appliedAt' | 'fullName' | 'listSyncedAt' | null) ?? 'listSyncedAt',
        order: (q.get('order') as 'asc' | 'desc' | null) ?? 'desc',
      });
      return json(res, 200, { total: r.total, items: r.items.map((a) => ({ ...a, raw: undefined, resumeUrl: fileUrl(a.resumePath), profileFileUrl: fileUrl(a.profilePath) })) });
    }
    const m = /^\/api\/applicant\/(\d+)$/.exec(p);
    if (m) {
      const a = db.getApplicant(m[1]!);
      if (!a) return json(res, 404, { error: 'not found' });
      const rawExtra = (a.raw as Record<string, unknown> | undefined) ?? {};
      return json(res, 200, {
        ...a,
        raw: undefined,
        qualifications: rawExtra.qualifications,
        resumeText: a.resumeText ? a.resumeText.slice(0, 20_000) : undefined,
        resumeTextChars: a.resumeText?.length ?? 0,
        resumeUrl: fileUrl(a.resumePath),
        profileFileUrl: fileUrl(a.profilePath),
        jobTitle: db.getJob(a.jobId)?.title,
      });
    }
    if (p === '/api/export') {
      const format = (url.searchParams.get('format') ?? 'csv') as 'csv' | 'json' | 'jsonl';
      const r = await exportApplicants(db, cfg, { jobId: url.searchParams.get('jobId') || undefined, format: ['csv', 'json', 'jsonl'].includes(format) ? format : 'csv', includeResumeText: url.searchParams.get('resumeText') === 'true', includeProfile: url.searchParams.get('profile') === 'true' });
      return json(res, 200, { ...r, url: `/exports/${encodeURIComponent(path.basename(r.path))}` });
    }
    if (p.startsWith('/files/')) return serveFile(res, cfg.filesDir, p.slice('/files/'.length));
    if (p.startsWith('/exports/')) return serveFile(res, exportsDir, p.slice('/exports/'.length), true);
    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`LinkedIn applicants dashboard → http://127.0.0.1:${PORT}  (data: ${cfg.dataDir})\n`);
});

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LinkedIn Applicants</title>
<style>
  :root {
    color-scheme: light;
    --surface: #fcfcfb; --surface-2: #f3f2ef; --border: #e2e0da;
    --text: #0b0b0b; --text-2: #52514e; --text-3: #8a887f;
    --accent: #2a78d6; --accent-track: #cde2fb; --accent-soft: #e6f0fb;
    --good: #0ca30c; --warning: #fab219; --serious: #ec835a; --critical: #d03b3b;
    --good-soft: #e3f5e3; --warning-soft: #fff3d6; --critical-soft: #fbe3e3;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --surface: #1a1a19; --surface-2: #232322; --border: #383835;
      --text: #ffffff; --text-2: #c3c2b7; --text-3: #8f8e86;
      --accent: #3987e5; --accent-track: #184f95; --accent-soft: #1f2f45;
      --good-soft: #17301a; --warning-soft: #3a2e12; --critical-soft: #3a1c1c;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--surface); color: var(--text); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif; }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--surface); z-index: 5; }
  header h1 { font-size: 18px; margin: 0; font-weight: 600; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--surface-2); color: var(--text-2); border: 1px solid var(--border); }
  .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); }
  .pill.good .dot { background: var(--good); } .pill.warning .dot { background: var(--warning); } .pill.critical .dot { background: var(--critical); } .pill.accent .dot { background: var(--accent); }
  .spacer { flex: 1; }
  .muted { color: var(--text-2); } .tiny { font-size: 12px; color: var(--text-3); }
  main { padding: 16px 20px 40px; max-width: 1400px; margin: 0 auto; }
  section { margin-bottom: 24px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-2); margin: 0 0 10px; font-weight: 600; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .tile { background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .tile .label { font-size: 12px; color: var(--text-2); }
  .tile .value { font-size: 26px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .tile .sub { font-size: 12px; color: var(--text-3); margin-top: 2px; }
  .meter { height: 6px; border-radius: 3px; background: var(--accent-track); overflow: hidden; margin-top: 8px; }
  .meter > i { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { font-size: 12px; color: var(--text-2); font-weight: 600; white-space: nowrap; }
  tbody tr:hover { background: var(--surface-2); }
  tbody tr.clickable { cursor: pointer; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .bar { display: flex; align-items: center; gap: 8px; min-width: 160px; }
  .bar .meter { flex: 1; margin: 0; }
  .bar span { font-size: 12px; color: var(--text-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2); }
  .badge.open { background: var(--good-soft); color: var(--good); border-color: transparent; }
  .badge.closed { background: var(--surface-2); }
  .badge.good_fit { background: var(--good-soft); color: var(--good); border-color: transparent; }
  .badge.maybe { background: var(--warning-soft); color: #8a5a00; border-color: transparent; }
  .badge.not_a_fit { background: var(--critical-soft); color: var(--critical); border-color: transparent; }
  .filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
  input, select, button { font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; }
  input[type="search"] { min-width: 260px; }
  button { cursor: pointer; } button.primary { background: var(--accent); color: #fff; border-color: transparent; }
  label.chk { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; color: var(--text-2); }
  .check { color: var(--good); font-weight: 700; } .dash { color: var(--text-3); }
  a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
  .drawer { position: fixed; top: 0; right: 0; height: 100vh; width: min(560px, 100vw); background: var(--surface); border-left: 1px solid var(--border); box-shadow: -8px 0 24px rgba(0,0,0,.12); transform: translateX(100%); transition: transform .2s ease; overflow: auto; z-index: 10; padding: 18px 20px 40px; }
  .drawer.open { transform: translateX(0); }
  .drawer h3 { margin: 0 0 4px; font-size: 18px; }
  .drawer .close { position: absolute; top: 12px; right: 14px; }
  .kv { display: grid; grid-template-columns: 120px 1fr; gap: 6px 12px; margin: 12px 0; font-size: 13px; }
  .kv dt { color: var(--text-2); } .kv dd { margin: 0; word-break: break-word; }
  pre { white-space: pre-wrap; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; max-height: 320px; overflow: auto; }
  .events { font-size: 12px; color: var(--text-2); }
  .events li { margin: 2px 0; } .events .warn { color: #8a5a00; } .events .error { color: var(--critical); }
  .pager { display: flex; gap: 8px; align-items: center; justify-content: flex-end; margin-top: 8px; font-size: 12px; color: var(--text-2); }
  @media (max-width: 720px) { header { padding: 12px 16px; } main { padding: 12px 16px; } th:nth-child(3), td:nth-child(3), th:nth-child(4), td:nth-child(4) { display: none; } }
</style>
</head>
<body>
<header>
  <h1>LinkedIn Applicants</h1>
  <span id="worker" class="pill"><i class="dot"></i><span>loading…</span></span>
  <span id="window" class="pill"><i class="dot"></i><span>…</span></span>
  <span class="spacer"></span>
  <label class="chk"><input type="checkbox" id="auto" checked /> auto-refresh</label>
  <span id="refreshed" class="tiny"></span>
</header>
<main>
  <section>
    <h2>Overview</h2>
    <div class="kpis" id="kpis"></div>
  </section>
  <section>
    <h2>Jobs</h2>
    <div style="overflow:auto"><table id="jobs"><thead><tr><th>Job</th><th>Status</th><th>Applicants listed</th><th>Details</th><th>Resumes</th><th>Profiles</th><th></th></tr></thead><tbody></tbody></table></div>
  </section>
  <section>
    <h2>Applicants</h2>
    <div class="filters">
      <select id="fJob"><option value="">All jobs</option></select>
      <input type="search" id="fSearch" placeholder="Search name, headline, resume text, profile…" />
      <label class="chk"><input type="checkbox" id="fResume" /> has resume</label>
      <label class="chk"><input type="checkbox" id="fProfile" /> has profile</label>
      <label class="chk"><input type="checkbox" id="fDetail" /> details fetched</label>
      <select id="fRating"><option value="">Any rating</option><option value="good_fit">Good fit</option><option value="maybe">Maybe</option><option value="not_a_fit">Not a fit</option><option value="unrated">Unrated</option></select>
      <span class="spacer"></span>
      <button id="exportCsv">Export CSV</button>
      <button id="exportJson">Export JSON</button>
    </div>
    <div style="overflow:auto"><table id="applicants"><thead><tr><th>Name</th><th>Headline</th><th>Location</th><th>Applied</th><th>Fit / rating</th><th>Detail</th><th>Resume</th><th>Profile</th><th>Links</th></tr></thead><tbody></tbody></table></div>
    <div class="pager"><span id="count"></span><button id="prev">‹ Prev</button><button id="next">Next ›</button></div>
  </section>
  <section>
    <h2>Recent worker events</h2>
    <ul class="events" id="events"></ul>
  </section>
</main>
<div class="drawer" id="drawer"><button class="close" onclick="closeDrawer()">✕</button><div id="drawerBody"></div></div>
<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (n) => n == null ? '–' : Number(n).toLocaleString();
const ago = (iso) => { if (!iso) return '–'; const s = (Date.now() - Date.parse(iso)) / 1000; if (s < 60) return Math.round(s) + 's ago'; if (s < 3600) return Math.round(s/60) + 'm ago'; if (s < 86400) return Math.round(s/3600) + 'h ago'; return Math.round(s/86400) + 'd ago'; };
const date = (iso) => iso ? new Date(iso).toLocaleDateString() : '–';
let offset = 0; const LIMIT = 50; let lastTotal = 0;

function meter(n, d) { const pct = d ? Math.min(100, Math.round(100 * n / d)) : 0; return '<div class="bar"><div class="meter"><i style="width:' + pct + '%"></i></div><span>' + fmt(n) + (d ? ' / ' + fmt(d) : '') + '</span></div>'; }

async function loadSummary() {
  const s = await (await fetch('/api/summary')).json();
  const w = s.worker;
  const wp = $('#worker'); wp.className = 'pill ' + (w.needsHuman ? 'critical' : w.paused ? 'warning' : w.running ? 'good' : '');
  wp.lastElementChild.textContent = w.needsHuman ? 'needs you: ' + (w.needsHumanReason || 'checkpoint') : w.paused ? 'paused' : w.running ? (w.currentTask ? 'working: ' + w.currentTask.type : 'worker idle') : 'worker not running';
  const win = $('#window'); win.className = 'pill ' + (s.inWorkWindow ? 'accent' : '');
  win.lastElementChild.textContent = s.inWorkWindow ? 'inside working hours (' + s.pacing.workHours + ', ' + s.pacing.speed + ')' : 'outside hours · resumes ' + (s.nextWindowStart ? new Date(s.nextWindowStart).toLocaleString() : '–');
  const caps = s.effectiveCaps, t = w.todayCounts;
  $('#kpis').innerHTML = [
    ['Applicants listed', s.applicants, s.jobs + ' jobs'],
    ['Details fetched', s.details, s.withEmail + ' with email'],
    ['Resumes stored', s.resumes, ''],
    ['Profiles fetched', s.profiles, ''],
    ['Queue pending', s.tasks.pending, (s.tasks.running ? s.tasks.running + ' running · ' : '') + s.tasks.failed + ' failed · ' + s.tasks.done + ' done'],
    ['Today: applications', t.applicants + ' / ' + caps.applicants, 'ramp day ' + s.pacing.rampDay, t.applicants, caps.applicants],
    ['Today: profiles', t.profiles + ' / ' + caps.profiles, 'hour: ' + w.hourCount + ' actions', t.profiles, caps.profiles],
  ].map(([l, v, sub, n, d]) => '<div class="tile"><div class="label">' + esc(l) + '</div><div class="value">' + esc(typeof v === 'number' ? fmt(v) : v) + '</div><div class="sub">' + esc(sub) + '</div>' + (d ? '<div class="meter"><i style="width:' + Math.min(100, Math.round(100 * n / d)) + '%"></i></div>' : '') + '</div>').join('');
  const tb = $('#jobs tbody'); const sel = $('#fJob'); const cur = sel.value;
  tb.innerHTML = s.jobRows.map((j) => { const p = j.syncProgress; const total = p?.totalReported ?? j.applicantCount; return '<tr><td><strong>' + esc(j.title) + '</strong><div class="tiny">' + esc([j.location, j.workplaceType].filter(Boolean).join(' · ')) + ' · id ' + j.jobId + '</div></td><td><span class="badge ' + esc(j.status) + '">' + esc(j.status) + '</span></td><td>' + meter(j.applicantsStored, total) + (p && !p.complete ? '<div class="tiny">list sync in progress</div>' : p?.complete ? '<div class="tiny">' + (p.totalReported && j.applicantsStored < p.totalReported * 0.98 ? 'list complete, ' + (p.totalReported - j.applicantsStored) + ' not shown by LinkedIn' + (p.sweeps ? ' after ' + p.sweeps + ' sweep' + (p.sweeps > 1 ? 's' : '') : ', sweep pending') : 'list complete') + '</div>' : '') + '</td><td>' + meter(j.detailsFetched, j.applicantsStored) + '</td><td>' + meter(j.resumesStored, j.applicantsStored) + '</td><td>' + meter(j.profilesFetched, j.applicantsStored) + '</td><td><button onclick="pickJob(\'' + j.jobId + '\')">Show</button></td></tr>'; }).join('') || '<tr><td colspan="7" class="muted">No jobs yet, run jobs_sync.</td></tr>';
  sel.innerHTML = '<option value="">All jobs</option>' + s.jobRows.map((j) => '<option value="' + j.jobId + '">' + esc(j.title) + ' (' + fmt(j.applicantsStored) + ')</option>').join(''); sel.value = cur;
  $('#events').innerHTML = s.events.map((e) => '<li class="' + esc(e.level) + '"><span class="tiny">' + esc(new Date(e.ts).toLocaleTimeString()) + '</span> · <strong>' + esc(e.kind) + '</strong> ' + esc(e.message) + '</li>').join('') || '<li class="muted">No events yet.</li>';
  $('#refreshed').textContent = 'updated ' + new Date().toLocaleTimeString();
}

function filters() { const q = new URLSearchParams(); const j = $('#fJob').value; if (j) q.set('jobId', j); const s = $('#fSearch').value.trim(); if (s) q.set('search', s); if ($('#fResume').checked) q.set('hasResume', 'true'); if ($('#fProfile').checked) q.set('hasProfile', 'true'); if ($('#fDetail').checked) q.set('hasDetail', 'true'); const r = $('#fRating').value; if (r) q.set('rating', r); return q; }

async function loadApplicants() {
  const q = filters(); q.set('limit', LIMIT); q.set('offset', offset); q.set('orderBy', 'listSyncedAt');
  const r = await (await fetch('/api/applicants?' + q)).json(); lastTotal = r.total;
  $('#applicants tbody').innerHTML = r.items.map((a) => '<tr class="clickable" onclick="openApplicant(\'' + a.applicationId + '\')"><td><strong>' + esc(a.fullName) + '</strong>' + (a.email ? '<div class="tiny">' + esc(a.email) + '</div>' : '') + '</td><td class="muted">' + esc((a.headline || '').slice(0, 90)) + '</td><td class="muted">' + esc(a.location || '') + '</td><td class="num">' + esc(date(a.appliedAt)) + '</td><td>' + (a.rating && a.rating !== 'unknown' ? '<span class="badge ' + esc(a.rating) + '">' + esc(a.rating.replace(/_/g, ' ')) + '</span>' : '<span class="dash">–</span>') + '</td><td>' + (a.detailFetchedAt ? '<span class="check">✓</span>' : '<span class="dash">–</span>') + '</td><td>' + (a.resumeUrl ? '<a href="' + a.resumeUrl + '" target="_blank" onclick="event.stopPropagation()">open</a>' : a.hasResume === false ? '<span class="dash">none</span>' : '<span class="dash">–</span>') + '</td><td>' + (a.profileFetchedAt ? '<span class="check">✓</span>' : '<span class="dash">–</span>') + '</td><td>' + (a.profileUrl ? '<a href="' + esc(a.profileUrl) + '" target="_blank" onclick="event.stopPropagation()">LinkedIn</a>' : '<span class="dash">–</span>') + '</td></tr>').join('') || '<tr><td colspan="9" class="muted">No applicants match.</td></tr>';
  $('#count').textContent = fmt(offset + 1) + '–' + fmt(Math.min(offset + LIMIT, r.total)) + ' of ' + fmt(r.total);
  $('#prev').disabled = offset === 0; $('#next').disabled = offset + LIMIT >= r.total;
}

async function openApplicant(id) {
  const a = await (await fetch('/api/applicant/' + id)).json();
  const p = a.profile;
  const exp = p && p.experience ? p.experience.slice(0, 8).map((e) => '<li><strong>' + esc(e.title) + '</strong>' + (e.company ? ', ' + esc(e.company) : '') + (e.dates && e.dates.text ? ' <span class="tiny">' + esc(e.dates.text) + '</span>' : '') + '</li>').join('') : '';
  const edu = p && p.education ? p.education.slice(0, 4).map((e) => '<li>' + esc(e.school) + (e.degree ? ', ' + esc(e.degree) : '') + '</li>').join('') : '';
  $('#drawerBody').innerHTML = '<h3>' + esc(a.fullName) + '</h3><div class="muted">' + esc(a.headline || '') + '</div><div class="tiny">' + esc([a.location, a.jobTitle].filter(Boolean).join(' · ')) + '</div>'
    + '<dl class="kv"><dt>Applied</dt><dd>' + esc(date(a.appliedAt)) + '</dd><dt>Rating</dt><dd>' + esc(a.rating || '–') + '</dd><dt>Qualifications</dt><dd>' + esc(a.qualifications || '–') + '</dd><dt>Email</dt><dd>' + (a.email ? '<a href="mailto:' + esc(a.email) + '">' + esc(a.email) + '</a>' : '–') + '</dd><dt>Phone</dt><dd>' + esc(a.phone || '–') + '</dd><dt>LinkedIn</dt><dd>' + (a.profileUrl ? '<a href="' + esc(a.profileUrl) + '" target="_blank">' + esc(a.profileUrl) + '</a>' : '–') + '</dd><dt>Resume</dt><dd>' + (a.resumeUrl ? '<a href="' + a.resumeUrl + '" target="_blank">' + esc(a.resumeFileName || 'open file') + '</a>' : a.hasResume === false ? 'none attached' : 'not fetched yet') + '</dd><dt>Application id</dt><dd>' + esc(a.applicationId) + '</dd></dl>'
    + (a.screeningAnswers && a.screeningAnswers.length ? '<h4>Screening answers</h4><ul>' + a.screeningAnswers.map((s) => '<li><strong>' + esc(s.question) + '</strong><br>' + esc(s.answer) + '</li>').join('') + '</ul>' : '')
    + (p ? '<h4>Profile' + (p.about ? '</h4><p class="muted">' + esc(p.about.slice(0, 600)) + '</p>' : '</h4>') + (exp ? '<h5>Experience</h5><ul>' + exp + '</ul>' : '') + (edu ? '<h5>Education</h5><ul>' + edu + '</ul>' : '') + (p.skills && p.skills.length ? '<h5>Skills</h5><div class="muted">' + esc(p.skills.slice(0, 40).join(', ')) + '</div>' : '') : '<p class="tiny">Profile not fetched yet.</p>')
    + (a.resumeText ? '<h4>Resume text <span class="tiny">(' + fmt(a.resumeTextChars) + ' chars)</span></h4><pre>' + esc(a.resumeText.slice(0, 6000)) + '</pre>' : '');
  $('#drawer').classList.add('open');
}
function closeDrawer() { $('#drawer').classList.remove('open'); }
function pickJob(id) { $('#fJob').value = id; offset = 0; loadApplicants(); document.querySelector('#applicants').scrollIntoView({ behavior: 'smooth' }); }
async function doExport(format) { const q = filters(); q.set('format', format); const r = await (await fetch('/api/export?' + q)).json(); if (r.url) window.open(r.url, '_blank'); }

for (const id of ['fJob', 'fResume', 'fProfile', 'fDetail', 'fRating']) $('#' + id).addEventListener('change', () => { offset = 0; loadApplicants(); });
let t; $('#fSearch').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { offset = 0; loadApplicants(); }, 300); });
$('#prev').onclick = () => { offset = Math.max(0, offset - LIMIT); loadApplicants(); };
$('#next').onclick = () => { offset += LIMIT; loadApplicants(); };
$('#exportCsv').onclick = () => doExport('csv'); $('#exportJson').onclick = () => doExport('json');
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
async function refresh() { try { await Promise.all([loadSummary(), loadApplicants()]); } catch (e) { $('#refreshed').textContent = 'refresh failed: ' + e; } }
refresh(); setInterval(() => { if ($('#auto').checked) refresh(); }, 15000);
</script>
</body>
</html>`;
