import path from 'node:path';
import type { Locator, Page } from 'patchright';
import type { Applicant, ApplicantRating, ApplicantSyncProgress } from '../types.js';
import type { ScrapeContext } from './context.js';
import type { Generation } from './selectors.js';
import { SEL } from './selectors.js';
import { APPLICANTS_PAGE_SIZE, RATING_BUCKETS, URLS, detectUiVariantFromUrl, normalizeProfileUrl, parseApplicationId, ratingFromBucket, type RatingBucket, type UiVariant } from './urls.js';
import { allOfFirst, attrOf, collectLinks, firstPresent, firstVisible, mainText, parseCount, relativeToIso, textOf } from './dom.js';
import { jobDir, writeJson } from '../storage/files.js';
import { errorMessage } from '../errors.js';

export interface SyncApplicantsOptions {
  /** Stop after this many list pages (legacy) / load rounds (Hiring Pro) in THIS call; the caller requeues with nextOffset. Undefined = until the end. */
  maxPages?: number;
  /** Legacy: offset to resume from within the current rating bucket (multiple of 25). */
  startOffset?: number;
  /** Include hidden "Not a fit" applicants (legacy: crawl the NOT_A_FIT bucket too). Default true. */
  includeNotAFit?: boolean;
  /** Called after each page is parsed and persisted. */
  onPage?: (applicants: Applicant[], pageIndex: number, nextOffset: number) => void;
}

export interface SyncApplicantsResult {
  jobId: string;
  applicants: Applicant[];
  /** Total reported by the dashboard (sum of bucket totals in legacy mode), if found */
  totalReported?: number;
  pagesVisited: number;
  /** Offset (legacy) / rows loaded (Hiring Pro) to resume from if we stopped early */
  nextOffset?: number;
  complete: boolean;
  paginationMode?: ApplicantSyncProgress['paginationMode'];
  uiVariant?: UiVariant;
  stoppedEarly?: boolean;
}

// ---------------- pure helpers (unit-tested) ----------------

export interface ParsedApplicantCard {
  fullName: string;
  headline?: string;
  location?: string;
  appliedAgo?: string;
  meetsScreening?: boolean;
  qualificationsText?: string;
}

const BADGE_LINE = /^(new|viewed|unread|shortlisted|good fit|maybe|not a fit|top fit|meets all|must-have|preferred|\d+\/\d+|\d+ of \d+|\d+(st|nd|rd|th)|1st|2nd|3rd|·|•|in review|contacted|rejected|hired|name|title|company|location|qualifications?|actions?)$/i;
const CONNECTION_LINE = /^(1st|2nd|3rd|3rd\+)(\s+degree)?(\s+connection)?$/i;
const LOCATION_LIKE = /^\p{Lu}[\p{L}\p{M}.'-]+(?:, \p{Lu}[\p{L}\p{M}. '-]+)+$/u;

function cleanLines(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\s+/g, ' ').replace(/\s*·\s*(1st|2nd|3rd|3rd\+)\s*$/i, '').trim();
    if (l && lines[lines.length - 1] !== l && !CONNECTION_LINE.test(l)) lines.push(l);
  }
  return lines;
}

/**
 * Parse a legacy applicant card's innerText, e.g.
 *   "Jane Doe\nSenior Backend Engineer at Acme\nBerlin, Germany\nApplied 3 days ago\nMeets all must-have qualifications"
 */
export function parseApplicantCardText(text: string): ParsedApplicantCard {
  const lines = cleanLines(text);
  const appliedLine = lines.find((l) => /\bago\b/i.test(l) || /^applied\b/i.test(l));
  const qualLine = lines.find((l) => /must-have|preferred|qualification|screening|meets/i.test(l) || /^\d+\/\d+\b/.test(l) || /\d+ of \d+/i.test(l));
  const rest = lines.filter((l) => l !== appliedLine && l !== qualLine);
  const nameIdx = rest.findIndex((l) => !BADGE_LINE.test(l) && l.length >= 2 && l.length <= 80);
  let fullName = rest[nameIdx] ?? rest[0] ?? '';
  let after = rest.slice(nameIdx + 1).filter((l) => !BADGE_LINE.test(l) && l !== '--');
  const badges = parseNameBadges(fullName);
  if (badges) {
    fullName = badges.name;
    if (after[0] && after[0].localeCompare(badges.name, undefined, { sensitivity: 'base' }) === 0) after = after.slice(1);
  }
  let headline: string | undefined;
  let location: string | undefined;
  for (const l of after) {
    if (!location && LOCATION_LIKE.test(l) && l.length < 80) {
      location = l;
      continue;
    }
    if (!headline && l.length > 2 && !/^(remote|hybrid)$/i.test(l)) {
      headline = l;
      continue;
    }
    if (!location && (/,/.test(l) || /\b(area|region|remote)\b/i.test(l)) && l.length < 80 && !/[.!?]$/.test(l)) {
      location = l;
      break;
    }
  }
  return {
    fullName,
    headline,
    location,
    appliedAgo: appliedLine,
    meetsScreening: qualLine ? /meets all|all must-have|\b(\d+)\/\1\b/i.test(qualLine) : undefined,
    qualificationsText: qualLine,
  };
}

export interface ParsedProRow {
  fullName: string;
  title?: string;
  company?: string;
  location?: string;
  appliedOn?: string;
  qualificationsText?: string;
  meetsScreening?: boolean;
  /** LinkedIn marks applications the poster has not opened yet as "new applicant". */
  isNew?: boolean;
  /** The applicant shows the "Open to work" badge on their profile. */
  openToWork?: boolean;
}

