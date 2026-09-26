import fs from 'node:fs';
import path from 'node:path';
import type { Download, Locator, Page, Request, Response, Route } from 'patchright';
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

  // Contact info shared with the application: mailto:/tel: links, a "Contact" button (Hiring Pro) or the legacy "More" menu.
  // Only the header part of the pane is scanned for free text: the experience section below holds year ranges.
  const headerText = text.split(/\n\s*(qualifications|screening questions?|experience)\s*\n/i)[0] ?? text;
  let email = extractEmail(headerText) ?? links.find((l) => l.href.startsWith('mailto:'))?.href.slice(7);
  let phone = extractPhone(headerText) ?? links.find((l) => l.href.startsWith('tel:'))?.href.slice(4);
  let contactText = '';
  const contactDiag: Record<string, unknown> = { found: false, clicked: false };
  if (!email || !phone) {
    const more =
      (await firstVisible(root, SEL[gen].detail.contactButton, { timeoutMs: 1200 })) ??
      (await firstVisible(root, ['button:text-matches("^\\s*Contact( info)?\\s*$", "i")'], { timeoutMs: 400 })) ??
      (await firstVisible(root, SEL[gen].detail.moreButton, { timeoutMs: 1000 }));
    contactDiag.found = !!more;
    if (more) {
      try {
        const bodyBefore = await page.evaluate(() => document.body.innerText).catch(() => '');
        await human.click(page, more);
        contactDiag.clicked = true;
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
        contactDiag.popoverChars = contactText.length;
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
    contact: contactDiag,
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
    extra: { rawTextChars: text.length, resumeStrategy: resume.strategy, resumeHost: resume.host, generation: gen, uiVariant: variant, appliedAgo, qualificationsText, resumeDebug: resume.debug, contact: contactDiag },
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
  strategy: 'attachment' | 'viewer' | 'intercept' | 'popup' | 'none';
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
    .map((p) => redactUrl(p.url()));
  const fetched = ctx.capture
    .since(mark)
    .filter((e) => /pdf|ambry|\/dms\/|mediaauth|resume|document/i.test(`${e.url} ${e.contentType}`))
    .map((e) => ({ url: redactUrl(e.url), status: e.status, contentType: e.contentType }))
    .slice(0, 20);
  return { url: page.url(), tabs, ...dom, fetched };
}

interface Saved {
  path: string;
  fileName?: string;
  host?: string;
  /** Where the bytes came from (signed URL, kept only in the raw capture for debugging). */
  url?: string;
}

/** True when the first bytes read like text (JSON, RSC flight data, HTML): never a resume file. */
export function looksTextual(bytes: Buffer | Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 64));
  if (!head.length) return false;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(head).replace(/^\uFEFF/, '');
  } catch {
    return false; // invalid UTF-8: binary
  }
  if (!text.trim()) return false;
  // Control characters other than tab, newline and carriage return do not occur in text payloads.
  return !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
}

const DOCUMENT_CT_RE = /application\/(pdf|msword|vnd\.openxmlformats-officedocument|rtf)/i;

/**
 * LinkedIn's resume viewer is a server-driven screen whose payload names the actual document files
 * (".../dms/prv/document/media/v2/<id>/recruiter-candidate-document-pdf-analyzed/..."). Pull those URLs out of
 * any text response so the file can be fetched directly even when the viewer never requests the PDF itself.
 */
