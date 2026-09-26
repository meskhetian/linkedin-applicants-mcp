/** URL builders and parsers for LinkedIn's hiring dashboard and profiles. Verified patterns as of 2026-09 (docs/research). */
import type { ApplicantRating } from '../types.js';

export const LI = 'https://www.linkedin.com';

export type PostedJobsTab = 'open' | 'closed';

/** Rating buckets of the legacy applicant list (`r=` parameter). "Not a fit" is hidden unless requested. */
export const RATING_BUCKETS = ['UNRATED', 'GOOD_FIT', 'MAYBE', 'NOT_A_FIT'] as const;
export type RatingBucket = (typeof RATING_BUCKETS)[number];

export function ratingFromBucket(b: RatingBucket): ApplicantRating {
  switch (b) {
    case 'GOOD_FIT':
      return 'good_fit';
    case 'MAYBE':
      return 'maybe';
    case 'NOT_A_FIT':
      return 'not_a_fit';
    default:
      return 'unrated';
  }
}

export type ApplicantsSort = 'APPLIED_DATE' | 'RELEVANCE';

export interface ApplicantsUrlOptions {
  /** Restrict to one rating bucket (legacy UI) */
  bucket?: RatingBucket;
  /** APPLIED_DATE gives a stable order across days; RELEVANCE (LinkedIn's default) reshuffles */
  sort?: ApplicantsSort;
}

export const URLS = {
  feed: `${LI}/feed/`,
  login: `${LI}/login`,
  /** Job poster's list of posted jobs. The Closed tab is ?jobState=CLOSED; the default view lists open/active jobs. */
  postedJobs: (tab: PostedJobsTab = 'open'): string => (tab === 'closed' ? `${LI}/my-items/posted-jobs/?jobState=CLOSED` : `${LI}/my-items/posted-jobs/`),
  jobDetail: (jobId: string): string => `${LI}/hiring/jobs/${jobId}/detail/`,
  /** Legacy applicants list, 25 per page, offset-based, optionally one rating bucket with a stable sort. */
  applicants: (jobId: string, start = 0, opts: ApplicantsUrlOptions = {}): string => {
    const q = new URLSearchParams();
    if (opts.bucket) q.set('r', opts.bucket);
    if (opts.sort) q.set('sort_by', opts.sort);
    if (start > 0) q.set('start', String(start));
    const qs = q.toString();
    return `${LI}/hiring/jobs/${jobId}/applicants/${qs ? `?${qs}` : ''}`;
  },
  /**
   * 2026 "Hiring Pro" applicants list (25 per page, numbered page buttons; LinkedIn appends the selected
   * applicationId to the URL). rating=ALL shows every applicant; sort=DateApplied keeps the order stable across days.
   */
  applicantsPro: (jobId: string, sort: 'DateApplied' | 'QualificationMatch' | 'FirstName' | 'LastName' = 'DateApplied', start = 0): string =>
    `${LI}/hiring/applicants/?jobId=${jobId}&rating=ALL&sort=${sort}${start > 0 ? `&start=${start}` : ''}`,
  /** Table variant of the same list (30 per page). Row ids only live in the server payload, so the list view is preferred. */
  applicantsProTable: (jobId: string, sort = 'DateApplied'): string => `${LI}/hiring/applicants-table/?rating=ALL&sort=${sort}&jobId=${jobId}`,
  applicantDetail: (jobId: string, applicationId: string): string => `${LI}/hiring/jobs/${jobId}/applicants/${applicationId}/detail/`,
  applicantDetailPro: (jobId: string, applicationId: string): string => `${LI}/hiring/applicants/?jobId=${jobId}&applicationId=${applicationId}&rating=ALL`,
  profile: (vanity: string): string => `${LI}/in/${encodeURIComponent(vanity)}/`,
  profileDetails: (vanity: string, section: ProfileSection): string => `${LI}/in/${encodeURIComponent(vanity)}/details/${section}/`,
  contactInfo: (vanity: string): string => `${LI}/in/${encodeURIComponent(vanity)}/overlay/contact-info/`,
};

export type ProfileSection =
  | 'experience'
  | 'education'
  | 'skills'
  | 'certifications'
  | 'languages'
  | 'projects'
  | 'honors'
  | 'volunteering-experiences'
  | 'publications'
  | 'courses';

export const APPLICANTS_PAGE_SIZE = 25;

export type UiVariant = 'legacy' | 'hiring_pro';

/** Decide the dashboard UI from the URL LinkedIn landed us on (undefined = not an applicants page). */
export function detectUiVariantFromUrl(url: string): UiVariant | undefined {
  try {
    const u = new URL(url);
    if (u.pathname.startsWith('/hiring/applicants') || u.searchParams.has('applicationId') || (u.pathname.startsWith('/hiring/') && u.searchParams.has('jobId'))) return 'hiring_pro';
    if (/^\/hiring\/jobs\/\d+\/applicants/.test(u.pathname)) return 'legacy';
    return undefined;
  } catch {
    return undefined;
  }
}

export function isLinkedInUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)linkedin\.com$/i.test(u.hostname) || /(^|\.)licdn\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

export function parseJobId(url: string): string | undefined {
  const m = /\/hiring\/jobs\/(\d+)(?:\/|$|\?)/.exec(url) ?? /\/jobs\/view\/(\d+)/.exec(url) ?? /[?&]jobId=(\d+)/.exec(url);
  return m?.[1];
}

/** Application id from either URL shape: /applicants/<id>/detail/ (legacy) or ?applicationId=<id> (Hiring Pro). */
export function parseApplicationId(url: string): string | undefined {
  const m = /\/applicants\/(\d+)(?:\/|$|\?)/.exec(url) ?? /[?&]applicationId=(\d+)/.exec(url);
  return m?.[1];
}

/** Public identifier ("vanity") from any /in/<vanity>/... URL. */
export function parseVanity(url: string): string | undefined {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(url) ?? /^\/in\/([^/?#]+)/.exec(url);
  if (!m?.[1]) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** Canonical https://www.linkedin.com/in/<vanity>/ or undefined for non-profile URLs. */
export function normalizeProfileUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  const v = parseVanity(url);
  return v ? URLS.profile(v) : undefined;
}

/** Signed / short-lived resume file URLs LinkedIn hands out. */
export const RESUME_URL_RE = /(\.pdf|\.docx?|mediaauth|ambry|\/dms\/|media\.licdn\.com|resumeViewer|x-li-ambry-ep|document\/media|pdf-analyzed)/i;

export function looksLikeResumeUrl(url: string | undefined | null): boolean {
  return (
    !!url &&
    RESUME_URL_RE.test(url) &&
    !/\.(png|jpe?g|gif|svg|webp)(\?|$)/i.test(url) &&
    !/\/dms\/(prv\/)?image\/|displayphoto|company-logo|cover-images|thumbnail/i.test(url) &&
    !/\/in\//.test(url)
  );
}
