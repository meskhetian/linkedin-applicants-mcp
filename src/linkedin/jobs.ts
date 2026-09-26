import path from 'node:path';
import type { Page } from 'patchright';
import type { JobPosting, JobStatus } from '../types.js';
import type { ScrapeContext } from './context.js';
import type { Generation } from './selectors.js';
import { SEL } from './selectors.js';
import { URLS, parseJobId, type PostedJobsTab } from './urls.js';
import { allOfFirst, attrOf, collectLinks, firstPresent, firstVisible, mainText, parseCount, relativeToIso, textOf } from './dom.js';
import { SelectorNotFoundError } from '../errors.js';
import { writeJson } from '../storage/files.js';

export interface SyncJobsOptions {
  includeClosed: boolean;
}

export function mapJobStatus(text: string | undefined, tab: PostedJobsTab): JobStatus {
  const t = (text ?? '').toLowerCase();
  if (/\bclosed\b/.test(t)) return 'closed';
  if (/\bpaused\b/.test(t)) return 'paused';
  if (/\bdraft\b|in review|pending review|under review/.test(t)) return 'draft';
  if (/\bexpired\b/.test(t)) return 'closed';
  if (/\bactive\b|\bopen\b|\blisted\b|\bpromoted\b|\bposted\b/.test(t)) return 'open';
  return tab === 'closed' ? 'closed' : 'open';
}

export interface ParsedJobCard {
  title?: string;
  companyName?: string;
  location?: string;
  workplaceType?: string;
  status: JobStatus;
  applicantCount?: number;
  postedAgo?: string;
  closedAgo?: string;
}

/**
 * Parse a posted-job card's innerText, e.g.
 *   "Senior Backend Engineer\nAcme · Berlin, Germany (Hybrid)\n1,234 applicants\nActive · Posted 12 days ago"
 */
export function parseJobCardText(text: string, tab: PostedJobsTab): ParsedJobCard {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\s+/g, ' ').replace(/^,\s*/, '').trim();
    if (l && lines[lines.length - 1] !== l && !/^verified$/i.test(l)) lines.push(l);
  }
  const out: ParsedJobCard = { status: mapJobStatus(undefined, tab) };
  const isMeta = (l: string) => /applicant|\bactive\b|\bclosed\b|\bpaused\b|\bdraft\b|in review|\bposted\b|\bago\b|promoted|reposted|\bspent\b|\bexpired\b|\blisted\b/i.test(l);
  const meta = lines.filter(isMeta);
  const content = lines.filter((l) => !isMeta(l) && !/^(view applicants|manage job|view job|edit|close job|repost|share|…|more|post a free job)$/i.test(l));
  out.title = content[0];
  const looksLikeLocation = (l: string) => /,|\((remote|hybrid|on-site|onsite)\)|\b(remote|hybrid|on-site|area|region|united states|canada|united kingdom)\b/i.test(l);
  const second = content[1];
  const third = content[2];
  if (second) {
    const parts = second.split(' · ').map((s) => s.trim());
    if (parts.length >= 2) {
      out.companyName = parts[0];
      out.location = parts.slice(1).join(' · ');
    } else if (looksLikeLocation(second) && !third) out.location = second;
    else {
      out.companyName = second;
      if (third && looksLikeLocation(third)) out.location = third;
    }
  }
  if (out.location) {
    const wt = /\((remote|hybrid|on-site|onsite)\)/i.exec(out.location) ?? /\b(remote|hybrid|on-site|onsite)\b/i.exec(out.location);
    if (wt) {
      out.workplaceType = wt[1]!.replace(/onsite/i, 'On-site');
      out.location = out.location.replace(/\s*\((remote|hybrid|on-site|onsite)\)/i, '').trim() || undefined;
    }
  }
  const countLine = meta.find((l) => /applicant/i.test(l));
  if (countLine) out.applicantCount = parseCount(countLine);
  const statusLine = meta.find((l) => /\bactive\b|\bclosed\b|\bpaused\b|\bdraft\b|in review|\bopen\b|\blisted\b|\bexpired\b/i.test(l));
  out.status = mapJobStatus(statusLine, tab);
  out.postedAgo = meta.map((l) => /posted\s+(\d+\s*\w+\s+ago)/i.exec(l)?.[1]).find(Boolean) ?? meta.find((l) => /\bago\b/.test(l) && !/closed\s+\d/i.test(l));
  out.closedAgo = meta.map((l) => /closed\s+(\d+\s*\w+\s+ago)/i.exec(l)?.[1]).find(Boolean);
  return out;
}

