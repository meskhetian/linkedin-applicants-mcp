import fs from 'node:fs';
import path from 'node:path';
import type { Download, Locator, Page, Route } from 'patchright';
import type { ApplicantRating, ApplicationDetailResult, ScreeningAnswer } from '../types.js';
import type { ScrapeContext } from './context.js';
import type { Generation } from './selectors.js';
import { SEL } from './selectors.js';
import { URLS, detectUiVariantFromUrl, looksLikeResumeUrl, normalizeProfileUrl, parseApplicationId } from './urls.js';
import { allOfFirst, attrOf, collectLinks, extractEmail, extractPhone, firstPresent, firstVisible, mainText, relativeToIso, textOf } from './dom.js';
import { extFromContentType, extFromFileName, writeJson } from '../storage/files.js';
import { errorMessage } from '../errors.js';
import { parseAppliedOn } from './applicants.js';

export interface FetchApplicationOptions {
  downloadResume: boolean;
  /** Directory to save the resume + raw snapshots into (already created) */
  saveDir: string;
}

const RESUME_EXTS = new Set(['pdf', 'docx', 'doc', 'rtf', 'txt']);

// ---------------- pure helpers (unit-tested) ----------------

/** "attachment; filename=\"Jane.pdf\"" / RFC 5987 filename*=UTF-8''J%C3%A4ne.pdf → file name */
export function filenameFromContentDisposition(cd: string | null | undefined): string | undefined {
  if (!cd) return undefined;
  const star = /filename\*\s*=\s*(?:[\w-]+)?'[^']*'([^;]+)/i.exec(cd);
  if (star?.[1]) {
    const v = star[1].trim().replace(/^"|"$/g, '');
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(cd);
  if (quoted?.[1]) return quoted[1].trim();
  const plain = /filename\s*=\s*([^;]+)/i.exec(cd);
  return plain?.[1]?.trim() || undefined;
}

export function sniffExt(bytes: Buffer | Uint8Array): string | undefined {
  const b = Buffer.from(bytes.subarray(0, 8));
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'docx';
  if (b.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'doc';
  if (b.subarray(0, 5).toString('latin1') === '{\\rtf') return 'rtf';
  return undefined;
}

export function pickResumeExt(input: { fileName?: string; contentType?: string | null; bytes?: Buffer | Uint8Array }): string {
  if (input.bytes) {
    const s = sniffExt(input.bytes);
    if (s) return s;
  }
  const fromName = extFromFileName(input.fileName);
  if (fromName && RESUME_EXTS.has(fromName)) return fromName;
  return extFromContentType(input.contentType, 'pdf');
}

const ACTION_LINE = /^(message|good fit|maybe|not a fit|top fit|more|more actions|share|forward|resume|download|download resume|view resume|view profile|save|note|notes|add a note|rate|dismiss|close|back|applicants|applied via linkedin|applied via easy apply|easy apply|new|viewed|unread|shortlisted|contacted|rejected|hired|in review|contact info|skip to (main )?content|home|my network|jobs|messaging|notifications|me|for business)$/i;
const LOCATION_LIKE = /^\p{Lu}[\p{L}\p{M}.'-]+(?:, \p{Lu}[\p{L}\p{M}. '-]+)+$/u;

export function parseDetailHeaderText(text: string): { fullName?: string; headline?: string; location?: string; appliedAgo?: string } {
  const lines: string[] = [];
  for (const raw of text.slice(0, 4000).split(/\r?\n/)) {
    const l = raw.replace(/\s+/g, ' ').replace(/\s*·\s*(1st|2nd|3rd|3rd\+)\s*$/i, '').trim();
    if (l && lines[lines.length - 1] !== l) lines.push(l);
  }
  const appliedAgo = lines.find((l) => /^applied\b/i.test(l) || (/\bago\b/i.test(l) && l.length < 60));
  const rest = lines.filter((l) => l !== appliedAgo && !ACTION_LINE.test(l) && !/^\d+(st|nd|rd|th)$/.test(l) && !/^(1st|2nd|3rd)\b/i.test(l));
  const nameIdx = rest.findIndex((l) => l.length >= 2 && l.length <= 60 && !/\d/.test(l) && !/[@|:/]/.test(l) && !/applicant/i.test(l));
  if (nameIdx < 0) return { appliedAgo };
  const fullName = rest[nameIdx];
  const after = rest.slice(nameIdx + 1, nameIdx + 5);
  const headline = after.find((l) => l.length > 2 && !LOCATION_LIKE.test(l) && !/^(remote|hybrid)$/i.test(l));
  const location = after.find((l) => l !== headline && /,/.test(l) && l.length < 80 && !/[.!?]$/.test(l));
  return { fullName, headline, location, appliedAgo };
}