/**
 * Cards for unopened applications start with an accessibility line that repeats the name with badges,
 * e.g. "Jane Doe, new applicant" or "Jane Doe is open to work, new applicant", followed by the real name line.
 * Returns the bare name plus the badges, or undefined when the line carries no badge.
 */
export function parseNameBadges(line: string): { name: string; isNew: boolean; openToWork: boolean } | undefined {
  const m = /^(.*?)(\s+is open to work)?(,\s*new applicant)?\s*$/i.exec(line);
  if (!m || (!m[2] && !m[3])) return undefined;
  const name = m[1]!.trim();
  if (!name) return undefined;
  return { name, isNew: Boolean(m[3]), openToWork: Boolean(m[2]) };
}

/**
 * Parse a Hiring Pro list row (columns Name / Title / Company / Location / Qualifications), e.g.
 *   "Jane Doe\nSenior Backend Engineer\nAcme\nBerlin, Germany\n3/3 Must-have · 1/2 Preferred\nApplied on: Sep 20, 2026"
 */
export function parseProRowText(text: string): ParsedProRow {
  const lines = cleanLines(text);
  const appliedLine = lines.find((l) => /^applied\b/i.test(l) || /\bago\b/i.test(l));
  const qualLines = lines.filter((l) => /must-have|preferred|qualification/i.test(l) || /^\d+\/\d+\b/.test(l));
  const rest = lines.filter((l) => l !== appliedLine && !qualLines.includes(l) && !BADGE_LINE.test(l) && l !== '--');
  let isNew: boolean | undefined;
  let openToWork: boolean | undefined;
  const badges = rest[0] ? parseNameBadges(rest[0]) : undefined;
  if (badges) {
    isNew = badges.isNew || undefined;
    openToWork = badges.openToWork || undefined;
    rest[0] = badges.name;
    // The badge line is followed by the plain name line; drop that duplicate.
    if (rest[1] && rest[1].localeCompare(badges.name, undefined, { sensitivity: 'base' }) === 0) rest.splice(1, 1);
  }
  const fullName = rest[0] ?? '';
  const after = rest.slice(1);
  let location: string | undefined;
  // Location is the LAST geo-looking line ("City, State, Country", "X Bay Area", "United States"); plain comma
  // lines are only a fallback because headlines contain commas too ("Director, Strategy & Operations").
  const isGeo = (l: string) => LOCATION_LIKE.test(l) || /\b(area|region|county|metropolitan|remote|united states|united kingdom|greater)\b/i.test(l);
  let locIdx = after.length - 1 - [...after].reverse().findIndex(isGeo);
  if (locIdx >= after.length) locIdx = -1;
  if (locIdx < 0) {
    const commaIdx = after.length - 1 - [...after].reverse().findIndex((l) => /,/.test(l) && l.length < 60 && !/[.!?|&]/.test(l));
    if (commaIdx < after.length && commaIdx >= 1) locIdx = commaIdx;
  }
  // Card layouts end with the location line (Name / headline|title / [company] / location); fall back to the last short line.
  if (locIdx < 0 && after.length >= 2) {
    const last = after[after.length - 1]!;
    if (last.length < 60 && !/[|@]/.test(last) && !/\d{4}/.test(last)) locIdx = after.length - 1;
  }
  if (locIdx >= 0) location = after.splice(locIdx, 1)[0];
  let title = after[0];
  let company = after[1];
  if (title && !company) {
    const m = /^(.+?)\s+at\s+(.+)$/i.exec(title);
    if (m) {
      title = m[1];
      company = m[2];
    }
  }
  const qualificationsText = qualLines.join(' · ') || undefined;
  const mustHave = qualificationsText ? [...qualificationsText.matchAll(/(\d+)\/(\d+)[\s·]*must-have/gi)] : [];
  const meets = mustHave.length ? mustHave.every((m) => m[1] === m[2]) : undefined;
  return { fullName, title, company, location, appliedOn: appliedLine, qualificationsText, meetsScreening: meets, isNew, openToWork };
}

/** Must-have and preferred qualification counters as LinkedIn shows them on the list card ("4/6 · Must-have · 5/5 · Preferred"). */
export interface FitScore {
  /** Fraction of must-have qualifications met, 0..1. */
  mustHave: number;
  /** Fraction of preferred qualifications met, 0..1 (0 when LinkedIn shows none). */
  preferred: number;
  mustHaveText?: string;
  preferredText?: string;
}

export function parseFitScore(qualifications: string | undefined | null): FitScore | undefined {
  if (!qualifications) return undefined;
  const m = /(\d+)\s*\/\s*(\d+)\s*[·•]?\s*must-have/i.exec(qualifications);
  if (!m || Number(m[2]) === 0) return undefined;
  const pref = /(\d+)\s*\/\s*(\d+)\s*[·•]?\s*preferred/i.exec(qualifications);
  return {
    mustHave: Number(m[1]) / Number(m[2]),
    preferred: pref && Number(pref[2]) ? Number(pref[1]) / Number(pref[2]) : 0,
    mustHaveText: `${m[1]}/${m[2]}`,
    preferredText: pref ? `${pref[1]}/${pref[2]}` : undefined,
  };
}

/**
 * Queue priority bonus so the applicants who match the job best are fetched first: all must-haves +30, 80% +20,
 * two thirds +10, half +5, then up to +4 for preferred qualifications. Unknown fit gets no bonus.
 */
