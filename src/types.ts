/**
 * Shared domain types. Every module imports from here; keep this file dependency-free.
 */

// ---------- Jobs ----------

export type JobStatus = 'open' | 'closed' | 'paused' | 'draft' | 'unknown';

export interface JobPosting {
  /** LinkedIn numeric job id, e.g. "4123456789" */
  jobId: string;
  title: string;
  companyName?: string;
  location?: string;
  workplaceType?: string; // On-site | Hybrid | Remote
  status: JobStatus;
  postedAt?: string; // ISO 8601
  closedAt?: string; // ISO 8601
  /** Applicant count as reported on the hiring dashboard (may lag) */
  applicantCount?: number;
  /** Canonical applicants URL: https://www.linkedin.com/hiring/jobs/<jobId>/applicants/ */
  url: string;
  /** Raw captured JSON (Voyager) for forward-compat / debugging */
  raw?: unknown;
  syncedAt: string; // ISO 8601
}

// ---------- Applicants ----------

export type ApplicantRating = 'good_fit' | 'maybe' | 'not_a_fit' | 'unrated' | 'unknown';

export interface ScreeningAnswer {
  question: string;
  answer: string;
}

export interface Applicant {
  /** LinkedIn application id (from the applicant detail URL) */
  applicationId: string;
  jobId: string;
  fullName: string;
  headline?: string;
  location?: string;
  /** Normalized https://www.linkedin.com/in/<vanity>/ */
  profileUrl?: string;
  profileUrn?: string;
  appliedAt?: string; // ISO 8601
  rating?: ApplicantRating;
  isViewed?: boolean;
  /** From the application detail page (contact info shared by applicant) */
  email?: string;
  phone?: string;
  screeningAnswers?: ScreeningAnswer[];
  hasResume?: boolean;
  /** Absolute local path of downloaded resume */
  resumePath?: string;
  resumeFileName?: string;
  /** Extracted plain text of the resume (for search / LLM review) */
  resumeText?: string;
  /** Absolute local path to profile.json once the profile was fetched */
  profilePath?: string;
  detailFetchedAt?: string; // ISO
  profileFetchedAt?: string; // ISO
  listSyncedAt: string; // ISO
  raw?: unknown;
}

export interface ApplicationDetailResult {
  applicationId: string;
  jobId: string;
  fullName?: string;
  headline?: string;
  location?: string;
  profileUrl?: string;
  profileUrn?: string;
  appliedAt?: string;
  rating?: ApplicantRating;
  email?: string;
  phone?: string;
  screeningAnswers: ScreeningAnswer[];
  hasResume: boolean;
  resumePath?: string;
  resumeFileName?: string;
  /** Anything else we scraped that has no dedicated column */
  extra?: Record<string, unknown>;
  raw?: unknown;
}

// ---------- Profiles ----------

export interface DateRange {
  /** ISO-ish "YYYY-MM" or "YYYY"; undefined when unknown */
  start?: string;
  end?: string; // undefined when "Present"
  isCurrent?: boolean;
  /** Original text as displayed, e.g. "Jan 2020 - Present · 3 yrs" */
  text?: string;
}

export interface ExperienceItem {
  title: string;
  company?: string;
  companyUrl?: string;
  employmentType?: string; // Full-time, Contract, ...
  location?: string;
  locationType?: string; // Remote / Hybrid / On-site
  dates?: DateRange;
  description?: string;
  skills?: string[];
}

export interface EducationItem {
  school: string;
  schoolUrl?: string;
  degree?: string;
  fieldOfStudy?: string;
  dates?: DateRange;
  grade?: string;
  activities?: string;
  description?: string;
}

export interface CertificationItem {
  name: string;
  issuer?: string;
  issuedAt?: string;
  expiresAt?: string;
  credentialId?: string;
  credentialUrl?: string;
}

export interface LanguageItem {
  name: string;
  proficiency?: string;
}

export interface ProjectItem {
  name: string;
  dates?: DateRange;
  description?: string;
  url?: string;
}

export interface GenericItem {
  title: string;
  subtitle?: string;
  dates?: DateRange;
  description?: string;
  url?: string;
}

