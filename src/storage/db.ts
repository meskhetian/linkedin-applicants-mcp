import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  Applicant,
  ApplicantRating,
  ApplicantSyncProgress,
  JobPosting,
  JobStatus,
  Task,
  TaskCounts,
  TaskPayload,
  TaskStatus,
  TaskType,
} from '../types.js';

const SCHEMA_VERSION = 1;

const DEFAULT_PRIORITY: Record<TaskType, number> = {
  sync_jobs: 100,
  sync_applicants: 80,
  fetch_application: 50,
  fetch_profile: 40,
};

type Row = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

function j(v: unknown): string | null {
  return v === undefined || v === null ? null : JSON.stringify(v);
}

function pj<T>(v: unknown): T | undefined {
  if (v === null || v === undefined) return undefined;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return undefined;
  }
}

function str(v: unknown): string | undefined {
  return v === null || v === undefined ? undefined : String(v);
}

function num(v: unknown): number | undefined {
  return v === null || v === undefined ? undefined : Number(v);
}

function bool(v: unknown): boolean | undefined {
  return v === null || v === undefined ? undefined : Number(v) === 1;
}

export interface ApplicantFilter {
  jobId?: string;
  search?: string; // FTS over name/headline/resume/profile text
  hasResume?: boolean;
  hasProfile?: boolean;
  hasDetail?: boolean;
  rating?: ApplicantRating;
  limit?: number;
  offset?: number;
  orderBy?: 'appliedAt' | 'fullName' | 'listSyncedAt';
  order?: 'asc' | 'desc';
}

export interface TaskFilter {
  type?: TaskType;
  status?: TaskStatus;
  jobId?: string;
  limit?: number;
}

/**
 * SQLite storage (node:sqlite, WAL). One instance per process. Safe for two processes
 * (MCP server + standalone worker) to share via WAL; only the lock holder should drive the browser.
 */
export class Db {
  readonly db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();