export function findDocumentUrls(text: string): string[] {
  const unescaped = text.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const found = unescaped.match(/https?:\/\/[^"'\\\s<>)\]]+\/dms\/prv\/document\/[^"'\\\s<>)\]]+/g) ?? [];
  const score = (u: string) => (/pdf-analyzed/i.test(u) ? 0 : /manifest|cover-image|thumbnail|\/image\//i.test(u) ? 2 : 1);
  return [...new Set(found)].filter((u) => score(u) < 2).sort((a, b) => score(a) - score(b));
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
  const textual = looksTextual(input.bytes);
  // Sniffed magic bytes win; a document content type counts; octet-stream or an attachment header only when the
  // bytes are not plain text (LinkedIn's viewer payloads are text and must never be mistaken for a resume).
  const isFile =
    !!sniffExt(input.bytes) ||
    (!textual &&
      (DOCUMENT_CT_RE.test(ct) ||
        /application\/octet-stream/i.test(ct) ||
        /attachment/i.test(cd) ||
        // A navigation to a resume-looking URL that answers with unknown binary bytes is still the file.
        (input.resourceType === 'document' && looksLikeResumeUrl(input.url) && input.bytes.length > 1000)));
  // A navigation to a file (same tab or popup) or any attachment would start a Chrome download: answer it ourselves.
  const swallow = isFile && (input.resourceType === 'document' || /attachment/i.test(cd) || !input.fromWorkingPage);
  return { isFile, swallow };
}

/** Where an intercepted request comes from: the tab we work in, a popup that tab opened, or an unrelated tab. */
export type TrapOrigin = 'working' | 'popup' | 'other';

/** Host and path only (signed tokens live in the query string), for log lines. Full URLs stay in the raw capture. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.slice(0, 160);
  } catch {
    return (url.split('?')[0] ?? url).slice(0, 160);
  }
}

/** A regular LinkedIn page (not a file host, not a document path), e.g. the applicant list opened in a new tab. */
function isLinkedInPageUrl(url: string): boolean {
  return /^https:\/\/www\.linkedin\.com\//i.test(url) && !looksLikeResumeUrl(url) && !/\/dms\/|ambry|mediaauth/i.test(url);
}

/** Lower is better: the analysed PDF first, then other document files, then anything else that was swallowed. */
export function scoreDocumentUrl(url: string): number {
  if (/pdf-analyzed/i.test(url)) return 0;
  if (/\/dms\/prv\/document\//i.test(url) && !/manifest|cover-image|thumbnail/i.test(url)) return 1;
  return looksLikeResumeUrl(url) ? 2 : 3;
}

/**
 * Pure decision for the network trap. Only a top-level navigation can turn into a Chrome download, so only those
 * are answered by us (an empty 204, nothing is fetched or replayed); every other request continues untouched.
 * Popups the working tab opened may load ordinary LinkedIn pages; anything else they navigate to is a file.
 * Requests from unrelated tabs are never touched.
 */
export function classifyTrapRequest(input: { url: string; isTopLevelNavigation: boolean; origin: TrapOrigin }): { swallow: boolean } {
  if (input.origin === 'other' || !input.isTopLevelNavigation) return { swallow: false };
  if (looksLikeResumeUrl(input.url)) return { swallow: true };
  return { swallow: input.origin === 'popup' && !isLinkedInPageUrl(input.url) };
}

/**
 * Passive network capture around a Resume click, so Chrome's download manager never starts. Chrome 154 crashed
 * its browser process three times in a row the moment an automation-triggered download began (first as a real
 * download, then again with Playwright's download handling). Chrome still makes every request itself: the trap
 * only listens to responses of the working tab and of popups that tab opened (the resume viewer payload names
 * the document files, and the viewer may fetch the file itself), and it answers top-level navigations to a file
 * with an empty 204 instead of letting them become downloads. Nothing is replayed through Node, so timing,
 * TLS fingerprint and caching stay Chrome's own.
 */
class ResumeTrap {
  private saved: Saved | undefined;
  private resolvers: Array<() => void> = [];
  private armed = false;
  /** Redacted URLs of navigations the trap answered, for the raw capture. */
  readonly seen: string[] = [];
  /** Document URLs seen in viewer payloads or swallowed navigations. */
  readonly documentUrls = new Set<string>();
  private readonly popups = new Set<Page>();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly ctx: ScrapeContext,
    private readonly saveDir: string,
  ) {}

  private originOf(req: Request): TrapOrigin {
    try {
      const page = req.frame().page();
      if (page === this.ctx.page) return 'working';
      return this.popups.has(page) ? 'popup' : 'other';
    } catch {
      return 'other';
    }
  }

  private readonly onPopup = (p: Page): void => {
    this.popups.add(p);
  };

  private readonly onRoute = async (route: Route): Promise<void> => {
    const req = route.request();
    const url = req.url();
    let topLevel = false;
    try {
      topLevel = req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame();
    } catch {
      /* detached */
    }
    const { swallow } = classifyTrapRequest({ url, isTopLevelNavigation: topLevel, origin: this.originOf(req) });
    if (!swallow) {
      await route.continue().catch(() => {});
      return;
    }
    this.seen.push(redactUrl(url));
    this.documentUrls.add(url);
    // The working tab keeps its page (204 does not commit); a popup gets a blank page that commits, so Playwright
    // reports it and clickAndTrap can close it.
    const origin = this.originOf(req);
    if (origin === 'popup') await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title></title>' }).catch(() => {});
    else await route.fulfill({ status: 204, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } }).catch(() => {});
    this.settle();
  };

  private readonly onResponse = (resp: Response): void => {
    const req = resp.request();
    if (this.originOf(req) === 'other') return;
    const type = req.resourceType();
    const ct = resp.headers()['content-type'] ?? '';
    const url = resp.url();
    const job = (async () => {
      if ((type === 'fetch' || type === 'xhr' || type === 'document') && /linkedin\.com\//i.test(url) && /json|x-component|javascript|html|text/i.test(ct)) {
        const text = await resp.text().catch(() => '');
        if (text && text.length < 4_000_000) {
          let added = false;
          for (const u of findDocumentUrls(text)) if (!this.documentUrls.has(u)) (this.documentUrls.add(u), (added = true));
          if (added) this.settle();
        }
      } else if (!this.saved && type !== 'document' && (DOCUMENT_CT_RE.test(ct) || looksLikeResumeUrl(url))) {
        // The viewer fetched the file itself: Chrome made the request, we only read the bytes.
        const body = await resp.body().catch(() => undefined);
        if (body && !looksTextual(body)) {
          const s = saveBytes(body, ct, resp.headers()['content-disposition'], url, this.saveDir);
          if (s) {
            this.saved = { ...s, host: safeHost(url), url };
            this.ctx.log.debug('resume read from the viewer response', { url: redactUrl(url), bytes: body.length });
            this.settle();
          }
        }
      }
    })();
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  };

  async arm(): Promise<void> {
    if (this.armed) return;
    this.armed = true;
    const context = this.ctx.page.context();
    this.ctx.page.on('popup', this.onPopup);
    context.on('response', this.onResponse);
    await context.route('**/*', this.onRoute);
  }

  async disarm(): Promise<void> {
    if (!this.armed) return;
    this.armed = false;
    const context = this.ctx.page.context();
    this.ctx.page.off('popup', this.onPopup);
    context.off('response', this.onResponse);
    await context.unroute('**/*', this.onRoute).catch(() => {});
    await Promise.allSettled([...this.pending]);
    this.settle();
  }

  result(): Saved | undefined {
    return this.saved;
  }

  /** Candidate document URLs, best first. */
  candidates(): string[] {
    return [...this.documentUrls].sort((a, b) => scoreDocumentUrl(a) - scoreDocumentUrl(b));
  }

  /** Resolves when a file or a document URL shows up, or after `timeoutMs`. */
  wait(timeoutMs: number): Promise<void> {
    if (this.saved || this.documentUrls.size) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.resolvers = this.resolvers.filter((r) => r !== done);
        resolve();
      }, timeoutMs);
      this.resolvers.push(done);
    });
  }

  private settle(): void {
    const rs = this.resolvers;
    this.resolvers = [];
    for (const r of rs) r();
  }
}