/**
 * Visit /my-items/posted-jobs/ (and ?jobState=CLOSED when includeClosed) like a person, load every card,
 * and return the postings found. Upserts into ctx.db as it goes. Fails closed when the open tab shows
 * no cards and no "no jobs" text (selectors probably changed).
 */
export async function syncPostedJobs(ctx: ScrapeContext, opts: SyncJobsOptions): Promise<JobPosting[]> {
  const all: JobPosting[] = [];
  // The default view is the open/active tab. Other tabs are discovered from the page's own tab links
  // (?jobState=...) so we follow whatever LinkedIn renders; CLOSED is the verified value and always tried.
  const { jobs, tabUrls } = await scrapeTab(ctx, 'open', URLS.postedJobs('open'));
  all.push(...jobs);
  if (opts.includeClosed) {
    const extra = new Map<string, string>();
    for (const u of tabUrls) {
      const state = /jobState=([A-Z_]+)/i.exec(u)?.[1]?.toUpperCase();
      if (state && state !== 'LISTED' && state !== 'OPEN') extra.set(state, u);
    }
    if (!extra.has('CLOSED')) extra.set('CLOSED', URLS.postedJobs('closed'));
    for (const [state, url] of extra) {
      await ctx.human.pause('betweenPages');
      const tab: PostedJobsTab = state === 'CLOSED' ? 'closed' : 'open';
      all.push(...(await scrapeTab(ctx, tab, url, state)).jobs);
    }
  }
  ctx.log.info('posted jobs synced', { count: all.length, includeClosed: opts.includeClosed });
  return all;
}

async function loadAllCards(ctx: ScrapeContext, gen: Generation): Promise<void> {
  const { page, human } = ctx;
  let lastCount = -1;
  let stable = 0;
  for (let i = 0; i < 40 && stable < 2; i++) {
    const count = (await allOfFirst(page, SEL[gen].jobs.card)).length;
    const more = await firstVisible(page, SEL[gen].jobs.showMore, { timeoutMs: 400 });
    if (more) {
      await human.click(page, more);
      await human.pause('betweenPages');
    } else {
      await human.scrollPage(page, { maxScrolls: 3 });
      await human.pauseMs(600, 1800);
    }
    if (count === lastCount) stable++;
    else stable = 0;
    lastCount = count;
  }
}

interface JobCardFromLinks {
  jobId: string;
  href: string;
  text: string;
}

/**
 * SDUI posted-jobs page: cards have no stable selectors, but every card links to its applicants
 * (…?jobId=<id>). Climb from each such anchor to the smallest ancestor that mentions applicants.
 */
async function collectJobCards(page: Page): Promise<JobCardFromLinks[]> {
  try {
    return await page.evaluate(() => {
      const out: Array<{ jobId: string; href: string; text: string }> = [];
      const seen = new Set<string>();
      const anchors = Array.from(document.querySelectorAll('a[href*="jobId="], a[href*="/hiring/jobs/"], a[href*="/jobs/view/"]'));
      for (const a of anchors) {
        const href = (a as HTMLAnchorElement).href;
        const m = /[?&]jobId=(\d+)/.exec(href) ?? /\/hiring\/jobs\/(\d+)/.exec(href) ?? /\/jobs\/view\/(\d+)/.exec(href);
        if (!m) continue;
        const id = m[1]!;
        let row: HTMLElement = a as HTMLElement;
        let found = false;
        for (let i = 0; i < 10 && row.parentElement; i++) {
          const p = row.parentElement as HTMLElement;
          const txt = p.innerText ?? '';
          if (/applicants?/i.test(txt) && txt.length < 2500) {
            row = p;
            found = true;
            break;
          }
          row = p;
        }
        if (!found) continue;
        const text = (row.innerText ?? '').trim();
        // the same card may be reached from several anchors; keep the smallest text per id
        const prev = out.find((o) => o.jobId === id);
        if (prev) {
          if (text.length && text.length < prev.text.length) prev.text = text;
          continue;
        }
        seen.add(id);
        out.push({ jobId: id, href, text: text.slice(0, 1500) });
      }
      return out;
    });
  } catch {
    return [];
  }
}