const SHORT_ANSWER = /^(yes|no|\d+(\.\d+)?( years?| yrs?)?|\d+\s*[-–]\s*\d+|true|false|n\/a|none|[a-z ]{1,40})$/i;

/**
 * Pair screening questions with the applicant's answers from rendered text such as
 *   "Screening questions\nHow many years of Python experience do you have?\n5\nIdeal answer: 3\nAre you legally authorized to work in Germany?\nYes\nMeets requirement"
 */
export function parseScreeningText(text: string): ScreeningAnswer[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\s+/g, ' ').trim();
    if (l && lines[lines.length - 1] !== l) lines.push(l);
  }
  let startIdx = lines.findIndex((l) => /screening question|screening questions|qualification/i.test(l));
  startIdx = startIdx < 0 ? 0 : startIdx + 1;
  const body = lines.slice(startIdx).filter((l) => !/^(must-have|preferred|required|optional)( qualifications?)?:?$/i.test(l));
  const out: ScreeningAnswer[] = [];
  let i = 0;
  while (i < body.length) {
    const line = body[i]!;
    const isQuestion = /\?$/.test(line) || (i + 1 < body.length && SHORT_ANSWER.test(body[i + 1]!) && line.length > 12 && !/^(ideal answer|meets|does not meet|answer)/i.test(line));
    if (!isQuestion) {
      i++;
      continue;
    }
    let answer = '';
    let j = i + 1;
    const notes: string[] = [];
    while (j < body.length && !/\?$/.test(body[j]!)) {
      const l = body[j]!;
      const ideal = /^ideal answer:?\s*(.+)$/i.exec(l);
      const explicit = /^(answer|response):?\s*(.+)$/i.exec(l);
      if (ideal) notes.push(`ideal: ${ideal[1]!.trim()}`);
      else if (/^(meets|does not meet|doesn't meet)( the)? requirement/i.test(l)) notes.push(l.toLowerCase());
      else if (explicit) answer ||= explicit[2]!.trim();
      else if (!answer) answer = l;
      else if (l.length < 120 && !SHORT_ANSWER.test(l) && j - i < 3) answer += ` ${l}`;
      j++;
    }
    if (answer) out.push({ question: line.replace(/^\d+[.)]\s*/, ''), answer: notes.length ? `${answer} (${notes.join('; ')})` : answer });
    i = Math.max(j, i + 1);
  }
  return out;
}

// ---------------- main ----------------

/**
 * Open the applicant detail (legacy page or Hiring Pro pane), read header + contact + screening answers + rating,
 * download the resume, and store raw snapshots for offline re-parsing. Strictly read-only: never rates, notes or messages.
 */