export interface ContactInfo {
  email?: string;
  phone?: string;
  websites?: string[];
  twitter?: string;
  address?: string;
  birthday?: string;
  im?: string[];
}

export interface Profile {
  profileUrl: string;
  vanityName?: string;
  urn?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  location?: string;
  industry?: string;
  about?: string;
  photoUrl?: string;
  backgroundUrl?: string;
  openToWork?: boolean;
  connections?: string; // "500+"
  followers?: number;
  contact?: ContactInfo;
  experience: ExperienceItem[];
  education: EducationItem[];
  skills: string[];
  certifications: CertificationItem[];
  languages: LanguageItem[];
  projects: ProjectItem[];
  honors: GenericItem[];
  volunteering: GenericItem[];
  publications: GenericItem[];
  courses: GenericItem[];
  /** Local path of the "Save to PDF" export, if requested */
  savedPdfPath?: string;
  /** Local path of a full-page screenshot, if taken */
  screenshotPath?: string;
  /** Which strategy produced most of the data */
  source: 'voyager' | 'dom' | 'mixed';
  fetchedAt: string;
  raw?: unknown;
}

// ---------- Queue ----------

export type ApplicantListSort = 'DateApplied' | 'QualificationMatch' | 'FirstName' | 'LastName';

export type TaskType = 'sync_jobs' | 'sync_applicants' | 'fetch_application' | 'fetch_profile';

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export type TaskPayload =
  | { type: 'sync_jobs'; includeClosed: boolean }
  | {
      type: 'sync_applicants';
      jobId: string;
      /** Pages (25 applicants each) to process per worker run before requeueing itself with the next offset. */
      pagesPerRun?: number;
      /** Offset to resume from (multiple of 25). Worker rewrites this as the crawl advances. */
      startOffset?: number;
      /** Include applicants LinkedIn hides by default under the Ratings filter ("Not a fit"). Default true. */
      includeNotAFit?: boolean;
      /** List order. LinkedIn's date order shifts between page loads and drops a few percent of applicants; a sweep uses another order. */
      sort?: ApplicantListSort;
      /** Second pass over an already complete list with a different order, to pick up applicants the first pass never saw. */
      sweep?: boolean;
      /** Stop after this many pages in total (undefined = whole list). */
      maxPages?: number;
    }
  | {
      type: 'fetch_application';
      jobId: string;
      applicationId: string;
      downloadResume: boolean;
      /** When set, the runner enqueues a fetch_profile task for this applicant once the profile URL is known. */
      thenProfile?: { depth: ProfileDepth; savePdf: boolean };
    }
  | {
      type: 'fetch_profile';
      jobId: string;
      applicationId: string;
      profileUrl: string;
      depth: ProfileDepth;
      savePdf: boolean;
    };

export type ProfileDepth = 'basic' | 'full';