/** The Chrome process or the working tab is gone: let the task fail so the retry policy can react. */
function assertPageAlive(page: Page): void {
  if (page.isClosed()) throw new Error('Target page, context or browser has been closed during the resume step');
}

/**
 * Layered capture, in order: direct file href on the page → "Download resume" link/menu item → Resume control
 * (opens LinkedIn's resume viewer, a new tab with the signed URL, or exposes a Download control). Every click runs
 * with the passive trap armed: the file is read from the viewer's own responses or fetched from inside the page
 * once its URL is known; Chrome's download manager is never involved (downloads are denied at the context level
 * and cancelled if one still starts).
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
    downloadsSeen.push(redactUrl(dl.url()));
    log.warn('Chrome started a download despite the network trap; cancelling it', { url: redactUrl(dl.url()) });
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

    // (c) Resume control → viewer payload / popup with the signed URL / direct file
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
    if (direct) {
      // A recruiter closes the viewer they opened; the dismiss control is only pressed when it is there.
      if (await firstVisible(page, SEL[gen].detail.dismiss, { timeoutMs: 400 })) await closeViewer();
      return { ...direct, hasResume: true };
    }
    assertPageAlive(page);

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
    assertPageAlive(page);
    const debug = await resumeDebugInfo(ctx, mark);
    debug.trapSeen = trap.seen.slice(0, 20);
    debug.documentUrls = trap.candidates().slice(0, 5);
    debug.downloadsSeen = downloadsSeen;
    await closeViewer();
    log.warn('resume control found but no file could be retrieved', {
      url: redactUrl(page.url()),
      viewerUrl: url ? redactUrl(url) : undefined,
      tabs: debug.tabs,
      frames: (debug.frames as string[]).map(redactUrl),
      fetched: debug.fetched,
      trapSeen: debug.trapSeen,
      documentUrls: (debug.documentUrls as string[]).map(redactUrl),
    });
    return { strategy: 'none', hasResume: true, debug };
  } finally {
    page.off('download', onDownload);
    await trap.disarm();
  }
}

/**
 * Click a control with the passive trap armed. The file may arrive as a viewer response (read directly), as a
 * document URL named in the viewer payload or swallowed from a navigation (fetched from inside the page), or in a
 * popup whose URL we can fetch. Popups are closed only after the trap has settled, so no download is ever in
 * flight when a tab goes away. Returns undefined when a viewer opened and nothing was found yet.
 */