export async function fetchApplicationDetail(ctx: ScrapeContext, jobId: string, applicationId: string, opts: FetchApplicationOptions): Promise<ApplicationDetailResult> {
  const { page, human, log } = ctx;
  const mark = ctx.capture.mark();
  await human.goto(page, URLS.applicantDetail(jobId, applicationId));
  await ctx.assertHealthy();
  await human.pause('short');

  // Legacy detail URL may land on the Hiring Pro list (without the applicant) or a not-found page → use the Pro URL.
  let variant = detectUiVariantFromUrl(page.url()) ?? 'legacy';
  const landedText = await mainText(page, 6000);
  if ((variant === 'hiring_pro' && parseApplicationId(page.url()) !== applicationId) || /page not found|this page doesn.t exist|something went wrong/i.test(landedText)) {
    await human.pause('short');
    await human.goto(page, URLS.applicantDetailPro(jobId, applicationId));
    await ctx.assertHealthy();
    variant = 'hiring_pro';
  }
  await human.pause('read');
  await human.scrollBy(page, 220);
  await human.pauseMs(400, 1200);

  const gen = await ctx.generation();
  // Hiring Pro renders list + detail side by side: isolate the detail pane (the innermost block holding the
  // "View full profile" link and the Resume control) so header parsing does not pick up the first list row.
  const panel = variant === 'hiring_pro' ? await locateProDetailPane(page) : await firstVisible(page, SEL[gen].detail.panel, { timeoutMs: 5000 });
  const root: Locator | Page = panel ?? page;
  const text = panel ? ((await textOf(panel)) ?? (await mainText(page))) : await mainText(page);
  const links = await collectLinks(page);
  const header = parseDetailHeaderText(text);

  const fullName = cleanName((await textOf(await firstVisible(root, SEL[gen].detail.name, { timeoutMs: 1500 }))) ?? header.fullName);
  const headline = (await textOf(await firstVisible(root, SEL[gen].detail.headline, { timeoutMs: 400 }))) ?? header.headline;
  const location = (await textOf(await firstVisible(root, SEL[gen].detail.location, { timeoutMs: 400 }))) ?? header.location;
  const appliedAgo = header.appliedAgo ?? (await textOf(await firstVisible(root, SEL[gen].detail.appliedAgo, { timeoutMs: 400 })));
  const profileHref = (await attrOf(await firstPresent(root, SEL[gen].detail.profileLink), 'href')) ?? links.find((l) => /linkedin\.com\/in\//i.test(l.href))?.href;
  const profileUrl = normalizeProfileUrl(profileHref);
  const profileUrn = findProfileUrn(ctx, mark);
  const rating = await detectRatingOnPage(page, gen);

  // Contact info shared with the application: mailto:/tel: links, a "Contact" button (Hiring Pro) or the legacy "More" menu
  let email = extractEmail(text) ?? links.find((l) => l.href.startsWith('mailto:'))?.href.slice(7);
  let phone = extractPhone(text) ?? links.find((l) => l.href.startsWith('tel:'))?.href.slice(4);
  let contactText = '';
  if (!email || !phone) {
    const more = (await firstVisible(root, SEL[gen].detail.contactButton, { timeoutMs: 1200 })) ?? (await firstVisible(root, SEL[gen].detail.moreButton, { timeoutMs: 1000 }));
    if (more) {
      try {
        const bodyBefore = await page.evaluate(() => document.body.innerText).catch(() => '');
        await human.click(page, more);
        await human.pause('short');
        for (const it of await allOfFirst(page, SEL[gen].detail.contactItems)) contactText += `${(await textOf(it)) ?? ''}\n`;
        // Popovers without ARIA roles: whatever text appeared after the click is the contact card.
        const bodyAfter = await page.evaluate(() => document.body.innerText).catch(() => '');
        const seen = new Set(bodyBefore.split('\n').map((l) => l.trim()));
        const appeared = bodyAfter
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !seen.has(l));
        if (appeared.length) contactText += `${appeared.join('\n')}\n`;
        const popover = await page
          .evaluate(() => {
            const roots = Array.from(document.querySelectorAll('[role="menu"], [role="dialog"], [role="tooltip"], .artdeco-dropdown__content'));
            return {
              text: roots.map((r) => (r as HTMLElement).innerText ?? '').join('\n').slice(0, 5000),
              links: Array.from(document.querySelectorAll('[role="menu"] a[href], [role="dialog"] a[href], [role="tooltip"] a[href], .artdeco-dropdown__content a[href], a[href^="mailto:"], a[href^="tel:"]')).map((a) => (a as HTMLAnchorElement).href),
            };
          })
          .catch(() => ({ text: '', links: [] as string[] }));
        contactText += popover.text;
        email ??= extractEmail(contactText) ?? popover.links.find((h) => h.startsWith('mailto:'))?.slice(7);
        phone ??= extractPhone(contactText) ?? popover.links.find((h) => h.startsWith('tel:'))?.slice(4);
      } catch (e) {
        log.debug('contact dropdown failed', { error: errorMessage(e) });
      } finally {
        await page.keyboard.press('Escape').catch(() => {});
        await human.pauseMs(300, 900);
      }
    }
  }

  // Qualifications (Hiring Pro): must-have / preferred statements and the applicant's match
  const qualificationsText = extractQualificationsText(text);

  // Screening questions
  const screeningSection = await firstVisible(root, SEL[gen].detail.screeningSection, { timeoutMs: 800 });
  const screeningText = (await textOf(screeningSection)) ?? sliceAfter(text, /screening question/i);
  const screeningAnswers = parseScreeningText(screeningText ?? '');

  // Resume
  let resume: ResumeOutcome = { strategy: 'none', hasResume: false };
  if (opts.downloadResume) {
    resume = await downloadResume(ctx, gen, root, links, opts.saveDir);
  } else {
    resume.hasResume = !!(await firstPresent(root, [...SEL[gen].detail.resumeButton, ...SEL[gen].detail.resumeAttachment, ...SEL[gen].detail.downloadResumeLink]));
  }

  await ctx.capture.drain();
  writeJson(path.join(opts.saveDir, 'raw-application.json'), {
    url: page.url(),
    capturedAt: new Date().toISOString(),
    generation: gen,
    uiVariant: variant,
    text,
    links,
    contactText,
    screeningText,
    qualificationsText,
    resume,
    captured: ctx.capture
      .since(mark)
      .filter((e) => /hiring|applicant|jobApplication|jobPosting|ambry|dms|mediaauth/i.test(e.url))
      .map((e) => ({ url: e.url, kind: e.kind, status: e.status, json: e.json ?? e.body.slice(0, 200_000) })),
  });

  log.info('application detail parsed', { jobId, applicationId, variant, name: fullName, hasEmail: !!email, hasPhone: !!phone, screening: screeningAnswers.length, resume: resume.strategy, rating });
  return {
    applicationId,
    jobId,
    fullName,
    headline,
    location,
    profileUrl,
    profileUrn,
    appliedAt: parseAppliedOn(appliedAgo) ?? relativeToIso(appliedAgo),
    rating,
    email,
    phone,
    screeningAnswers,
    hasResume: resume.hasResume,
    resumePath: resume.path,
    resumeFileName: resume.fileName,
    extra: { rawTextChars: text.length, resumeStrategy: resume.strategy, resumeHost: resume.host, generation: gen, uiVariant: variant, appliedAgo, qualificationsText, resumeDebug: resume.debug },
    raw: { headerText: text.slice(0, 1500) },
  };
}