export interface Task {
  id: number;
  type: TaskType;
  payload: TaskPayload;
  status: TaskStatus;
  /** Higher runs first. sync_jobs=100, sync_applicants=80, fetch_application=50, fetch_profile=40 by default */
  priority: number;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  /** ISO; task is not eligible before this time */
  runAfter?: string;
  jobId?: string;
  applicationId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface TaskCounts {
  pending: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  byType: Record<TaskType, Partial<Record<TaskStatus, number>>>;
}

/** Persisted per-job progress of the applicant list crawl (settings key `sync_progress:<jobId>`). */
export interface ApplicantSyncProgress {
  jobId: string;
  /** Next ?start= offset to visit */
  nextOffset: number;
  pagesVisited: number;
  /** Total the dashboard reported ("N applicants"), if found */
  totalReported?: number;
  /** Applicants stored so far for this job */
  stored: number;
  complete: boolean;
  /** Set when the list stopped returning cards before totalReported was reached (possible offset cap) */
  stoppedEarly?: boolean;
  /** Hiring Pro: consecutive runs that ended on a page rendering no cards (the list gives up after three) */
  blankRuns?: number;
  /** Sweeps (second passes with a different order) completed for this list */
  sweeps?: number;
  /** Which list mechanics were detected: offset URL, numbered page buttons, or infinite scroll */
  paginationMode?: 'offset' | 'buttons' | 'scroll';
  /** Which dashboard UI this job renders: legacy Ember list (offset pages, r= rating buckets) or the 2026 "Hiring Pro" list (infinite scroll, rating=ALL) */
  uiVariant?: 'legacy' | 'hiring_pro';
  /** Legacy: index into the rating buckets being crawled (each bucket is paginated separately) */
  bucketIndex?: number;
  /** Legacy: per-bucket totals reported by the dashboard */
  bucketTotals?: Record<string, number>;
  /** Legacy: LinkedIn ignored the r= bucket parameter (all buckets returned the same list) */
  filterParamIgnored?: boolean;
  /** Hiring Pro: rows loaded in the last pass */
  rowsLoaded?: number;
  lastRunAt: string;
}

// ---------- Pacing / scheduling ----------

export type Speed = 'slow' | 'normal' | 'brisk';

export type DelayKind =
  | 'micro' // between low-level input events
  | 'short' // after a click / before reading
  | 'read' // simulate reading a page
  | 'betweenPages' // pagination steps
  | 'betweenApplicants' // one applicant detail to the next
  | 'betweenProfiles'; // one profile to the next

export interface DelaySpec {
  minMs: number;
  medianMs: number;
  maxMs: number;
}

export interface PacingSettings {
  speed: Speed;
  /** "HH:MM" 24h local time */
  workHoursStart: string;
  workHoursEnd: string;
  /** 0 = Sunday ... 6 = Saturday */
  workDays: number[];
  /** IANA tz; defaults to system */
  timezone?: string;
  /** Max applicant detail pages per calendar day */
  dailyApplicantCap: number;
  /** Max full profile views per calendar day */
  dailyProfileCap: number;
  /** Max LinkedIn page navigations per rolling hour */
  hourlyActionCap: number;
  /** Take a long break after N actions, N sampled uniformly from this range */
  breakEveryActions: [number, number];
  /** Break length in minutes, sampled uniformly */
  breakMinutes: [number, number];
  delays: Record<DelayKind, DelaySpec>;
  /** Shuffle order of same-priority tasks so we do not walk the list top-to-bottom */
  randomizeOrder: boolean;
  /** Occasionally visit the feed / notifications between tasks */
  warmupProbability: number;
  /**
   * Ramp daily caps up over the first days of use (new automation on an account is the #1 trigger).
   * Effective cap = min(cap, rampStart + rampPerDay * daysSinceFirstAction). 0 disables.
   */
  rampStart: number;
  rampPerDay: number;
  /** Hard monthly cap for LinkedIn's "Save to PDF" (official limit is 200/month per account) */
  savePdfMonthlyCap: number;
}

/** How full profiles are extracted. */
export type ProfileStrategy =
  | 'auto' // navigate like a human, then one in-page Voyager fetch; fall back to page text if that fails
  | 'voyager' // in-page Voyager fetch only (fails if unavailable)
  | 'dom'; // never call Voyager: read rendered page text of the profile + details pages

// ---------- Browser ----------

export type BrowserMode = 'persistent' | 'cdp';

export interface CheckpointInfo {
  kind: 'login' | 'security_verification' | 'captcha' | 'rate_limited' | 'unusual_activity' | 'unknown';
  url: string;
  message: string;
}

export interface BrowserStatus {
  mode: BrowserMode;
  connected: boolean;
  /** null = unknown (browser not connected) */
  loggedIn: boolean | null;
  currentUrl?: string;
  checkpoint?: CheckpointInfo | null;
  profileDir?: string;
  cdpUrl?: string;
}

// ---------- Worker ----------

export interface WorkerStatus {
  running: boolean;
  paused: boolean;
  needsHuman: boolean;
  needsHumanReason?: string;
  currentTask?: Pick<Task, 'id' | 'type' | 'jobId' | 'applicationId' | 'startedAt'>;
  todayCounts: { applicants: number; profiles: number; actions: number };
  hourCount: number;
  nextEligibleAt?: string; // ISO, when the scheduler will allow the next task (if outside window / capped)
  lastError?: string;
  ownerPid?: number;
  ownerKind?: 'mcp' | 'cli';
  startedAt?: string;
}

// ---------- Logging ----------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}