export function fitPriorityBonus(fit: FitScore | undefined): number {
  if (!fit) return 0;
  const m = fit.mustHave;
  const base = m >= 1 ? 30 : m >= 0.8 ? 20 : m >= 0.66 ? 10 : m >= 0.5 ? 5 : 0;
  return base + Math.round(fit.preferred * 4);
}

/** "Applied on: Sep 20, 2026" | "Applied 3 days ago" | "2 weeks ago" → ISO */
export function parseAppliedOn(text: string | undefined, now: Date = new Date()): string | undefined {
  if (!text) return undefined;
  const rel = relativeToIso(text, now);
  if (rel) return rel;
  const m = /applied\s*(?:on)?\s*:?\s*(.+)$/i.exec(text);
  const candidate = (m?.[1] ?? text).trim();
  // Only attempt absolute parsing on something date-like ("Sep 20, 2026", "20/09/2026"); V8 accepts almost anything.
  if (!/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i.test(candidate) && !/\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}/.test(candidate)) return undefined;
  const hasYear = /\b(19|20)\d{2}\b/.test(candidate);
  // V8 fills a missing year with 2001, so try the current year first for "Sep 20"-style dates.
  let t = hasYear ? Date.parse(candidate) : Date.parse(`${candidate} ${now.getFullYear()}`);
  if (Number.isNaN(t)) t = Date.parse(candidate);
  if (Number.isNaN(t)) return undefined;
  let d = new Date(t);
  if (d.getUTCFullYear() < 2000) return undefined;
  if (!hasYear && d.getTime() > now.getTime() + 86_400_000) d = new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate()));
  return d.toISOString();
}

export interface NextPageDecision {
  action: 'offset' | 'button' | 'scroll' | 'stop';
  reason: string;
}

/** Pure pagination decision for the legacy list, unit-tested. */
export function decideNextPage(input: {
  newIdsOnPage: number;
  cardsOnPage: number;
  start: number;
  total?: number;
  hasNextButton: boolean;
  pagesThisRun: number;
  maxPages?: number;
  mode?: ApplicantSyncProgress['paginationMode'];
}): NextPageDecision {
  if (input.cardsOnPage === 0) return { action: 'stop', reason: 'no applicant cards on page' };
  if (input.maxPages !== undefined && input.pagesThisRun >= input.maxPages) return { action: 'stop', reason: 'maxPages for this run reached' };
  const nextStart = input.start + APPLICANTS_PAGE_SIZE;
  if (input.total !== undefined && nextStart >= input.total && input.newIdsOnPage > 0 && input.mode !== 'scroll') {
    return { action: 'stop', reason: `reached reported total (${input.total})` };
  }
  if (input.newIdsOnPage === 0) {
    if (input.mode === 'buttons' || input.hasNextButton) {
      return input.hasNextButton ? { action: 'button', reason: 'offset ignored, using next button' } : { action: 'stop', reason: 'no next button' };
    }
    if (input.mode === 'scroll') return { action: 'stop', reason: 'scrolling yielded no new applicants' };
    return { action: 'scroll', reason: 'offset ignored and no next button, trying infinite scroll' };
  }
  if (input.mode === 'buttons') return input.hasNextButton ? { action: 'button', reason: 'next page button' } : { action: 'stop', reason: 'last page (no next button)' };
  if (input.mode === 'scroll') return { action: 'scroll', reason: 'infinite scroll' };
  return { action: 'offset', reason: 'next ?start offset' };
}

// ---------------- main ----------------

interface CrawlState {
  jobId: string;
  progress: ApplicantSyncProgress | undefined;
  runStart: string;
  seen: Set<string>;
  collected: Applicant[];
  pagesThisRun: number;
  rawDir: string;
}

/**
 * Walk the applicant list for a job. LinkedIn ships two dashboards in 2026 and the job decides which one you get:
 *  - legacy (Ember): /hiring/jobs/<id>/applicants/?r=<BUCKET>&sort_by=APPLIED_DATE&start=N, 25 per page, four rating
 *    buckets crawled separately (UNRATED, GOOD_FIT, MAYBE, NOT_A_FIT, the last is hidden by default), stable sort;
 *  - Hiring Pro (SDUI): /hiring/applicants/?jobId=<id>&rating=ALL, infinite scroll + "Show more".
 * Thousands of applicants = many pages, so progress is persisted after every page/round and the worker requeues
 * between chunks (maxPages) so the scheduler (hours / caps / breaks) runs in between. Rows dedupe by applicationId.
 */
export async function syncApplicantList(ctx: ScrapeContext, jobId: string, opts: SyncApplicantsOptions = {}): Promise<SyncApplicantsResult> {
  const { page, human, db, log } = ctx;
  const progress = db.getSyncProgress(jobId);
  let variant: UiVariant | undefined = progress?.uiVariant;
  if (!variant) {
    await human.goto(page, URLS.applicants(jobId));
    await ctx.assertHealthy();
    await human.pause('short');
    variant = detectUiVariantFromUrl(page.url()) ?? (await detectVariantFromDom(page));
    log.info('applicant list UI detected', { jobId, variant, url: page.url() });
  }
  const state: CrawlState = { jobId, progress, runStart: new Date().toISOString(), seen: new Set(), collected: [], pagesThisRun: 0, rawDir: path.join(jobDir(ctx.cfg, jobId), 'raw') };
  return variant === 'hiring_pro' ? crawlHiringPro(ctx, state, opts) : crawlLegacy(ctx, state, opts);
}