/**
 * The Hiring Pro detail pane: the innermost block that spans from the applicant header (profile link, "Applied …",
 * Resume control) down to the "View full profile" link at the bottom, so it includes the Contact button, the
 * Qualifications section and the experience summary. Header-only blocks are used only as a last resort.
 */
async function locateProDetailPane(page: Page): Promise<Locator | null> {
  const selectors = [
    'div:has(a[href*="/in/"]):has(a:has-text("View full profile")):has(:text-matches("^Applied", "i"))',
    'div:has(a[href*="/in/"]):has(a:has-text("View full profile")):has(:text-is("Resume"))',
    'div:has(a:has-text("View full profile")):has(:text-matches("^Applied", "i"))',
    'div:has(a[href*="/in/"]):has(:text-is("Resume"))',
    'div:has(a[href*="/in/"]):has(:text-matches("^Applied", "i"))',
    'div:has(a:has-text("View full profile"))',
  ];
  let fallback: Locator | null = null;
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel);
      const n = await loc.count();
      if (!n) continue;
      const candidate = loc.nth(n - 1);
      const len = ((await candidate.innerText({ timeout: 1500 }).catch(() => '')) ?? '').length;
      // A real pane carries the header plus the qualification / experience summary; a bare header is ~200 chars.
      if (len >= 400) return candidate;
      fallback ??= candidate;
    } catch {
      /* selector engine mismatch */
    }
  }
  return fallback;
}

/** Text between the first line matching `start` and the next line matching `end` (clipped), e.g. the Qualifications section. */
export function sliceBetween(text: string, start: RegExp, end: RegExp, maxChars = 6000): string | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim());
  const from = lines.findIndex((l) => start.test(l));
  if (from < 0) return undefined;
  let to = lines.findIndex((l, i) => i > from && end.test(l));
  if (to < 0) to = lines.length;
  const out = lines
    .slice(from, to)
    .filter((l, i, arr) => l && arr[i - 1] !== l)
    .join('\n')
    .trim();
  return out ? out.slice(0, maxChars) : undefined;
}

/** Hiring Pro shows the job's must-have / preferred qualifications and how the applicant scores against them. */
export function extractQualificationsText(paneText: string): string | undefined {
  return sliceBetween(paneText, /^qualifications$/i, /^(rate this ai-generated content|experience|education|about|skills)$/i);
}

function cleanName(n: string | undefined): string | undefined {
  if (!n) return undefined;
  const first = n.split('\n')[0]!.replace(/\s*·\s*(1st|2nd|3rd|3rd\+)\s*$/i, '').trim();
  return first || undefined;
}

function sliceAfter(text: string, re: RegExp): string | undefined {
  const m = re.exec(text);
  if (!m) return undefined;
  return text.slice(m.index, m.index + 4000);
}

/** The applicant's fsd_profile URN, if LinkedIn's own detail payload was captured. */
function findProfileUrn(ctx: ScrapeContext, mark: number): string | undefined {
  for (const e of ctx.capture.since(mark)) {
    if (!/hiring|applicant|jobApplication/i.test(e.url)) continue;
    const m = /urn:li:fsd_profile:[A-Za-z0-9_-]+/.exec(e.body);
    if (m) return m[0];
  }
  return undefined;
}