async function clickAndTrap(ctx: ScrapeContext, control: Locator, trap: ResumeTrap, saveDir: string, timeoutMs: number, noScroll = false): Promise<(Saved & { strategy: ResumeOutcome['strategy'] }) | undefined> {
  const { page, human, log } = ctx;
  const popupP = page.waitForEvent('popup', { timeout: Math.min(timeoutMs, 6000) }).catch(() => null);
  await human.click(page, control, { noScroll });
  await human.pause('short');
  await trap.wait(timeoutMs);
  assertPageAlive(page);
  const popup = await popupP;
  try {
    const got = trap.result();
    if (got) return { ...got, strategy: 'intercept' };
    for (const docUrl of trap.candidates().slice(0, 2)) {
      const saved = await fetchResume(ctx, docUrl, saveDir);
      if (saved) return { ...saved, strategy: 'viewer' };
    }
    if (popup) {
      await popup.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      const url = popup.url();
      log.debug('resume popup opened', { url: redactUrl(url) });
      if (looksLikeResumeUrl(url) || /ambry|dms|mediaauth|licdn/i.test(url)) {
        const saved = (await fetchResume(ctx, url, saveDir)) ?? (await fetchResume(ctx, url, saveDir, popup));
        if (saved) return { ...saved, strategy: 'popup' };
      }
      await trap.wait(3000);
      const late = trap.result();
      if (late) return { ...late, strategy: 'intercept' };
    }
    return undefined;
  } finally {
    if (popup) {
      await popup.close().catch(() => {});
      await page.bringToFront().catch(() => {});
    }
  }
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
    if (saved) return { ...saved, host, url: res.finalUrl || url };
    ctx.log.debug('resume url returned html/empty (login wall or expired link)', { url: redactUrl(url), ct: res.ct });
  } catch (e) {
    ctx.log.debug('in-page resume fetch failed; trying context request', { url: redactUrl(url), error: errorMessage(e) });
  }
  // Last resort only (cross-origin file hosts refuse in-page reads): this request leaves through Node, not Chrome.
  try {
    ctx.log.debug('fetching resume through the context request API', { url: redactUrl(url) });
    const r = await ctx.page.context().request.get(url, { headers: { referer: 'https://www.linkedin.com/' }, maxRedirects: 5, timeout: 30_000 });
    if (!r.ok()) return undefined;
    const saved = saveBytes(await r.body(), r.headers()['content-type'], r.headers()['content-disposition'], r.url(), saveDir);
    return saved ? { ...saved, host, url: r.url() } : undefined;
  } catch (e) {
    ctx.log.debug('context request for resume failed', { url: redactUrl(url), error: errorMessage(e) });
    return undefined;
  }
}

function saveBytes(bytes: Buffer, contentType: string | null | undefined, contentDisposition: string | null | undefined, finalUrl: string, saveDir: string): { path: string; fileName?: string } | undefined {
  const sniffed = sniffExt(bytes);
  if (bytes.length < 200) return undefined;
  // Login walls, expired links and viewer payloads come back as HTML, JSON or RSC text: not a resume.
  if (!sniffed && (looksTextual(bytes) || /text\/html/i.test(contentType ?? '')) && !DOCUMENT_CT_RE.test(contentType ?? '')) return undefined;
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