async function scrapeTab(ctx: ScrapeContext, tab: PostedJobsTab, url: string, stateLabel?: string): Promise<{ jobs: JobPosting[]; tabUrls: string[] }> {
  const { page, human, db, log } = ctx;
  const mark = ctx.capture.mark();
  await human.goto(page, url);
  await ctx.assertHealthy();
  await human.pause('read');
  const gen = await ctx.generation();
  if (tab === 'closed' && !/jobState=/i.test(page.url())) {
    // The query param did not stick, use the tab control instead.
    const closedTab = await firstVisible(page, SEL[gen].jobs.closedTab, { timeoutMs: 3000 });
    if (closedTab) {
      await human.click(page, closedTab);
      await human.pause('short');
    }
  }
  await loadAllCards(ctx, gen);

  const cards = await allOfFirst(page, SEL[gen].jobs.card);
  const byId = new Map<string, JobPosting>();
  const now = new Date().toISOString();
  for (const card of cards) {
    const link = await firstPresent(card, SEL[gen].jobs.link);
    const href = await attrOf(link, 'href');
    const jobId = href ? parseJobId(href) : undefined;
    if (!jobId) continue;
    const text = (await textOf(card)) ?? '';
    const parsed = parseJobCardText(text, tab);
    const title = parsed.title ?? (await textOf(link)) ?? `Job ${jobId}`;
    const job: JobPosting = {
      jobId,
      title,
      companyName: parsed.companyName,
      location: parsed.location,
      workplaceType: parsed.workplaceType,
      status: stateLabel && stateLabel !== 'CLOSED' ? mapJobStatus(stateLabel.replace(/_/g, ' '), tab) : parsed.status,
      postedAt: relativeToIso(parsed.postedAgo),
      applicantCount: parsed.applicantCount,
      url: URLS.applicants(jobId),
      raw: { cardText: text, tab: stateLabel ?? tab },
      syncedAt: now,
    };
    const prev = byId.get(jobId);
    byId.set(jobId, prev ? { ...prev, ...job, applicantCount: job.applicantCount ?? prev.applicantCount } : job);
  }

  // SDUI page: no selector matched a card → climb from the applicants links to their cards
  if (!byId.size) {
    for (const c of await collectJobCards(page)) {
      const parsed = parseJobCardText(c.text, tab);
      byId.set(c.jobId, {
        jobId: c.jobId,
        title: parsed.title ?? `Job ${c.jobId}`,
        companyName: parsed.companyName,
        location: parsed.location,
        workplaceType: parsed.workplaceType,
        status: stateLabel && stateLabel !== 'CLOSED' ? mapJobStatus(stateLabel.replace(/_/g, ' '), tab) : parsed.status,
        postedAt: relativeToIso(parsed.postedAgo),
        closedAt: relativeToIso(parsed.closedAgo),
        applicantCount: parsed.applicantCount,
        url: URLS.applicants(c.jobId),
        raw: { cardText: c.text, tab: stateLabel ?? tab, fromLinkClimb: true },
        syncedAt: now,
      });
    }
  }

  // Fallback: any job links on the page whose card we still could not read
  const links = await collectLinks(page);
  for (const l of links) {
    const jobId = parseJobId(l.href);
    if (jobId && !byId.has(jobId) && l.text && l.text.length > 2 && !/view applicants|manage/i.test(l.text)) {
      byId.set(jobId, { jobId, title: l.text.split('\n')[0]!.trim(), status: stateLabel ? mapJobStatus(stateLabel.replace(/_/g, ' '), tab) : tab === 'closed' ? 'closed' : 'open', url: URLS.applicants(jobId), raw: { fromLink: true, tab: stateLabel ?? tab }, syncedAt: now });
    }
  }

  const text = await mainText(page);
  await ctx.capture.drain();
  writeJson(path.join(ctx.cfg.debugDir, 'jobs', `raw-posted-jobs-${tab}.json`), {
    url: page.url(),
    capturedAt: now,
    generation: gen,
    cardsFound: cards.length,
    text: text.slice(0, 100_000),
    links,
    captured: ctx.capture.since(mark).map((e) => ({ url: e.url, kind: e.kind, status: e.status, json: e.json ?? e.body.slice(0, 200_000) })),
  });

  const jobs = [...byId.values()];
  if (!jobs.length && tab === 'open' && !stateLabel && !/no (posted |open |active )?jobs|you haven'?t posted|post a (free )?job|nothing to see/i.test(text)) {
    throw new SelectorNotFoundError('posted job cards', SEL[gen].jobs.card, page.url());
  }
  for (const j of jobs) db.upsertJob(j);
  const tabUrls = [...new Set(links.map((l) => l.href).filter((h) => /posted-jobs/.test(h) && /jobState=/.test(h)))];
  log.info('posted jobs tab scraped', { tab: stateLabel ?? tab, jobs: jobs.length, generation: gen, tabsDiscovered: tabUrls.length });
  return { jobs, tabUrls };
}