async function detectRatingOnPage(page: Page, gen: Generation): Promise<ApplicantRating> {
  const checks: Array<[ApplicantRating, string[]]> = [
    ['good_fit', SEL[gen].detail.ratingGoodFit],
    ['maybe', SEL[gen].detail.ratingMaybe],
    ['not_a_fit', SEL[gen].detail.ratingNotAFit],
  ];
  let anyFound = false;
  for (const [rating, sels] of checks) {
    const loc = await firstPresent(page, sels);
    if (!loc) continue;
    anyFound = true;
    const selected = await loc
      .evaluate((el) => {
        const a = el.getAttribute('aria-pressed') ?? el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected');
        if (a === 'true') return true;
        const cls = typeof el.className === 'string' ? el.className : '';
        return /selected|active|--is-selected|pressed/i.test(cls) || el.hasAttribute('data-selected');
      })
      .catch(() => false);
    if (selected) return rating;
  }
  return anyFound ? 'unrated' : 'unknown';
}

// ---------------- resume download ----------------

interface ResumeOutcome {
  path?: string;
  fileName?: string;
  strategy: 'attachment' | 'viewer' | 'intercept' | 'download' | 'popup' | 'none';
  hasResume: boolean;
  host?: string;
  /** What the page looked like after the Resume control was used, when no file could be retrieved. */
  debug?: Record<string, unknown>;
}