async function detectVariantFromDom(page: Page): Promise<UiVariant> {
  try {
    return await page.evaluate(() => {
      if (document.querySelector('a[href*="applicationId="]')) return 'hiring_pro' as const;
      if (document.querySelector('a[href*="/applicants/"][href*="/detail"], .hiring-applicants__list-item')) return 'legacy' as const;
      return /Applied on:/i.test(document.body?.innerText ?? '') ? ('hiring_pro' as const) : ('legacy' as const);
    });
  } catch {
    return 'legacy';
  }
}

function snapshot(ctx: ScrapeContext, mark: number, extra: Record<string, unknown>) {
  return {
    url: ctx.page.url(),
    capturedAt: new Date().toISOString(),
    ...extra,
    captured: ctx.capture
      .since(mark)
      .filter((e) => /hiring|applicant|jobApplication|jobPosting/i.test(e.url))
      .map((e) => ({ url: e.url, kind: e.kind, status: e.status, json: e.json ?? e.body.slice(0, 200_000) })),
  };
}

// ---------------- legacy (offset pages, rating buckets) ----------------

interface Pass {
  bucket?: RatingBucket;
  label: string;
  /** Final fallback pass over the default list after enabling "Not a fit" through the UI */
  uiFilter?: boolean;
}

async function crawlLegacy(ctx: ScrapeContext, st: CrawlState, opts: SyncApplicantsOptions): Promise<SyncApplicantsResult> {
  const { page, human, db, log } = ctx;
  const { jobId, progress } = st;
  const buckets: RatingBucket[] = opts.includeNotAFit === false ? RATING_BUCKETS.filter((b) => b !== 'NOT_A_FIT') : [...RATING_BUCKETS];
  let filterParamIgnored = progress?.filterParamIgnored ?? false;
  let passes: Pass[] = filterParamIgnored ? [{ label: 'ALL', uiFilter: true }] : buckets.map((b) => ({ bucket: b, label: b }));
  let passIndex = Math.min(progress?.bucketIndex ?? 0, passes.length);
  let start = opts.startOffset ?? progress?.nextOffset ?? 0;
  const bucketTotals: Record<string, number> = { ...(progress?.bucketTotals ?? {}) };
  let mode: ApplicantSyncProgress['paginationMode'] = progress?.paginationMode ?? 'offset';
  let stoppedEarly = progress?.stoppedEarly ?? false;
  const seenInPass = new Map<string, Set<string>>();

  const totalReported = () => {
    const vals = Object.values(bucketTotals);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : undefined;
  };
  const persist = (nextOffset: number, done: boolean): ApplicantSyncProgress => {
    const p: ApplicantSyncProgress = {
      jobId,
      nextOffset,
      pagesVisited: (progress?.pagesVisited ?? 0) + st.pagesThisRun,
      totalReported: totalReported(),
      stored: db.countApplicants(jobId),
      complete: done,
      stoppedEarly: stoppedEarly || undefined,
      paginationMode: mode,
      uiVariant: 'legacy',
      bucketIndex: passIndex,
      bucketTotals,
      filterParamIgnored: filterParamIgnored || undefined,
      lastRunAt: new Date().toISOString(),
    };
    db.setSyncProgress(p);
    return p;
  };
  const result = (complete: boolean, nextOffset?: number): SyncApplicantsResult => ({
    jobId,
    applicants: st.collected,
    totalReported: totalReported(),
    pagesVisited: st.pagesThisRun,
    nextOffset,
    complete,
    paginationMode: mode,
    uiVariant: 'legacy',
    stoppedEarly: stoppedEarly || undefined,
  });

  let firstPage = true;
  let skipGoto = false;
  while (passIndex < passes.length) {
    const pass = passes[passIndex]!;
    const label = pass.label;
    if (!seenInPass.has(label)) seenInPass.set(label, new Set());
    const passSeen = seenInPass.get(label)!;
    let pageInPass = 0;

    for (;;) {
      const mark = ctx.capture.mark();
      if (!skipGoto) {
        await human.goto(page, URLS.applicants(jobId, start, { bucket: pass.bucket, sort: 'APPLIED_DATE' }));
        await ctx.assertHealthy();
        await human.pause(firstPage ? 'read' : 'short');
        await human.scrollPage(page, { maxScrolls: 3 });
      }
      skipGoto = false;
      const gen = await ctx.generation();
      if (pass.uiFilter && pageInPass === 0) await enableNotAFit(ctx, gen);
      const total = await readTotal(ctx, gen);
      if (total !== undefined) bucketTotals[label] = total;

      const rating: ApplicantRating | undefined = pass.bucket && !filterParamIgnored ? ratingFromBucket(pass.bucket) : undefined;
      const { applicants, cards } = await parseLegacyPage(ctx, gen, jobId, rating);
      const pageOk = await verifyPageIndicator(page, gen, start);
      let newIds = 0;
      for (const a of applicants) {
        if (!st.seen.has(a.applicationId)) {
          st.seen.add(a.applicationId);
          newIds++;
        }
        passSeen.add(a.applicationId);
        db.upsertApplicantFromList(a);
      }
      st.collected.push(...applicants);
      st.pagesThisRun++;
      pageInPass++;
      firstPage = false;
      await ctx.capture.drain();
      if (pageInPass <= 2 || ctx.capture.since(mark).some((e) => /hiring|applicant/i.test(e.url))) {
        const text = await mainText(page);
        writeJson(path.join(st.rawDir, `raw-applicants-${label}-${String(start).padStart(6, '0')}.json`), snapshot(ctx, mark, { generation: gen, bucket: label, start, cards, text: text.slice(0, 100_000), links: (await collectLinks(page)).filter((l) => /applicants|\/in\//.test(l.href)).slice(0, 400) }));
      }

      // r= parameter ignored? (a later bucket's first page shows only applicants we already saw)
      if (pass.bucket && passIndex > 0 && pageInPass === 1 && cards.length > 0 && newIds === 0 && !filterParamIgnored) {
        filterParamIgnored = true;
        const cleared = db.clearListRatings(jobId, st.runStart);
        log.warn('LinkedIn ignored the r= rating bucket parameter; ratings from list buckets were cleared and a single pass with the UI filter follows', { jobId, cleared });
        passes = [{ label: 'ALL', uiFilter: true }];
        passIndex = 0;
        start = 0;
        skipGoto = false;
        persist(0, false);
        await human.pause('betweenPages');
        break;
      }

      const hasNext = !!(await firstVisible(page, SEL[gen].applicants.nextButton, { timeoutMs: 400 }));
      const decision = decideNextPage({ newIdsOnPage: pageOk ? newIds : 0, cardsOnPage: cards.length, start, total: bucketTotals[label], hasNextButton: hasNext, pagesThisRun: st.pagesThisRun, maxPages: opts.maxPages, mode: mode === 'buttons' ? 'buttons' : undefined });
      const stored = db.countApplicants(jobId);
      log.info('applicant page parsed', { jobId, bucket: label, start, cards: cards.length, newIds, pageOk, stored, bucketTotal: bucketTotals[label], next: decision.action, reason: decision.reason });
      const nextOffset = start + (newIds > 0 ? APPLICANTS_PAGE_SIZE : 0);
      opts.onPage?.(applicants, st.pagesThisRun - 1, nextOffset);

      const budgetHit = opts.maxPages !== undefined && st.pagesThisRun >= opts.maxPages;
      const exhausted = cards.length === 0 || newIds === 0 || (bucketTotals[label] !== undefined && nextOffset >= bucketTotals[label]!);
      if (decision.action === 'stop' && budgetHit && !exhausted) {
        persist(nextOffset, false);
        return result(false, nextOffset);
      }
      if (decision.action === 'offset') {
        start = nextOffset;
        persist(start, false);
        await human.pause('betweenPages');
        continue;
      }
      if (decision.action === 'button') {
        const next = await firstVisible(page, SEL[gen].applicants.nextButton, { timeoutMs: 2000 });
        if (next) {
          await human.pause('betweenPages');
          await human.click(page, next);
          await human.pause('short');
          await ctx.assertHealthy();
          await human.scrollPage(page, { maxScrolls: 3 });
          mode = 'buttons';
          start = nextOffset;
          skipGoto = true;
          persist(start, false);
          continue;
        }
      }
      // stop / scroll → this pass is exhausted
      const tot = bucketTotals[label];
      if (tot && passSeen.size < tot * 0.98 && cards.length > 0) {
        stoppedEarly = true;
        log.warn('applicant list pass ended before its reported total, possible deep-pagination cap', { jobId, bucket: label, seen: passSeen.size, total: tot, start });
      }
      break;
    }

    if (passes[passIndex]?.label !== label) continue; // passes were replaced (filter param ignored)
    passIndex++;
    start = 0;
    persist(0, passIndex >= passes.length);
    if (passIndex < passes.length) await human.pause('betweenPages');
  }
  persist(0, true);
  log.info('applicant list complete', { jobId, stored: db.countApplicants(jobId), totalReported: totalReported(), buckets: bucketTotals, filterParamIgnored });
  return result(true);
}

async function verifyPageIndicator(page: Page, gen: Generation, start: number): Promise<boolean> {
  const loc = await firstVisible(page, SEL[gen].applicants.currentPage, { timeoutMs: 300 });
  const text = await textOf(loc);
  const n = text ? Number.parseInt(text.replace(/\D/g, ''), 10) : NaN;
  if (!Number.isFinite(n)) return true; // cannot verify → trust the ids
  return n === Math.floor(start / APPLICANTS_PAGE_SIZE) + 1;
}

async function parseLegacyPage(ctx: ScrapeContext, gen: Generation, jobId: string, rating: ApplicantRating | undefined): Promise<{ applicants: Applicant[]; cards: Array<{ applicationId?: string; text: string }> }> {
  const { page } = ctx;
  const now = new Date().toISOString();
  const cards = await allOfFirst(page, SEL[gen].applicants.card);
  const out: Applicant[] = [];
  const raw: Array<{ applicationId?: string; text: string }> = [];
  const seen = new Set<string>();
  for (const card of cards) {
    const text = (await textOf(card)) ?? '';
    const applicationId = await applicationIdOf(card, gen);
    raw.push({ applicationId, text: text.slice(0, 2000) });
    if (!applicationId || seen.has(applicationId)) continue;
    seen.add(applicationId);
    const parsed = parseApplicantCardText(text);
    const profileHref = await attrOf(await firstPresent(card, ['a[href*="/in/"]']), 'href');
    out.push({
      applicationId,
      jobId,
      fullName: parsed.fullName || `Applicant ${applicationId}`,
      headline: parsed.headline,
      location: parsed.location,
      appliedAt: parseAppliedOn(parsed.appliedAgo),
      rating,
      profileUrl: normalizeProfileUrl(profileHref),
      listSyncedAt: now,
      raw: { cardText: text.slice(0, 2000), qualifications: parsed.qualificationsText, meetsScreening: parsed.meetsScreening },
    });
  }
  if (!out.length) {
    // Fallback: any detail links on the page, even if no card selector matched
    for (const l of await collectLinks(page)) {
      const id = parseApplicationId(l.href);
      if (!id || seen.has(id) || !/\/applicants\//.test(l.href)) continue;
      seen.add(id);
      raw.push({ applicationId: id, text: l.text });
      out.push({ applicationId: id, jobId, fullName: l.text.split('\n')[0]?.trim() || `Applicant ${id}`, rating, listSyncedAt: now, raw: { fromLink: true } });
    }
  }
  return { applicants: out, cards: raw };
}

async function applicationIdOf(card: Locator, gen: Generation): Promise<string | undefined> {
  const link = await firstPresent(card, SEL[gen].applicants.detailLink);
  const href = await attrOf(link, 'href');
  if (href) {
    const id = parseApplicationId(href);
    if (id) return id;
  }
  for (const attr of ['data-application-id', 'data-id', 'id', 'componentkey']) {
    const v = await attrOf(card, attr);
    const m = v ? /(\d{6,})/.exec(v) : null;
    if (m) return m[1];
  }
  return undefined;
}

async function enableNotAFit(ctx: ScrapeContext, gen: Generation): Promise<void> {
  const { page, human, log } = ctx;
  try {
    const filter = await firstVisible(page, SEL[gen].applicants.ratingsFilter, { timeoutMs: 2500 });
    if (!filter) {
      log.info('ratings filter not found; "Not a fit" applicants may stay hidden', { generation: gen });
      return;
    }
    await human.click(page, filter);
    await human.pause('short');
    const option = await firstVisible(page, SEL[gen].applicants.ratingsNotAFitOption, { timeoutMs: 3000 });
    if (!option) {
      await page.keyboard.press('Escape').catch(() => {});
      return;
    }
    const checked = await option
      .evaluate((el) => {
        const input = (el.matches('input') ? el : el.querySelector('input')) as HTMLInputElement | null;
        if (input) return input.checked;
        const aria = el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected') ?? el.getAttribute('aria-pressed');
        return aria === 'true';
      })
      .catch(() => false);
    if (!checked) {
      await human.click(page, option);
      await human.pause('short');
    }
    const apply = await firstVisible(page, SEL[gen].applicants.ratingsApply, { timeoutMs: 1500 });
    if (apply) {
      await human.click(page, apply);
      await human.pause('short');
    } else await page.keyboard.press('Escape').catch(() => {});
    await human.pauseMs(800, 2000);
    log.info('ratings filter: "Not a fit" bucket enabled through the UI', { wasChecked: checked });
  } catch (e) {
    log.warn('could not enable "Not a fit" filter through the UI', { error: errorMessage(e) });
    await page.keyboard.press('Escape').catch(() => {});
  }
}

async function readTotal(ctx: ScrapeContext, gen: Generation): Promise<number | undefined> {
  const loc = await firstVisible(ctx.page, SEL[gen].applicants.totalCount, { timeoutMs: 1500 });
  const fromHeader = parseCount(await textOf(loc));
  if (fromHeader) return fromHeader;
  const text = await mainText(ctx.page, 20_000);
  const m = /(\d[\d,.]*)\s*\+?\s*applicants?/i.exec(text) ?? /applicants?\s*\((\d[\d,.]*)\)/i.exec(text) ?? /\bAll\s*\((\d[\d,.]*)\)/i.exec(text);
  if (m) return parseCount(m[0]);
  // The nav tab "Applicants (1,234)" lives outside <main>
  const nav = await ctx.page.evaluate(() => (document.body?.innerText ?? '').slice(0, 30_000)).catch(() => '');
  const n = /applicants?\s*\((\d[\d,.]*)\)/i.exec(nav) ?? /\bAll\s*\((\d[\d,.]*)\)/i.exec(nav);
  return n ? parseCount(n[0]) : undefined;
}

// ---------------- Hiring Pro (paginated list, 25 per page) ----------------

interface ProRow {
  applicationId: string;
  href: string;
  text: string;
  profileHref?: string;
}

/** Every applicant card on the current list page: <a componentkey="paginatedApplicantCard-<id>" href="...applicationId=<id>..."> */
async function collectProRows(page: Page): Promise<ProRow[]> {
  try {
    return await page.evaluate(() => {
      const out: Array<{ applicationId: string; href: string; text: string; profileHref?: string }> = [];
      const seen = new Set<string>();
      for (const a of Array.from(document.querySelectorAll('a[componentkey^="paginatedApplicantCard-"], a[href*="applicationId="]'))) {
        const href = (a as HTMLAnchorElement).href;
        const m = /[?&]applicationId=(\d+)/.exec(href);
        if (!m) continue;
        const id = m[1]!;
        const ck = a.getAttribute('componentkey') ?? '';
        const text = ((a as HTMLElement).innerText ?? '').trim();
        const isCard = ck.startsWith('paginatedApplicantCard-') || (text.length > 20 && !/add a coworker|edit qualifications|view resume/i.test(text));
        if (!isCard || seen.has(id)) continue;
        seen.add(id);
        out.push({ applicationId: id, href, text: text.slice(0, 2000), profileHref: (a.querySelector('a[href*="/in/"]') as HTMLAnchorElement | null)?.href });
      }
      return out;
    });
  } catch {
    return [];
  }
}

async function currentListPage(page: Page, gen: Generation): Promise<number | undefined> {
  const loc = await firstVisible(page, SEL[gen].applicants.currentPage, { timeoutMs: 300 });
  const text = await textOf(loc);
  const n = text ? Number.parseInt(text.replace(/\D/g, ''), 10) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** The pagination's own "Next" control: nearest ancestor of a "Page N" button that also contains a Next button. */
async function paginationNext(page: Page, gen: Generation): Promise<Locator | null> {
  try {
    const container = page.locator('button[aria-label^="Page "]').first().locator('xpath=ancestor::*[.//button[normalize-space()="Next" or starts-with(@aria-label,"Next")]][1]');
    if ((await container.count()) > 0) {
      const next = container.locator('button:has-text("Next"):not([disabled]), button[aria-label^="Next"]:not([disabled])').first();
      if (await next.isVisible().catch(() => false)) return next;
      return null; // pagination exists but Next is disabled → last page
    }
  } catch {
    /* fall through */
  }
  return firstVisible(page, SEL[gen].applicants.nextButton, { timeoutMs: 800 });
}

/**
 * Move the paginated list to `target`: click the target page button if visible, else the largest visible
 * page button below it (typically a 10-page jump), else the pagination's Next. Bails out after three clicks
 * that do not move the page indicator. Returns the page reached.
 */
async function goToListPage(ctx: ScrapeContext, gen: Generation, target: number, current: number, fastForward: boolean): Promise<number> {
  const { page, human, log } = ctx;
  let stuck = 0;
  for (let guard = 0; guard < 40 && current < target && stuck < 3; guard++) {
    const before = current;
    const firstIdBefore = (await collectProRows(page))[0]?.applicationId;
    const direct = await firstVisible(page, [SEL[gen].applicants.pageButton(target)], { timeoutMs: 300 });
    let jump: Locator | null = null;
    let jumpTo = current;
    if (!direct) {
      const visiblePages = await page
        .evaluate(() => Array.from(document.querySelectorAll('button[aria-label^="Page "]')).map((b) => Number.parseInt((b.getAttribute('aria-label') ?? '').replace(/\D/g, ''), 10)).filter((n) => Number.isFinite(n)))
        .catch(() => [] as number[]);
      const best = Math.max(...visiblePages.filter((n) => n > current && n <= target), -1);
      if (best > current) {
        jump = await firstVisible(page, [SEL[gen].applicants.pageButton(best)], { timeoutMs: 300 });
        jumpTo = best;
      }
    }
    const next = direct ?? jump ?? (await paginationNext(page, gen));
    if (!next) {
      log.info('no page control to advance further', { current, target });
      return current;
    }
    await human.click(page, next);
    await human.pause(fastForward ? 'short' : 'betweenPages');
    await ctx.assertHealthy();
    for (let i = 0; i < 12; i++) {
      const firstId = (await collectProRows(page))[0]?.applicationId;
      if (firstId && firstId !== firstIdBefore) break;
      await human.pauseMs(400, 800);
    }
    const indicated = await currentListPage(page, gen);
    current = indicated ?? (direct ? target : jump ? jumpTo : current + 1);
    if (current === before) {
      stuck++;
      log.warn('page click did not advance the list', { current, target, attempt: stuck });
    } else stuck = 0;
  }
  return current;
}

async function crawlHiringPro(ctx: ScrapeContext, st: CrawlState, opts: SyncApplicantsOptions): Promise<SyncApplicantsResult> {
  const { page, human, db, log } = ctx;
  const { jobId, progress } = st;
  let totalReported = progress?.totalReported;
  let stoppedEarly = false;
  const persist = (nextPage: number, done: boolean, blankRuns = 0) => {
    db.setSyncProgress({
      jobId,
      nextOffset: (nextPage - 1) * APPLICANTS_PAGE_SIZE,
      pagesVisited: (progress?.pagesVisited ?? 0) + st.pagesThisRun,
      totalReported,
      stored: db.countApplicants(jobId),
      complete: done,
      stoppedEarly: stoppedEarly || undefined,
      blankRuns: blankRuns || undefined,
      paginationMode: 'buttons',
      uiVariant: 'hiring_pro',
      rowsLoaded: st.seen.size,
      lastRunAt: new Date().toISOString(),
    });
  };
  const result = (complete: boolean, nextPage: number): SyncApplicantsResult => ({
    jobId,
    applicants: st.collected,
    totalReported,
    pagesVisited: st.pagesThisRun,
    nextOffset: complete ? undefined : (nextPage - 1) * APPLICANTS_PAGE_SIZE,
    complete,
    paginationMode: 'buttons',
    uiVariant: 'hiring_pro',
    stoppedEarly: stoppedEarly || undefined,
  });

  const resumeOffset = opts.startOffset ?? progress?.nextOffset ?? 0;
  const startPage = Math.max(1, Math.floor(resumeOffset / APPLICANTS_PAGE_SIZE) + 1);
  const mark = ctx.capture.mark();
  // LinkedIn puts the page offset in the URL (…&start=225), so resume by navigating straight to it and
  // verify with the page indicator; fall back to clicking through if the parameter was ignored.
  await human.goto(page, URLS.applicantsPro(jobId, 'DateApplied', startPage > 1 ? (startPage - 1) * APPLICANTS_PAGE_SIZE : 0));
  await ctx.assertHealthy();
  await human.pause('read');
  const gen = await ctx.generation();
  // Make sure the list is not narrowed to "Top fit" / shortlisted
  const allBtn = await firstVisible(page, SEL[gen].applicants.allApplicantsFilter, { timeoutMs: 1500 });
  if (allBtn) {
    const selected = await allBtn.evaluate((el) => el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') === 'true' || el.getAttribute('aria-pressed') === 'true').catch(() => false);
    if (!selected) {
      await human.click(page, allBtn);
      await human.pause('short');
      await ctx.assertHealthy();
    }
  }
  totalReported = (await readTotal(ctx, gen)) ?? totalReported;
  let current = (await currentListPage(page, gen)) ?? 1;
  log.info('hiring pro applicant list opened', { jobId, totalReported, startPage, current, directStartHonoured: current === startPage, url: page.url() });
  if (startPage > current) {
    current = await goToListPage(ctx, gen, startPage, current, true);
    log.info('resumed at list page by clicking', { jobId, page: current, wanted: startPage });
  }

  const now = new Date().toISOString();
  let lastFirstId: string | undefined;
  for (let guard = 0; guard < 500; guard++) {
    let rows = await collectProRows(page);
    // A page that renders no cards while the reported total says more applicants exist is almost always a slow
    // render or a click that landed mid-load: wait and read again before drawing any conclusion.
    if (rows.length === 0 && (totalReported === undefined || db.countApplicants(jobId) < totalReported)) {
      for (let attempt = 1; attempt <= 2 && rows.length === 0; attempt++) {
        log.warn('list page rendered no applicant cards; waiting and reading again', { jobId, page: current, attempt });
        await human.pauseMs(4000, 9000);
        rows = await collectProRows(page);
      }
    }
    let newToRun = 0;
    let newToDb = 0;
    for (const r of rows) {
      if (st.seen.has(r.applicationId)) continue;
      st.seen.add(r.applicationId);
      newToRun++;
      if (!db.hasApplicant(r.applicationId)) newToDb++;
      const parsed = parseProRowText(r.text);
      const a: Applicant = {
        applicationId: r.applicationId,
        jobId,
        fullName: parsed.fullName || `Applicant ${r.applicationId}`,
        headline: [parsed.title, parsed.company].filter(Boolean).join(' at ') || undefined,
        location: parsed.location,
        appliedAt: parseAppliedOn(parsed.appliedOn),
        profileUrl: normalizeProfileUrl(r.profileHref),
        isViewed: parsed.isNew ? false : undefined,
        listSyncedAt: now,
        raw: { rowText: r.text, qualifications: parsed.qualificationsText, meetsScreening: parsed.meetsScreening, openToWork: parsed.openToWork, listPage: current },
      };
      db.upsertApplicantFromList(a);
      st.collected.push(a);
    }
    st.pagesThisRun++;
    if (st.pagesThisRun <= 2) {
      await ctx.capture.drain();
      writeJson(path.join(st.rawDir, `raw-applicants-pro-page-${String(current).padStart(4, '0')}.json`), snapshot(ctx, mark, { generation: gen, page: current, rows: rows.slice(0, 40), text: (await mainText(page)).slice(0, 100_000) }));
    }
    const stored = db.countApplicants(jobId);
    log.info('hiring pro list page parsed', { jobId, page: current, rows: rows.length, newToRun, newToDb, stored, totalReported });
    opts.onPage?.(newToRun ? st.collected.slice(-newToRun) : [], st.pagesThisRun - 1, current * APPLICANTS_PAGE_SIZE);

    const firstId = rows[0]?.applicationId;
    const repeated = rows.length > 0 && firstId === lastFirstId && newToRun === 0;
    lastFirstId = firstId;
    const remaining = totalReported !== undefined && stored < totalReported * 0.98;
    if (rows.length === 0 && remaining) {
      // Still nothing after the retries: leave the list incomplete at this page so the next chunk tries again
      // (a fresh navigation), instead of declaring a 2,000-applicant list finished after a blank render.
      const blankRuns = (progress?.blankRuns ?? 0) + 1;
      stoppedEarly = true;
      if (blankRuns >= 3) {
        log.warn('hiring pro list page stayed empty in three runs; giving up on this list', { jobId, stored, totalReported, page: current });
        persist(current, true, blankRuns);
        return result(true, current);
      }
      log.warn('hiring pro list page stayed empty; will retry this page in the next run', { jobId, stored, totalReported, page: current, blankRuns });
      persist(current, false, blankRuns);
      return result(false, current);
    }
    const exhausted = rows.length === 0 || repeated || (totalReported !== undefined && stored >= totalReported);
    const hasNextPage = !!(await firstVisible(page, [SEL[gen].applicants.pageButton(current + 1)], { timeoutMs: 300 })) || !!(await paginationNext(page, gen));
    if (exhausted || !hasNextPage) {
      if (remaining && rows.length > 0) {
        stoppedEarly = true;
        log.warn('hiring pro list ended before the reported total', { jobId, stored, totalReported, page: current, reason: repeated ? 'pagination did not advance' : 'no next page' });
      }
      persist(current, true);
      log.info('applicant list complete', { jobId, stored, totalReported, pages: current });
      return result(true, current);
    }
    if (opts.maxPages !== undefined && st.pagesThisRun >= opts.maxPages) {
      persist(current + 1, false);
      return result(false, current + 1);
    }
    persist(current + 1, false);
    await human.pause('betweenPages');
    const before = current;
    current = await goToListPage(ctx, gen, current + 1, current, false);
    if (current === before) {
      persist(current, true);
      return result(true, current);
    }
  }
  persist(current, true);
  return result(true, current);
}