  constructor(readonly dbPath: string) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private prep(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        company_name TEXT,
        location TEXT,
        workplace_type TEXT,
        status TEXT NOT NULL DEFAULT 'unknown',
        posted_at TEXT,
        closed_at TEXT,
        applicant_count INTEGER,
        url TEXT NOT NULL,
        raw TEXT,
        synced_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS applicants (
        application_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
        full_name TEXT NOT NULL,
        headline TEXT,
        location TEXT,
        profile_url TEXT,
        profile_urn TEXT,
        applied_at TEXT,
        rating TEXT,
        is_viewed INTEGER,
        email TEXT,
        phone TEXT,
        screening_answers TEXT,
        has_resume INTEGER,
        resume_path TEXT,
        resume_file_name TEXT,
        resume_text TEXT,
        profile_path TEXT,
        profile_json TEXT,
        profile_text TEXT,
        detail_fetched_at TEXT,
        profile_fetched_at TEXT,
        list_synced_at TEXT NOT NULL,
        raw TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_applicants_job ON applicants(job_id);
      CREATE INDEX IF NOT EXISTS idx_applicants_profile_url ON applicants(profile_url);

      CREATE VIRTUAL TABLE IF NOT EXISTS applicants_fts USING fts5(
        application_id UNINDEXED, full_name, headline, resume_text, profile_text,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 50,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        last_error TEXT,
        run_after TEXT,
        job_id TEXT,
        application_id TEXT,
        dedupe_key TEXT,
        shuffle REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status_prio ON tasks(status, priority DESC, shuffle);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_dedupe ON tasks(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running');

      CREATE TABLE IF NOT EXISTS counters (
        kind TEXT NOT NULL,
        bucket TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (kind, bucket)
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        level TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    `);
    const v = this.prep('SELECT value FROM meta WHERE key = ?').get('schema_version') as Row | undefined;
    if (!v) {
      this.prep('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    }
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  // ---------------- settings ----------------

  getSetting<T>(key: string): T | undefined {
    const row = this.prep('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return row ? pj<T>(row.value) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.prep(
      'INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(key, JSON.stringify(value), nowIso());
  }

  deleteSetting(key: string): void {
    this.prep('DELETE FROM settings WHERE key = ?').run(key);
  }

  // ---------------- counters ----------------

  /** bucket: 'YYYY-MM-DD' for daily, 'YYYY-MM-DDTHH' for hourly */
  incrementCounter(kind: string, bucket: string, by = 1): number {
    this.prep(
      'INSERT INTO counters(kind, bucket, count) VALUES (?, ?, ?) ON CONFLICT(kind, bucket) DO UPDATE SET count = count + excluded.count',
    ).run(kind, bucket, by);
    return this.getCounter(kind, bucket);
  }

  getCounter(kind: string, bucket: string): number {
    const row = this.prep('SELECT count FROM counters WHERE kind = ? AND bucket = ?').get(kind, bucket) as Row | undefined;
    return row ? Number(row.count) : 0;
  }

  // ---------------- events ----------------

  addEvent(level: string, kind: string, message: string, data?: unknown): void {
    this.prep('INSERT INTO events(ts, level, kind, message, data) VALUES (?, ?, ?, ?, ?)').run(nowIso(), level, kind, message, j(data));
    // keep the table bounded
    this.prep('DELETE FROM events WHERE id < (SELECT MAX(id) FROM events) - 5000').run();
  }

  recentEvents(limit = 20, kind?: string): Array<{ ts: string; level: string; kind: string; message: string; data?: unknown }> {
    const rows = (
      kind
        ? this.prep('SELECT * FROM events WHERE kind = ? ORDER BY id DESC LIMIT ?').all(kind, limit)
        : this.prep('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit)
    ) as Row[];
    return rows.map((r) => ({
      ts: String(r.ts),
      level: String(r.level),
      kind: String(r.kind),
      message: String(r.message),
      data: pj(r.data),
    }));
  }

  // ---------------- jobs ----------------

  upsertJob(job: JobPosting): void {
    this.prep(
      `INSERT INTO jobs(job_id, title, company_name, location, workplace_type, status, posted_at, closed_at, applicant_count, url, raw, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         title = excluded.title,
         company_name = COALESCE(excluded.company_name, jobs.company_name),
         location = COALESCE(excluded.location, jobs.location),
         workplace_type = COALESCE(excluded.workplace_type, jobs.workplace_type),
         status = CASE WHEN excluded.status = 'unknown' THEN jobs.status ELSE excluded.status END,
         posted_at = COALESCE(excluded.posted_at, jobs.posted_at),
         closed_at = COALESCE(excluded.closed_at, jobs.closed_at),
         applicant_count = COALESCE(excluded.applicant_count, jobs.applicant_count),
         url = excluded.url,
         raw = COALESCE(excluded.raw, jobs.raw),
         synced_at = excluded.synced_at`,
    ).run(
      job.jobId,
      job.title,
      job.companyName ?? null,
      job.location ?? null,
      job.workplaceType ?? null,
      job.status,
      job.postedAt ?? null,
      job.closedAt ?? null,
      job.applicantCount ?? null,
      job.url,
      j(job.raw),
      job.syncedAt,
    );
  }

  getJob(jobId: string): JobPosting | undefined {
    const r = this.prep('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as Row | undefined;
    return r ? rowToJob(r) : undefined;
  }

  listJobs(status?: JobStatus | 'all'): Array<JobPosting & { applicantsStored: number; detailsFetched: number; profilesFetched: number; resumesStored: number }> {
    const sql = `
      SELECT j.*,
        (SELECT COUNT(*) FROM applicants a WHERE a.job_id = j.job_id) AS applicants_stored,
        (SELECT COUNT(*) FROM applicants a WHERE a.job_id = j.job_id AND a.detail_fetched_at IS NOT NULL) AS details_fetched,
        (SELECT COUNT(*) FROM applicants a WHERE a.job_id = j.job_id AND a.profile_fetched_at IS NOT NULL) AS profiles_fetched,
        (SELECT COUNT(*) FROM applicants a WHERE a.job_id = j.job_id AND a.resume_path IS NOT NULL) AS resumes_stored
      FROM jobs j ${status && status !== 'all' ? 'WHERE j.status = ?' : ''}
      ORDER BY COALESCE(j.posted_at, j.synced_at) DESC`;
    const rows = (status && status !== 'all' ? this.prep(sql).all(status) : this.prep(sql).all()) as Row[];
    return rows.map((r) => ({
      ...rowToJob(r),
      applicantsStored: Number(r.applicants_stored ?? 0),
      detailsFetched: Number(r.details_fetched ?? 0),
      profilesFetched: Number(r.profiles_fetched ?? 0),
      resumesStored: Number(r.resumes_stored ?? 0),
    }));
  }

  // ---------------- applicants ----------------

  /** Insert or update list-level fields. Never clears detail/profile data. */
  upsertApplicantFromList(a: Applicant): void {
    this.prep(
      `INSERT INTO applicants(application_id, job_id, full_name, headline, location, profile_url, profile_urn, applied_at, rating, is_viewed, has_resume, list_synced_at, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(application_id) DO UPDATE SET
         full_name = CASE WHEN excluded.full_name <> '' THEN excluded.full_name ELSE applicants.full_name END,
         headline = COALESCE(excluded.headline, applicants.headline),
         location = COALESCE(excluded.location, applicants.location),
         profile_url = COALESCE(excluded.profile_url, applicants.profile_url),
         profile_urn = COALESCE(excluded.profile_urn, applicants.profile_urn),
         applied_at = COALESCE(excluded.applied_at, applicants.applied_at),
         rating = COALESCE(excluded.rating, applicants.rating),
         is_viewed = COALESCE(excluded.is_viewed, applicants.is_viewed),
         has_resume = COALESCE(excluded.has_resume, applicants.has_resume),
         list_synced_at = excluded.list_synced_at,
         raw = COALESCE(excluded.raw, applicants.raw)`,
    ).run(
      a.applicationId,
      a.jobId,
      a.fullName,
      a.headline ?? null,
      a.location ?? null,
      a.profileUrl ?? null,
      a.profileUrn ?? null,
      a.appliedAt ?? null,
      a.rating ?? null,
      a.isViewed === undefined ? null : a.isViewed ? 1 : 0,
      a.hasResume === undefined ? null : a.hasResume ? 1 : 0,
      a.listSyncedAt,
      j(a.raw),
    );
    this.refreshFts(a.applicationId);
  }

  updateApplicantDetail(
    applicationId: string,
    d: Partial<
      Pick<
        Applicant,
        | 'fullName'
        | 'headline'
        | 'location'
        | 'profileUrl'
        | 'profileUrn'
        | 'appliedAt'
        | 'rating'
        | 'email'
        | 'phone'
        | 'screeningAnswers'
        | 'hasResume'
        | 'resumePath'
        | 'resumeFileName'
        | 'resumeText'
        | 'raw'
      >
    >,
  ): void {
    this.prep(
      `UPDATE applicants SET
         full_name = COALESCE(?, full_name),
         headline = COALESCE(?, headline),
         location = COALESCE(?, location),
         profile_url = COALESCE(?, profile_url),
         profile_urn = COALESCE(?, profile_urn),
         applied_at = COALESCE(?, applied_at),
         rating = COALESCE(?, rating),
         email = COALESCE(?, email),
         phone = COALESCE(?, phone),
         screening_answers = COALESCE(?, screening_answers),
         has_resume = COALESCE(?, has_resume),
         resume_path = COALESCE(?, resume_path),
         resume_file_name = COALESCE(?, resume_file_name),
         resume_text = COALESCE(?, resume_text),
         raw = COALESCE(?, raw),
         detail_fetched_at = ?
       WHERE application_id = ?`,
    ).run(
      d.fullName ?? null,
      d.headline ?? null,
      d.location ?? null,
      d.profileUrl ?? null,
      d.profileUrn ?? null,
      d.appliedAt ?? null,
      d.rating ?? null,
      d.email ?? null,
      d.phone ?? null,
      j(d.screeningAnswers),
      d.hasResume === undefined ? null : d.hasResume ? 1 : 0,
      d.resumePath ?? null,
      d.resumeFileName ?? null,
      d.resumeText ?? null,
      j(d.raw),
      nowIso(),
      applicationId,
    );
    this.refreshFts(applicationId);
  }

  /** Stored list rows with their raw card text, for offline re-parsing after a parser fix. */
  rawApplicantRows(jobId?: string): Row[] {
    const sql = 'SELECT application_id, full_name, headline, location, applied_at, is_viewed, detail_fetched_at, raw FROM applicants' + (jobId ? ' WHERE job_id = ?' : '');
    return (jobId ? this.prep(sql).all(jobId) : this.prep(sql).all()) as Row[];
  }

  /** Apply the result of re-parsing a stored list row (name, headline, location, applied date, viewed flag, raw). */
  applyReparsedRow(
    applicationId: string,
    r: { fullName: string; headline: string | null; location: string | null; appliedAt: string | null; isViewed: number | null; raw: unknown },
  ): void {
    this.prep('UPDATE applicants SET full_name = ?, headline = ?, location = ?, applied_at = ?, is_viewed = ?, raw = ? WHERE application_id = ?').run(
      r.fullName,
      r.headline,
      r.location,
      r.appliedAt,
      r.isViewed,
      j(r.raw),
      applicationId,
    );
    this.refreshFts(applicationId);
  }

  /** Undo ratings assigned from list buckets during a run whose bucket parameter turned out to be ignored. */
  clearListRatings(jobId: string, sinceIso: string): number {
    const r = this.prep('UPDATE applicants SET rating = NULL WHERE job_id = ? AND detail_fetched_at IS NULL AND list_synced_at >= ?').run(jobId, sinceIso);
    return Number(r.changes);
  }

  updateApplicantProfile(applicationId: string, profilePath: string, profileJson: unknown, profileText: string): void {
    this.prep(
      `UPDATE applicants SET profile_path = ?, profile_json = ?, profile_text = ?, profile_fetched_at = ? WHERE application_id = ?`,
    ).run(profilePath, JSON.stringify(profileJson), profileText, nowIso(), applicationId);
    this.refreshFts(applicationId);
  }

  private refreshFts(applicationId: string): void {
    const r = this.prep('SELECT application_id, full_name, headline, resume_text, profile_text FROM applicants WHERE application_id = ?').get(
      applicationId,
    ) as Row | undefined;
    if (!r) return;
    this.prep('DELETE FROM applicants_fts WHERE application_id = ?').run(applicationId);
    this.prep('INSERT INTO applicants_fts(application_id, full_name, headline, resume_text, profile_text) VALUES (?, ?, ?, ?, ?)').run(
      applicationId,
      String(r.full_name ?? ''),
      String(r.headline ?? ''),
      String(r.resume_text ?? ''),
      String(r.profile_text ?? ''),
    );
  }

  hasApplicant(applicationId: string): boolean {
    return !!this.prep('SELECT 1 AS x FROM applicants WHERE application_id = ?').get(applicationId);
  }

  getApplicant(applicationId: string): (Applicant & { profile?: unknown }) | undefined {
    const r = this.prep('SELECT * FROM applicants WHERE application_id = ?').get(applicationId) as Row | undefined;
    return r ? rowToApplicant(r, true) : undefined;
  }

  listApplicants(f: ApplicantFilter = {}): { total: number; items: Applicant[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.jobId) {
      where.push('a.job_id = ?');
      params.push(f.jobId);
    }
    if (f.hasResume !== undefined) where.push(f.hasResume ? 'a.resume_path IS NOT NULL' : 'a.resume_path IS NULL');
    if (f.hasProfile !== undefined) where.push(f.hasProfile ? 'a.profile_fetched_at IS NOT NULL' : 'a.profile_fetched_at IS NULL');
    if (f.hasDetail !== undefined) where.push(f.hasDetail ? 'a.detail_fetched_at IS NOT NULL' : 'a.detail_fetched_at IS NULL');
    if (f.rating) {
      where.push('a.rating = ?');
      params.push(f.rating);
    }
    let from = 'applicants a';
    if (f.search && f.search.trim()) {
      from = 'applicants_fts fts JOIN applicants a ON a.application_id = fts.application_id';
      where.push('applicants_fts MATCH ?');
      params.push(toFtsQuery(f.search));
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((this.prep(`SELECT COUNT(*) AS c FROM ${from} ${whereSql}`).get(...(params as never[])) as Row).c);
    const orderCol = f.orderBy === 'fullName' ? 'a.full_name' : f.orderBy === 'listSyncedAt' ? 'a.list_synced_at' : 'a.applied_at';
    const order = f.order === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
    const offset = Math.max(f.offset ?? 0, 0);
    const rows = this.prep(`SELECT a.* FROM ${from} ${whereSql} ORDER BY ${orderCol} ${order} NULLS LAST LIMIT ? OFFSET ?`).all(
      ...(params as never[]),
      limit,
      offset,
    ) as Row[];
    return { total, items: rows.map((r) => rowToApplicant(r, false)) };
  }

  /** Every applicant (full rows incl. resume text + profile JSON), for exports. Streams in id order. */
  *iterateApplicantsFull(jobId?: string): IterableIterator<Applicant & { profile?: unknown }> {
    const rows = (jobId
      ? this.prep('SELECT * FROM applicants WHERE job_id = ? ORDER BY applied_at DESC NULLS LAST, application_id').iterate(jobId)
      : this.prep('SELECT * FROM applicants ORDER BY job_id, applied_at DESC NULLS LAST, application_id').iterate()) as IterableIterator<Row>;
    for (const r of rows) yield rowToApplicant(r, true);
  }

  /** Application ids of applicants of a job whose stored name equals `fullName` (case-insensitive). */
  applicantIdsByName(jobId: string, fullName: string): string[] {
    const rows = this.prep('SELECT application_id FROM applicants WHERE job_id = ? AND lower(full_name) = lower(?)').all(jobId, fullName.trim()) as Row[];
    return rows.map((r) => String(r.application_id));
  }

  countApplicants(jobId?: string): number {
    const r = (jobId
      ? this.prep('SELECT COUNT(*) AS c FROM applicants WHERE job_id = ?').get(jobId)
      : this.prep('SELECT COUNT(*) AS c FROM applicants').get()) as Row;
    return Number(r.c);
  }

  /** All application ids (+ profile url) for a job, cheap projection for enqueueing. */
  listApplicantIds(jobId?: string): Array<{ applicationId: string; jobId: string; profileUrl?: string }> {
    const rows = (jobId
      ? this.prep('SELECT application_id, job_id, profile_url FROM applicants WHERE job_id = ? ORDER BY applied_at DESC NULLS LAST').all(jobId)
      : this.prep('SELECT application_id, job_id, profile_url FROM applicants ORDER BY job_id, applied_at DESC NULLS LAST').all()) as Row[];
    return rows.map((r) => ({ applicationId: String(r.application_id), jobId: String(r.job_id), profileUrl: str(r.profile_url) }));
  }

  /** Application ids for a job matching "missing" criteria (used to enqueue only what is needed). */
  applicantIdsNeeding(jobId: string, what: 'detail' | 'profile' | 'resume'): Array<{ applicationId: string; profileUrl?: string }> {
    const cond =
      what === 'detail'
        ? 'detail_fetched_at IS NULL'
        : what === 'profile'
          ? 'profile_fetched_at IS NULL AND profile_url IS NOT NULL'
          : 'resume_path IS NULL AND (has_resume IS NULL OR has_resume = 1)';
    const rows = this.prep(`SELECT application_id, profile_url FROM applicants WHERE job_id = ? AND ${cond}`).all(jobId) as Row[];
    return rows.map((r) => ({ applicationId: String(r.application_id), profileUrl: str(r.profile_url) }));
  }

  // ---------------- tasks ----------------

  /**
   * Enqueue a task. Returns the task id, or undefined if an identical pending/running task exists (dedupe).
   */
  enqueueTask(payload: TaskPayload, opts: { priority?: number; maxAttempts?: number; runAfter?: string } = {}): number | undefined {
    const dedupe = dedupeKey(payload);
    const existing = this.prep("SELECT id FROM tasks WHERE dedupe_key = ? AND status IN ('pending','running')").get(dedupe) as Row | undefined;
    if (existing) return undefined;
    const ts = nowIso();
    const { jobId, applicationId } = idsFromPayload(payload);
    const r = this.prep(
      `INSERT INTO tasks(type, payload, status, priority, attempts, max_attempts, run_after, job_id, application_id, dedupe_key, shuffle, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      payload.type,
      JSON.stringify(payload),
      opts.priority ?? DEFAULT_PRIORITY[payload.type],
      opts.maxAttempts ?? 3,
      opts.runAfter ?? null,
      jobId ?? null,
      applicationId ?? null,
      dedupe,
      Math.random(),
      ts,
      ts,
    );
    return Number(r.lastInsertRowid);
  }

  /** Next eligible pending task: highest priority, then shuffled (if randomize) or oldest. */
  nextTask(randomize: boolean, allowedTypes?: TaskType[]): Task | undefined {
    const now = nowIso();
    const typeSql = allowedTypes && allowedTypes.length ? `AND type IN (${allowedTypes.map(() => '?').join(',')})` : '';
    const sql = `SELECT * FROM tasks WHERE status = 'pending' AND (run_after IS NULL OR run_after <= ?) ${typeSql}
                 ORDER BY priority DESC, ${randomize ? 'shuffle' : 'id'} ASC LIMIT 1`;
    const r = this.prep(sql).get(now, ...((allowedTypes ?? []) as never[])) as Row | undefined;
    return r ? rowToTask(r) : undefined;
  }

  /** Number of pending tasks eligible now, grouped by type. */
  pendingByType(): Partial<Record<TaskType, number>> {
    const rows = this.prep("SELECT type, COUNT(*) AS c FROM tasks WHERE status = 'pending' GROUP BY type").all() as Row[];
    const out: Partial<Record<TaskType, number>> = {};
    for (const r of rows) out[String(r.type) as TaskType] = Number(r.c);
    return out;
  }

  markTaskRunning(id: number): void {
    const ts = nowIso();
    this.prep("UPDATE tasks SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, id);
  }

  markTaskDone(id: number): void {
    const ts = nowIso();
    this.prep("UPDATE tasks SET status = 'done', finished_at = ?, updated_at = ?, last_error = NULL WHERE id = ?").run(ts, ts, id);
  }

  /** Fails the task; if attempts remain it goes back to pending with a run_after backoff. */
  markTaskFailed(id: number, error: string, opts: { retry: boolean; backoffMs?: number }): 'retrying' | 'failed' {
    const ts = nowIso();
    const row = this.prep('SELECT attempts, max_attempts FROM tasks WHERE id = ?').get(id) as Row | undefined;
    if (!row) return 'failed';
    const canRetry = opts.retry && Number(row.attempts) < Number(row.max_attempts);
    if (canRetry) {
      const runAfter = new Date(Date.now() + (opts.backoffMs ?? 60_000)).toISOString();
      this.prep("UPDATE tasks SET status = 'pending', last_error = ?, run_after = ?, updated_at = ?, shuffle = ? WHERE id = ?").run(
        error.slice(0, 2000),
        runAfter,
        ts,
        Math.random(),
        id,
      );
      return 'retrying';
    }
    this.prep("UPDATE tasks SET status = 'failed', last_error = ?, finished_at = ?, updated_at = ? WHERE id = ?").run(error.slice(0, 2000), ts, ts, id);
    return 'failed';
  }

  /** Rewrite a task's payload in place (e.g. advance sync_applicants.startOffset between chunks). */
  updateTaskPayload(id: number, payload: TaskPayload): void {
    this.prep('UPDATE tasks SET payload = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(payload), nowIso(), id);
  }

  // ---------------- applicant list sync progress ----------------

  getSyncProgress(jobId: string): ApplicantSyncProgress | undefined {
    return this.getSetting<ApplicantSyncProgress>(`sync_progress:${jobId}`);
  }

  setSyncProgress(p: ApplicantSyncProgress): void {
    this.setSetting(`sync_progress:${p.jobId}`, p);
  }

  clearSyncProgress(jobId: string): void {
    this.deleteSetting(`sync_progress:${jobId}`);
  }

  /** Put a running task back to pending without counting an attempt (e.g. checkpoint / deferred / shutdown). */
  requeueTask(id: number, runAfter?: string, note?: string): void {
    const ts = nowIso();
    // A task cancelled while it ran stays cancelled; its own requeue must not bring it back.
    this.prep(
      "UPDATE tasks SET status = 'pending', attempts = MAX(attempts - 1, 0), run_after = ?, last_error = COALESCE(?, last_error), updated_at = ? WHERE id = ? AND status <> 'cancelled'",
    ).run(runAfter ?? null, note ?? null, ts, id);
  }

  taskStatus(id: number): TaskStatus | undefined {
    const row = this.prep('SELECT status FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? (String(row.status) as TaskStatus) : undefined;
  }

  /** On startup: any 'running' tasks are stale (previous process died). */
  resetStaleRunning(): number {
    const r = this.prep("UPDATE tasks SET status = 'pending', attempts = MAX(attempts - 1, 0), updated_at = ? WHERE status = 'running'").run(nowIso());
    return Number(r.changes);
  }

  /** Cancel pending tasks and mark running ones cancelled; the worker stops a running list sync at its next page. */
  cancelTasks(f: { type?: TaskType; jobId?: string; applicationId?: string; ids?: number[] } = {}): number {
    const where: string[] = ["status IN ('pending', 'running')"];
    const params: unknown[] = [];
    if (f.type) {
      where.push('type = ?');
      params.push(f.type);
    }
    if (f.jobId) {
      where.push('job_id = ?');
      params.push(f.jobId);
    }
    if (f.applicationId) {
      where.push('application_id = ?');
      params.push(f.applicationId);
    }
    if (f.ids && f.ids.length) {
      where.push(`id IN (${f.ids.map(() => '?').join(',')})`);
      params.push(...f.ids);
    }
    const r = this.prep(`UPDATE tasks SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE ${where.join(' AND ')}`).run(
      nowIso(),
      nowIso(),
      ...(params as never[]),
    );
    return Number(r.changes);
  }

  retryFailedTasks(f: { type?: TaskType; jobId?: string } = {}): number {
    const where: string[] = ["status = 'failed'"];
    const params: unknown[] = [];
    if (f.type) {
      where.push('type = ?');
      params.push(f.type);
    }
    if (f.jobId) {
      where.push('job_id = ?');
      params.push(f.jobId);
    }
    const r = this.prep(
      `UPDATE tasks SET status = 'pending', attempts = 0, run_after = NULL, finished_at = NULL, updated_at = ?, shuffle = abs(random()) / 9223372036854775807.0 WHERE ${where.join(' AND ')}`,
    ).run(nowIso(), ...(params as never[]));
    return Number(r.changes);
  }

  taskCounts(): TaskCounts {
    const rows = this.prep('SELECT type, status, COUNT(*) AS c FROM tasks GROUP BY type, status').all() as Row[];
    const out: TaskCounts = {
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
      byType: { sync_jobs: {}, sync_applicants: {}, fetch_application: {}, fetch_profile: {} },
    };
    for (const r of rows) {
      const t = String(r.type) as TaskType;
      const s = String(r.status) as TaskStatus;
      const c = Number(r.c);
      out[s] = (out[s] ?? 0) + c;
      out.byType[t] ??= {};
      out.byType[t][s] = c;
    }
    return out;
  }

  listTasks(f: TaskFilter = {}): Task[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.type) {
      where.push('type = ?');
      params.push(f.type);
    }
    if (f.status) {
      where.push('status = ?');
      params.push(f.status);
    }
    if (f.jobId) {
      where.push('job_id = ?');
      params.push(f.jobId);
    }
    const rows = this.prep(
      `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`,
    ).all(...(params as never[]), Math.min(f.limit ?? 50, 500)) as Row[];
    return rows.map(rowToTask);
  }

  getTask(id: number): Task | undefined {
    const r = this.prep('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToTask(r) : undefined;
  }

  /** Remove done/cancelled tasks older than N days to keep the table small. */
  pruneTasks(olderThanDays = 30): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const r = this.prep("DELETE FROM tasks WHERE status IN ('done','cancelled') AND finished_at < ?").run(cutoff);
    return Number(r.changes);
  }
}

// ---------------- helpers ----------------

export function dedupeKey(p: TaskPayload): string {
  switch (p.type) {
    case 'sync_jobs':
      return 'sync_jobs';
    case 'sync_applicants':
      return `sync_applicants:${p.jobId}`;
    case 'fetch_application':
      return `fetch_application:${p.applicationId}`;
    case 'fetch_profile':
      return `fetch_profile:${p.applicationId}`;
  }
}

function idsFromPayload(p: TaskPayload): { jobId?: string; applicationId?: string } {
  switch (p.type) {
    case 'sync_jobs':
      return {};
    case 'sync_applicants':
      return { jobId: p.jobId };
    case 'fetch_application':
    case 'fetch_profile':
      return { jobId: p.jobId, applicationId: p.applicationId };
  }
}

/** Turn free text into a safe FTS5 query: quoted prefix terms ANDed together. */
export function toFtsQuery(input: string): string {
  const terms = input
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, '').trim())
    .filter(Boolean);
  if (!terms.length) return '""';
  return terms.map((t) => `"${t}"*`).join(' ');
}

function rowToJob(r: Row): JobPosting {
  return {
    jobId: String(r.job_id),
    title: String(r.title),
    companyName: str(r.company_name),
    location: str(r.location),
    workplaceType: str(r.workplace_type),
    status: (str(r.status) as JobStatus) ?? 'unknown',
    postedAt: str(r.posted_at),
    closedAt: str(r.closed_at),
    applicantCount: num(r.applicant_count),
    url: String(r.url),
    raw: pj(r.raw),
    syncedAt: String(r.synced_at),
  };
}

function rowToApplicant(r: Row, full: boolean): Applicant & { profile?: unknown } {
  const a: Applicant & { profile?: unknown } = {
    applicationId: String(r.application_id),
    jobId: String(r.job_id),
    fullName: String(r.full_name),
    headline: str(r.headline),
    location: str(r.location),
    profileUrl: str(r.profile_url),
    profileUrn: str(r.profile_urn),
    appliedAt: str(r.applied_at),
    rating: str(r.rating) as ApplicantRating | undefined,
    isViewed: bool(r.is_viewed),
    email: str(r.email),
    phone: str(r.phone),
    screeningAnswers: pj(r.screening_answers),
    hasResume: bool(r.has_resume),
    resumePath: str(r.resume_path),
    resumeFileName: str(r.resume_file_name),
    profilePath: str(r.profile_path),
    detailFetchedAt: str(r.detail_fetched_at),
    profileFetchedAt: str(r.profile_fetched_at),
    listSyncedAt: String(r.list_synced_at),
  };
  if (full) {
    a.resumeText = str(r.resume_text);
    a.profile = pj(r.profile_json);
    a.raw = pj(r.raw);
  }
  return a;
}

function rowToTask(r: Row): Task {
  return {
    id: Number(r.id),
    type: String(r.type) as TaskType,
    payload: JSON.parse(String(r.payload)) as TaskPayload,
    status: String(r.status) as TaskStatus,
    priority: Number(r.priority),
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    lastError: str(r.last_error),
    runAfter: str(r.run_after),
    jobId: str(r.job_id),
    applicationId: str(r.application_id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    startedAt: str(r.started_at),
    finishedAt: str(r.finished_at),
  };
}