/** Snapshot of viewer-ish state (tabs, dialogs, frames, file-like URLs the page fetched) for offline debugging. */
async function resumeDebugInfo(ctx: ScrapeContext, mark: number): Promise<Record<string, unknown>> {
  const { page } = ctx;
  const dom = await page
    .evaluate(() => {
      const q = (sel: string) => Array.from(document.querySelectorAll(sel));
      return {
        dialogs: q('[role="dialog"], dialog').map((d) => ((d as HTMLElement).innerText ?? '').slice(0, 800)),
        frames: q('iframe[src], embed[src], object[data]').map((e) => e.getAttribute('src') ?? e.getAttribute('data') ?? ''),
        downloadish: q('a[download], a[href*=".pdf"], a[href*="ambry"], a[href*="/dms/"], a[href*="mediaauth"]').map((a) => (a as HTMLAnchorElement).href),
        buttons: q('[role="dialog"] button, dialog button').map((b) => ((b as HTMLElement).innerText || b.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 30),
      };
    })
    .catch(() => ({ dialogs: [], frames: [], downloadish: [], buttons: [] }));
  const tabs = page
    .context()
    .pages()
    .map((p) => p.url().slice(0, 200));
  const fetched = ctx.capture
    .since(mark)
    .filter((e) => /pdf|ambry|\/dms\/|mediaauth|resume|document/i.test(`${e.url} ${e.contentType}`))
    .map((e) => ({ url: e.url.slice(0, 200), status: e.status, contentType: e.contentType }))
    .slice(0, 20);
  return { url: page.url(), tabs, ...dom, fetched };
}

interface Saved {
  path: string;
  fileName?: string;
  host?: string;
}

/** Pure decision for an intercepted response: is this a resume file, and must it be kept away from Chrome's download manager? */
export function decideResumeIntercept(input: {
  url: string;
  resourceType: string;
  contentType?: string | null;
  contentDisposition?: string | null;
  bytes: Buffer;
  fromWorkingPage: boolean;
}): { isFile: boolean; swallow: boolean } {
  const ct = input.contentType ?? '';
  const cd = input.contentDisposition ?? '';
  const isFile = !!sniffExt(input.bytes) || /application\/(pdf|msword|vnd\.openxmlformats-officedocument|octet-stream|rtf)/i.test(ct) || /attachment/i.test(cd);
  // A navigation to a file (same tab or popup) or any attachment would start a Chrome download: answer it ourselves.
  const swallow = isFile && (input.resourceType === 'document' || /attachment/i.test(cd) || !input.fromWorkingPage);
  return { isFile, swallow };
}

/**
 * Captures the resume at the network layer so Chrome's download manager never starts. Chrome 154 crashed its
 * browser process three times in a row the moment an automation-triggered download began, so requests that
 * look like a resume file (or any navigation inside a popup we opened) are fetched through the browser's own
 * network stack (route.fetch: same cookies and headers), saved, and then answered with 204 when they would have
 * become a download, or passed through unchanged when LinkedIn's inline viewer requested them.
 */
class ResumeTrap {
  private saved: Saved | undefined;
  private resolvers: Array<(s: Saved | undefined) => void> = [];
  private armed = false;
  readonly seen: string[] = [];

  constructor(
    private readonly ctx: ScrapeContext,
    private readonly saveDir: string,
  ) {}

  private readonly handler = async (route: Route): Promise<void> => {
    const req = route.request();
    const url = req.url();
    let fromWorkingPage = true;
    try {
      fromWorkingPage = req.frame().page() === this.ctx.page;
    } catch {
      /* detached frame */
    }
    const candidate = looksLikeResumeUrl(url) || (!fromWorkingPage && (req.resourceType() === 'document' || req.isNavigationRequest()));
    if (!candidate) {
      await route.continue().catch(() => {});
      return;
    }
    this.seen.push(url.slice(0, 200));
    try {
      const resp = await route.fetch({ maxRedirects: 5 });
      const headers = resp.headers();
      const body = await resp.body();
      const { isFile, swallow } = decideResumeIntercept({
        url,
        resourceType: req.resourceType(),
        contentType: headers['content-type'],
        contentDisposition: headers['content-disposition'],
        bytes: body,
        fromWorkingPage,
      });
      if (isFile && !this.saved) {
        const s = saveBytes(body, headers['content-type'], headers['content-disposition'], resp.url(), this.saveDir);
        if (s) {
          this.saved = { ...s, host: safeHost(resp.url()) };
          this.ctx.log.debug('resume captured at the network layer', { url: url.slice(0, 200), bytes: body.length, swallow });
          this.settle();
        }
      }
      if (swallow) await route.fulfill({ status: 204, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
      else await route.fulfill({ response: resp, body });
    } catch (e) {
      this.ctx.log.debug('resume intercept failed', { url: url.slice(0, 200), error: errorMessage(e) });
      // Never let a navigation to a file reach the download manager, even when our own fetch failed.
      if (req.resourceType() === 'document' && looksLikeResumeUrl(url)) await route.abort('aborted').catch(() => {});
      else await route.continue().catch(() => {});
    }
  };

  async arm(): Promise<void> {
    if (this.armed) return;
    this.armed = true;
    await this.ctx.page.context().route('**/*', this.handler);
  }

  async disarm(): Promise<void> {
    if (!this.armed) return;
    this.armed = false;
    await this.ctx.page.context().unroute('**/*', this.handler).catch(() => {});
    this.settle();
  }

  result(): Saved | undefined {
    return this.saved;
  }

  /** Resolves with the captured file, or undefined after `timeoutMs`. */
  wait(timeoutMs: number): Promise<Saved | undefined> {
    if (this.saved) return Promise.resolve(this.saved);
    return new Promise((resolve) => {
      const done = (s: Saved | undefined) => {
        clearTimeout(timer);
        resolve(s);
      };
      const timer = setTimeout(() => {
        this.resolvers = this.resolvers.filter((r) => r !== done);
        resolve(undefined);
      }, timeoutMs);
      this.resolvers.push(done);
    });
  }

  private settle(): void {
    const rs = this.resolvers;
    this.resolvers = [];
    for (const r of rs) r(this.saved);
  }
}

/**
 * Layered capture, in order: direct file href on the page → "Download resume" link/menu item → Resume control
 * (which may open a viewer with an iframe/embed, open the signed URL in a NEW TAB, or expose a Download control).
 * Every click runs with the network trap armed, so the file is read from the response itself; Chrome's download
 * manager is never involved (downloads are denied at the context level and cancelled if one still starts).
 */
async function downloadResume(ctx: ScrapeContext, gen: Generation, root: Locator | Page, links: Array<{ href: string; text: string }>, saveDir: string): Promise<ResumeOutcome> {
  const { page, human, log } = ctx;
  const mark = ctx.capture.mark();
  const closeViewer = async () => {
    const d = await firstVisible(page, SEL[gen].detail.dismiss, { timeoutMs: 800 });
    if (d) await human.click(page, d, { noScroll: true }).catch(() => {});
    else await page.keyboard.press('Escape').catch(() => {});
    await human.pauseMs(300, 900);
  };

  // (a) direct file hrefs already on the page
  const att = await firstPresent(root, SEL[gen].detail.resumeAttachment);
  const attHref = await attrOf(att, 'href');
  const candidates = [attHref, ...links.map((l) => l.href)].filter((h): h is string => !!h && looksLikeResumeUrl(h));
  for (const url of [...new Set(candidates)].slice(0, 2)) {
    const saved = await fetchResume(ctx, absolutize(url, page.url()), saveDir);
    if (saved) return { ...saved, strategy: 'attachment', hasResume: true };
  }

  const trap = new ResumeTrap(ctx, saveDir);
  const downloadsSeen: string[] = [];
  const onDownload = (dl: Download) => {
    downloadsSeen.push(dl.url().slice(0, 200));
    log.warn('Chrome started a download despite the network trap; cancelling it', { url: dl.url().slice(0, 200) });
    dl.cancel().catch(() => {});
  };
  await trap.arm();
  page.on('download', onDownload);
  try {
    // (b) legacy "Download resume" link (direct) or menu item under "More"
    const dlLink = await firstVisible(root, SEL[gen].detail.downloadResumeLink, { timeoutMs: 600 });
    if (dlLink) {
      const href = await attrOf(dlLink, 'href');
      if (href && looksLikeResumeUrl(href)) {
        const saved = await fetchResume(ctx, absolutize(href, page.url()), saveDir);
        if (saved) return { ...saved, strategy: 'attachment', hasResume: true };
      }
      const got = await clickAndTrap(ctx, dlLink, trap, saveDir, 8000);
      if (got) return { ...got, hasResume: true };
    } else {
      const more = await firstVisible(root, SEL[gen].detail.moreButton, { timeoutMs: 500 });
      if (more) {
        await human.click(page, more);
        await human.pause('short');
        const item = await firstVisible(page, SEL[gen].detail.downloadResumeLink, { timeoutMs: 1500 });
        if (item) {
          const got = await clickAndTrap(ctx, item, trap, saveDir, 8000);
          if (got) return { ...got, hasResume: true };
        }
        await page.keyboard.press('Escape').catch(() => {});
        await human.pauseMs(300, 800);
      }
    }

    // (c) Resume control → popup with the signed URL / viewer / direct file
    const btn = (await firstVisible(root, SEL[gen].detail.resumeButton, { timeoutMs: 1500 })) ?? (await firstVisible(page, SEL[gen].detail.resumeButton, { timeoutMs: 500 }));
    if (!btn) {
      const t = await mainText(page, 20_000);
      return { strategy: 'none', hasResume: /\bresume\b|\bcv\b/i.test(t) && !/no resume/i.test(t) };
    }
    const btnHref = await attrOf(btn, 'href');
    if (btnHref && looksLikeResumeUrl(btnHref)) {
      const saved = await fetchResume(ctx, absolutize(btnHref, page.url()), saveDir);
      if (saved) return { ...saved, strategy: 'attachment', hasResume: true };
    }
    const direct = await clickAndTrap(ctx, btn, trap, saveDir, 8000);
    if (direct) return { ...direct, hasResume: true };

    // viewer opened: look for the file inside it
    let url: string | undefined;
    for (let i = 0; i < 3 && !url; i++) {
      const frame = await firstPresent(page, SEL[gen].detail.viewerFrame);
      url = (await attrOf(frame, 'src')) ?? (await attrOf(frame, 'data')) ?? undefined;
      if (!url || !looksLikeResumeUrl(url)) {
        const srcs = await page
          .evaluate(() =>
            Array.from(document.querySelectorAll('[role="dialog"] a[href], dialog a[href], .artdeco-modal a[href], iframe[src], embed[src], object[data]')).map(
              (e) => (e as HTMLAnchorElement).href || e.getAttribute('src') || e.getAttribute('data') || '',
            ),
          )
          .catch(() => [] as string[]);
        url = srcs.find((s) => looksLikeResumeUrl(s));
      }
      if (!url) await human.pauseMs(800, 1600);
    }
    const trapped = trap.result();
    if (trapped) {
      await closeViewer();
      return { ...trapped, strategy: 'intercept', hasResume: true };
    }
    if (url && looksLikeResumeUrl(url)) {
      const saved = await fetchResume(ctx, absolutize(url, page.url()), saveDir);
      if (saved) {
        await closeViewer();
        return { ...saved, strategy: 'viewer', hasResume: true };
      }
    }

    // (d) Download control inside the viewer
    const dlBtn = await firstVisible(page, SEL[gen].detail.downloadButton, { timeoutMs: 2000 });
    if (dlBtn) {
      const got = await clickAndTrap(ctx, dlBtn, trap, saveDir, 12_000, true);
      if (got) {
        await closeViewer();
        return { ...got, hasResume: true };
      }
    }
    const debug = await resumeDebugInfo(ctx, mark);
    debug.trapSeen = trap.seen.slice(0, 20);
    debug.downloadsSeen = downloadsSeen;
    await closeViewer();
    log.warn('resume control found but no file could be retrieved', { url: page.url(), viewerUrl: url, tabs: debug.tabs, frames: debug.frames, fetched: debug.fetched, trapSeen: debug.trapSeen });
    return { strategy: 'none', hasResume: true, debug };
  } finally {
    page.off('download', onDownload);
    await trap.disarm();
  }
}

/**
 * Click a control with the network trap armed and collect whatever it produces: a file answered at the network
 * layer (same tab or popup), or a popup whose URL we can fetch ourselves. Popups are closed only after the trap
 * has settled, so no download is ever in flight when a tab goes away. Returns undefined when a viewer opened
 * instead (the caller inspects the DOM).
 */
async function clickAndTrap(ctx: ScrapeContext, control: Locator, trap: ResumeTrap, saveDir: string, timeoutMs: number, noScroll = false): Promise<(Saved & { strategy: ResumeOutcome['strategy'] }) | undefined> {
  const { page, human, log } = ctx;
  const popupP = page.waitForEvent('popup', { timeout: Math.min(timeoutMs, 6000) }).catch(() => null);
  await human.click(page, control, { noScroll });
  await human.pause('short');
  let saved = await trap.wait(timeoutMs);
  const popup = await popupP;
  if (popup) {
    try {
      if (!saved) {
        await popup.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
        const url = popup.url();
        log.debug('resume popup opened', { url: url.slice(0, 200) });
        if (looksLikeResumeUrl(url) || /ambry|dms|mediaauth|licdn/i.test(url)) {
          saved = (await fetchResume(ctx, url, saveDir)) ?? (await fetchResume(ctx, url, saveDir, popup));
          if (saved) return { ...saved, strategy: 'popup' };
        }
        saved = await trap.wait(3000);
      }
    } finally {
      await popup.close().catch(() => {});
      await page.bringToFront().catch(() => {});
    }
  }
  return saved ? { ...saved, strategy: 'intercept' } : undefined;
}

function absolutize(url: string, base: string): string {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

/** Fetch from inside a page (cookies, referer, UA are the browser's); falls back to the context request API (any host). */
async function fetchResume(ctx: ScrapeContext, url: string, saveDir: string, from?: Page): Promise<Saved | undefined> {
  const page = from ?? ctx.page;
  const host = safeHost(url);
  try {
    const res = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      if (!r.ok) throw new Error(`resume fetch ${r.status}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { b64: btoa(s), ct: r.headers.get('content-type'), cd: r.headers.get('content-disposition'), finalUrl: r.url };
    }, url);
    const saved = saveBytes(Buffer.from(res.b64, 'base64'), res.ct, res.cd, res.finalUrl || url, saveDir);
    if (saved) return { ...saved, host };
    ctx.log.debug('resume url returned html/empty (login wall or expired link)', { url: url.slice(0, 200), ct: res.ct });
  } catch (e) {
    ctx.log.debug('in-page resume fetch failed; trying context request', { url: url.slice(0, 200), error: errorMessage(e) });
  }
  try {
    const r = await ctx.page.context().request.get(url, { headers: { referer: 'https://www.linkedin.com/' }, maxRedirects: 5, timeout: 30_000 });
    if (!r.ok()) return undefined;
    const saved = saveBytes(await r.body(), r.headers()['content-type'], r.headers()['content-disposition'], r.url(), saveDir);
    return saved ? { ...saved, host } : undefined;
  } catch (e) {
    ctx.log.debug('context request for resume failed', { url: url.slice(0, 200), error: errorMessage(e) });
    return undefined;
  }
}

function saveBytes(bytes: Buffer, contentType: string | null | undefined, contentDisposition: string | null | undefined, finalUrl: string, saveDir: string): { path: string; fileName?: string } | undefined {
  const sniffed = sniffExt(bytes);
  if (bytes.length < 200 || (!sniffed && /text\/html/i.test(contentType ?? '')) || (!sniffed && /^\s*<(!doctype|html)/i.test(bytes.subarray(0, 64).toString('latin1')))) return undefined;
  const fileName = filenameFromContentDisposition(contentDisposition) ?? fileNameFromUrl(finalUrl);
  const ext = pickResumeExt({ fileName, contentType, bytes });
  const out = path.join(saveDir, `resume.${ext}`);
  fs.writeFileSync(out, bytes);
  return { path: out, fileName };
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function fileNameFromUrl(url: string): string | undefined {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
    return /\.(pdf|docx?|rtf|txt)$/i.test(last) ? last : undefined;
  } catch {
    return undefined;
  }
}

