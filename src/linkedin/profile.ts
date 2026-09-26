import path from 'node:path';
import type { CertificationItem, ContactInfo, DateRange, EducationItem, ExperienceItem, GenericItem, LanguageItem, Profile, ProfileDepth, ProfileStrategy, ProjectItem } from '../types.js';
import type { ScrapeContext } from './context.js';
import type { Generation } from './selectors.js';
import { SEL } from './selectors.js';
import { URLS, parseVanity, type ProfileSection } from './urls.js';
import { allOfFirst, collectLinks, extractEmail, extractPhone, firstVisible, mainText, scrollUntilStable, textOf } from './dom.js';
import { writeJson } from '../storage/files.js';
import { CheckpointError, NotLoggedInError, RateLimitedError, errorMessage } from '../errors.js';
import { fetchFullProfileVoyager, normalizeVoyagerProfile } from './voyager.js';

export interface FetchProfileOptions {
  depth: ProfileDepth;
  strategy: ProfileStrategy;
  savePdf: boolean;
  /** Directory for profile.json, raw snapshots, screenshot, pdf */
  saveDir: string;
}

/** Details pages visited for depth 'full' on the rendered-text path (each one is another profile view). */
export const FULL_SECTIONS: ProfileSection[] = ['experience', 'education', 'skills', 'certifications', 'languages', 'projects', 'honors'];

function snapshot(ctx: ScrapeContext, mark: number, url: string, text: string, links: Array<{ href: string; text: string }>, extra: Record<string, unknown> = {}) {
  return {
    url,
    capturedAt: new Date().toISOString(),
    ...extra,
    text,
    links,
    captured: ctx.capture.since(mark).map((e) => ({ url: e.url, kind: e.kind, status: e.status, json: e.json ?? e.body.slice(0, 200_000) })),
  };
}

/**
 * Navigate to the profile like a person, then extract structured data: Voyager (one in-page request plus
 * section top-ups) when allowed, otherwise the rendered text of the main page and, for depth 'full', the
 * /details/<section>/ pages plus the contact-info overlay. Raw text is always saved for offline re-parsing.
 */
export async function fetchProfile(ctx: ScrapeContext, profileUrl: string, opts: FetchProfileOptions): Promise<Profile> {
  const vanity = parseVanity(profileUrl);
  if (!vanity) throw new Error(`Not a LinkedIn profile URL: ${profileUrl}`);
  const { page, human, log } = ctx;
  const url = URLS.profile(vanity);
  const mark = ctx.capture.mark();

  await human.goto(page, url);
  await ctx.assertHealthy();
  await human.pause('read');
  await human.scrollPage(page, { maxScrolls: 6 });
  const gen = await ctx.generation();
  const text = await mainText(page);
  const links = await collectLinks(page);
  await ctx.capture.drain();
  writeJson(path.join(opts.saveDir, 'raw-profile-main.json'), snapshot(ctx, mark, page.url(), text, links, { generation: gen }));

  let profile: Profile | undefined;
  let voyagerError: string | undefined;
  if (opts.strategy !== 'dom') {
    try {
      await human.pauseMs(2500, 7000);
      const fetched = await fetchFullProfileVoyager(page, vanity, {
        pauseMs: () => human.pauseMs(3000, 9000),
        extraHeaders: ctx.capture.voyagerHeaders(),
      });
      writeJson(path.join(opts.saveDir, 'raw-voyager.json'), fetched);
      profile = normalizeVoyagerProfile(fetched, url);
      log.info('profile extracted via voyager', { vanity, requests: fetched.requests, decoration: fetched.usedDecoration, positions: profile.experience.length, skills: profile.skills.length });
    } catch (e) {
      if (e instanceof CheckpointError || e instanceof RateLimitedError || e instanceof NotLoggedInError) throw e;
      voyagerError = errorMessage(e);
      if (opts.strategy === 'voyager') throw e;
      log.warn('voyager profile fetch failed; falling back to rendered text', { vanity, error: voyagerError });
    }
  }

  if (!profile) profile = await domProfile(ctx, vanity, url, gen, text, links, opts);

  // Header fallbacks from the rendered page when Voyager lacked them
  const header = parseProfileHeaderText(text);
  profile.fullName ??= header.fullName;
  profile.headline ??= header.headline;
  profile.location ??= header.location;
  if (profile.openToWork === undefined && /open to work/i.test(text.slice(0, 3000))) profile.openToWork = true;

  if (opts.depth === 'full') {
    try {
      const shot = path.join(opts.saveDir, 'profile.png');
      await page.screenshot({ path: shot, fullPage: true, timeout: 20_000 });
      profile.screenshotPath = shot;
    } catch (e) {
      log.debug('profile screenshot failed', { error: errorMessage(e) });
    }
  }
  if (opts.savePdf) profile.savedPdfPath = await saveToPdf(ctx, gen, opts.saveDir);

  profile.raw = { ...((profile.raw as Record<string, unknown> | undefined) ?? {}), voyagerError, generation: gen };
  return profile;
}

async function domProfile(ctx: ScrapeContext, vanity: string, url: string, gen: Generation, mainTxt: string, links: Array<{ href: string; text: string }>, opts: FetchProfileOptions): Promise<Profile> {
  const { page, human, log } = ctx;
  const header = parseProfileHeaderText(mainTxt);
  const profile: Profile = {
    profileUrl: url,
    vanityName: vanity,
    fullName: header.fullName,
    headline: header.headline,
    location: header.location,
    about: parseAboutText(mainTxt),
    experience: [],
    education: [],
    skills: [],
    certifications: [],
    languages: [],
    projects: [],
    honors: [],
    volunteering: [],
    publications: [],
    courses: [],
    source: 'dom',
    fetchedAt: new Date().toISOString(),
  };
  // Photo: first profile-like image
  try {
    const photo = await page.evaluate(() => {
      const img = Array.from(document.querySelectorAll('main img')).find((i) => /profile|photo/i.test((i as HTMLImageElement).alt) || (i as HTMLImageElement).width >= 100) as HTMLImageElement | undefined;
      return img?.src;
    });
    if (photo && /^https?:/.test(photo)) profile.photoUrl = photo;
  } catch {
    /* ignore */
  }
  if (opts.depth !== 'full') {
    profile.experience = parseInlineSection(mainTxt, 'Experience').map((t) => toExperience(parseDetailsItemText(t, 'experience')));
    profile.education = parseInlineSection(mainTxt, 'Education').map((t) => toEducation(parseDetailsItemText(t, 'education')));
    return profile;
  }

  for (const section of FULL_SECTIONS) {
    await human.pause('betweenPages');
    const mark = ctx.capture.mark();
    await human.goto(page, URLS.profileDetails(vanity, section));
    await ctx.assertHealthy();
    await human.pause('short');
    if (section === 'skills') await scrollUntilStable(page, () => human.scrollBy(page, 450), 'main', 20);
    else await human.scrollPage(page, { maxScrolls: 5 });
    const items = await allOfFirst(page, SEL[gen].profile.detailsItem);
    const texts: string[] = [];
    for (const it of items) {
      const t = await textOf(it);
      if (t && !texts.includes(t)) texts.push(t);
    }
    const sectionText = await mainText(page);
    await ctx.capture.drain();
    writeJson(path.join(opts.saveDir, `raw-profile-${section}.json`), snapshot(ctx, mark, page.url(), sectionText, await collectLinks(page), { items: texts }));
    const parsed = texts.map((t) => parseDetailsItemText(t, section)).filter((p) => p.title);
    switch (section) {
      case 'experience':
        profile.experience = parsed.map(toExperience);
        break;
      case 'education':
        profile.education = parsed.map(toEducation);
        break;
      case 'skills':
        profile.skills = [...new Set(parsed.map((p) => p.title))];
        break;
      case 'certifications':
        profile.certifications = parsed.map(toCertification);
        break;
      case 'languages':
        profile.languages = parsed.map((p): LanguageItem => ({ name: p.title, proficiency: p.subtitle }));
        break;
      case 'projects':
        profile.projects = parsed.map((p): ProjectItem => ({ name: p.title, dates: p.dates, description: p.description, url: p.url }));
        break;
      case 'honors':
        profile.honors = parsed.map((p): GenericItem => ({ title: p.title, subtitle: p.subtitle, dates: p.dates, description: p.description }));
        break;
      default:
        break;
    }
    log.debug('profile section parsed', { vanity, section, items: parsed.length });
  }

  // Contact overlay (websites / handles; email & phone for applicants come from the application itself)
  try {
    await human.pause('betweenPages');
    await human.goto(page, URLS.contactInfo(vanity));
    await ctx.assertHealthy();
    const dialog = await firstVisible(page, SEL[gen].profile.contactDialog, { timeoutMs: 8000 });
    const dialogText = (await textOf(dialog)) ?? '';
    if (dialog) {
      const dlinks = await page
        .evaluate(() => Array.from(document.querySelectorAll('dialog a[href], [role="dialog"] a[href], .artdeco-modal__content a[href]')).map((a) => (a as HTMLAnchorElement).href))
        .catch(() => [] as string[]);
      profile.contact = parseContactText(dialogText, dlinks);
      writeJson(path.join(opts.saveDir, 'raw-profile-contact.json'), { url: page.url(), text: dialogText, links: dlinks, capturedAt: new Date().toISOString() });
    }
    await page.keyboard.press('Escape').catch(() => {});
  } catch (e) {
    if (e instanceof CheckpointError || e instanceof RateLimitedError || e instanceof NotLoggedInError) throw e;
    log.debug('contact overlay skipped', { error: errorMessage(e) });
  }
  void links;
  return profile;
}

async function saveToPdf(ctx: ScrapeContext, gen: Generation, saveDir: string): Promise<string | undefined> {
  const { page, human, log } = ctx;
  try {
    const more = await firstVisible(page, SEL[gen].profile.moreButton, { timeoutMs: 3000 });
    if (!more) return undefined;
    await human.click(page, more);
    await human.pause('short');
    const item = await firstVisible(page, SEL[gen].profile.saveToPdf, { timeoutMs: 5000 });
    if (!item) {
      await page.keyboard.press('Escape').catch(() => {});
      return undefined;
    }
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), human.click(page, item, { noScroll: true })]);
    const out = path.join(saveDir, 'profile-linkedin.pdf');
    await download.saveAs(out);
    return out;
  } catch (e) {
    log.warn('save to pdf failed (optional)', { error: errorMessage(e) });
    return undefined;
  }
}

// ---------------- pure text parsers (unit-tested) ----------------

export interface ParsedItem {
  title: string;
  subtitle?: string;
  dates?: DateRange;
  location?: string;
  description?: string;
  url?: string;
  extra: Record<string, string>;
}

const MONTH_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+((?:19|20)\d{2})\b/gi;
const YEAR_RE = /\b((?:19|20)\d{2})\b/g;
const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

export function looksLikeDateLine(line: string): boolean {
  return /\b(19|20)\d{2}\b/.test(line) && (/(-|–|, |to)\s/.test(line) || /present|current|issued|expires|expired/i.test(line) || /^\s*(19|20)\d{2}\s*$/.test(line));
}

/** "Jan 2020 - Present · 3 yrs 2 mos" → { start:'2020-01', end: undefined, isCurrent:true, text } */
export function parseDateRangeText(line: string): DateRange | undefined {
  if (!/\b(19|20)\d{2}\b/.test(line)) return undefined;
  const core = line.split('·')[0]!.trim();
  const tokens: string[] = [];
  const months = [...core.matchAll(MONTH_RE)];
  if (months.length) {
    for (const m of months) tokens.push(`${m[2]}-${MONTHS[m[1]!.slice(0, 3).toLowerCase()] ?? '01'}`);
  } else {
    for (const y of core.matchAll(YEAR_RE)) tokens.push(y[1]!);
  }
  const isCurrent = /present|current|now/i.test(core);
  const start = tokens[0];
  const end = isCurrent ? undefined : tokens[1];
  return { start, end, isCurrent: !!start && isCurrent, text: line.trim() };
}

function cleanLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\s+/g, ' ').trim();
    if (!l) continue;
    if (out[out.length - 1] === l) continue; // LinkedIn renders visually-hidden duplicates
    out.push(l);
  }
  return out;
}

const NOISE_LINE = /^(show all|see more|…see more|show more|\d+ endorsements?|endorsed by|skills?:|see credential|show credential|helped me get this job|\d+ connections?|\d+ followers?|·|•)$/i;

/** Parse one /details/<section>/ list item's innerText into a generic item (locale-tolerant heuristics). */
export function parseDetailsItemText(text: string, section: ProfileSection | 'experience' | 'education'): ParsedItem {
  const lines = cleanLines(text).filter((l) => !NOISE_LINE.test(l));
  const item: ParsedItem = { title: lines[0] ?? '', extra: {} };
  const rest = lines.slice(1);
  const dateIdx = rest.findIndex(looksLikeDateLine);
  if (dateIdx >= 0) item.dates = parseDateRangeText(rest[dateIdx]!);
  const beforeDate = dateIdx >= 0 ? rest.slice(0, dateIdx) : rest.slice(0, 1);
  const afterDate = dateIdx >= 0 ? rest.slice(dateIdx + 1) : rest.slice(1);

  if (section === 'skills') {
    item.description = rest.join('\n') || undefined;
    return item;
  }
  if (section === 'languages') {
    item.subtitle = rest[0];
    return item;
  }
  if (beforeDate.length) item.subtitle = beforeDate[0];
  if (section === 'experience' && item.subtitle?.includes(' · ')) {
    const [company, type] = item.subtitle.split(' · ').map((s) => s.trim());
    item.extra.company = company ?? '';
    if (type) item.extra.employmentType = type;
  }
  if (section === 'certifications') {
    for (const l of rest) {
      const cid = /credential id\s*:?\s*(.+)$/i.exec(l);
      if (cid) item.extra.credentialId = cid[1]!.trim();
      const issued = /issued\s+(.+?)(\s*·|$)/i.exec(l);
      if (issued) item.extra.issued = issued[1]!.trim();
      const exp = /expires?\s+(.+?)(\s*·|$)/i.exec(l);
      if (exp) item.extra.expires = exp[1]!.trim();
    }
  }
  const locIdx = afterDate.findIndex((l) => /remote|hybrid|on-site|onsite/i.test(l) || (/,/.test(l) && l.length < 60 && !/[.!?]$/.test(l)));
  if (section === 'experience' && locIdx === 0) {
    item.location = afterDate[0];
    afterDate.splice(0, 1);
  }
  const desc = afterDate.filter((l) => !/credential id/i.test(l)).join('\n').trim();
  if (desc) item.description = desc;
  return item;
}

function toExperience(p: ParsedItem): ExperienceItem {
  const loc = p.location?.split(' · ') ?? [];
  return {
    title: p.title,
    company: p.extra.company ?? p.subtitle,
    employmentType: p.extra.employmentType,
    location: loc[0],
    locationType: loc[1],
    dates: p.dates,
    description: p.description,
  };
}

function toEducation(p: ParsedItem): EducationItem {
  const [degree, field] = (p.subtitle ?? '').split(/,\s*|\s+-\s+/);
  return { school: p.title, degree: degree || undefined, fieldOfStudy: field || undefined, dates: p.dates, description: p.description };
}

function toCertification(p: ParsedItem): CertificationItem {
  return {
    name: p.title,
    issuer: p.subtitle,
    issuedAt: p.extra.issued ? parseDateRangeText(p.extra.issued)?.start : p.dates?.start,
    expiresAt: p.extra.expires ? parseDateRangeText(p.extra.expires)?.start : undefined,
    credentialId: p.extra.credentialId,
    credentialUrl: p.url,
  };
}

const NAV_WORDS = /^(skip to (main )?content|home|my network|jobs|messaging|notifications|me|for business|try premium( for.*)?|search|work|advertise|learning|post a job|contact info|message|connect|follow|more|pending|\d+\+? connections?|\d+\+? followers?|\d+ mutual connections?|open to work|#opentowork)$/i;

/** Name / headline / location from the top of a profile page's innerText. */
export function parseProfileHeaderText(text: string): { fullName?: string; headline?: string; location?: string } {
  const lines = cleanLines(text.slice(0, 4000))
    .map((l) => l.replace(/\s*·\s*(1st|2nd|3rd|3rd\+)\s*$/i, '').trim())
    .filter((l) => l && !NAV_WORDS.test(l) && !/^(he|she|they)\//i.test(l) && !/^\(?(he|she|they)\/(him|her|them)\)?$/i.test(l))
    .filter((l, i, arr) => i === 0 || arr[i - 1] !== l);
  const nameIdx = lines.findIndex((l) => l.length >= 2 && l.length <= 60 && !/\d/.test(l) && !/[|@]/.test(l) && !/verified/i.test(l));
  if (nameIdx < 0) return {};
  const fullName = lines[nameIdx];
  const after = lines.slice(nameIdx + 1, nameIdx + 7).filter((l) => l !== fullName);
  const headline = after.find((l) => l.length > 3 && !/^\S+,\s*\S+/.test(l) && !/contact info/i.test(l) && !/^[A-Z][a-z]+, [A-Z]/.test(l));
  const location = after.find((l) => l !== headline && /,/.test(l) && l.length < 80 && !/[.!?]$/.test(l)) ?? after.find((l) => l !== headline && /(remote|area|region)/i.test(l));
  return { fullName, headline, location };
}

const SECTION_HEADERS = /^(about|activity|experience|education|licenses & certifications|licenses and certifications|skills|projects|languages|honors & awards|volunteering|publications|courses|interests|recommendations|featured|people also viewed|people you may know|services|causes|organizations|test scores|patents)$/i;

export function parseAboutText(text: string): string | undefined {
  const lines = cleanLines(text);
  const i = lines.findIndex((l) => /^about$/i.test(l));
  if (i < 0) return undefined;
  const out: string[] = [];
  for (const l of lines.slice(i + 1)) {
    if (SECTION_HEADERS.test(l)) break;
    if (/^(…see more|see more|show more|show less)$/i.test(l)) continue;
    out.push(l);
    if (out.join(' ').length > 4000) break;
  }
  return out.join('\n').trim() || undefined;
}

/** Items of an inline section (e.g. Experience) on the main profile page: blocks separated by blank-ish boundaries. */
export function parseInlineSection(text: string, header: string): string[] {
  const lines = cleanLines(text);
  const start = lines.findIndex((l) => l.toLowerCase() === header.toLowerCase());
  if (start < 0) return [];
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (SECTION_HEADERS.test(l)) break;
    if (/^show all \d+/i.test(l)) break;
    body.push(l);
  }
  // Split into items where a date line is followed by non-date lines and then a new title-ish line.
  const items: string[][] = [];
  let cur: string[] = [];
  let sawDate = false;
  for (const l of body) {
    if (sawDate && !looksLikeDateLine(l) && cur.length >= 3 && !/,/.test(l) && !/remote|hybrid|on-site/i.test(l) && l.length < 80 && !/[.!?]$/.test(l) && !/·/.test(l)) {
      items.push(cur);
      cur = [];
      sawDate = false;
    }
    cur.push(l);
    if (looksLikeDateLine(l)) sawDate = true;
  }
  if (cur.length) items.push(cur);
  return items.map((i) => i.join('\n'));
}

export function parseContactText(text: string, links: string[] = []): ContactInfo {
  const email = extractEmail(text) ?? links.find((l) => l.startsWith('mailto:'))?.slice(7);
  const phone = extractPhone(text) ?? links.find((l) => l.startsWith('tel:'))?.slice(4);
  const websites = [...new Set(links.filter((l) => /^https?:/.test(l) && !/linkedin\.com|licdn\.com/i.test(l)))];
  const twitter = /(?:twitter|x)\.com\/([A-Za-z0-9_]+)/.exec(text + ' ' + links.join(' '))?.[1];
  const bday = /birthday\s*\n?\s*([A-Za-z]+ \d{1,2})/i.exec(text)?.[1];
  const address = /address\s*\n\s*(.+)/i.exec(text)?.[1]?.trim();
  return { email, phone, websites: websites.length ? websites : undefined, twitter, birthday: bday, address };
}

/** Flatten a Profile into searchable plain text (for FTS + LLM review). */
export function profileToText(p: Profile): string {
  const out: string[] = [];
  const push = (label: string, v: string | undefined) => v && out.push(`${label}: ${v}`);
  push('Name', p.fullName);
  push('Headline', p.headline);
  push('Location', p.location);
  push('Industry', p.industry);
  push('Profile', p.profileUrl);
  if (p.openToWork) out.push('Open to work: yes');
  if (p.about) out.push(`\nAbout:\n${p.about}`);
  if (p.experience.length) {
    out.push('\nExperience:');
    for (const e of p.experience) out.push(`- ${e.title}${e.company ? `, ${e.company}` : ''}${e.employmentType ? ` (${e.employmentType})` : ''}${e.dates?.text ? ` [${e.dates.text}]` : ''}${e.location ? ` ${e.location}` : ''}${e.description ? `\n  ${e.description.replace(/\n/g, '\n  ')}` : ''}`);
  }
  if (p.education.length) {
    out.push('\nEducation:');
    for (const e of p.education) out.push(`- ${e.school}${e.degree ? `, ${e.degree}` : ''}${e.fieldOfStudy ? `, ${e.fieldOfStudy}` : ''}${e.dates?.text ? ` [${e.dates.text}]` : ''}${e.description ? `\n  ${e.description}` : ''}`);
  }
  if (p.skills.length) out.push(`\nSkills: ${p.skills.join(', ')}`);
  if (p.certifications.length) out.push(`\nCertifications:\n${p.certifications.map((c) => `- ${c.name}${c.issuer ? `, ${c.issuer}` : ''}${c.issuedAt ? ` (${c.issuedAt})` : ''}`).join('\n')}`);
  if (p.languages.length) out.push(`\nLanguages: ${p.languages.map((l) => (l.proficiency ? `${l.name} (${l.proficiency})` : l.name)).join(', ')}`);
  if (p.projects.length) out.push(`\nProjects:\n${p.projects.map((x) => `- ${x.name}${x.dates?.text ? ` [${x.dates.text}]` : ''}${x.description ? `: ${x.description}` : ''}`).join('\n')}`);
  for (const [label, items] of [['Honors', p.honors], ['Volunteering', p.volunteering], ['Publications', p.publications], ['Courses', p.courses]] as Array<[string, GenericItem[]]>) {
    if (items.length) out.push(`\n${label}:\n${items.map((x) => `- ${x.title}${x.subtitle ? `, ${x.subtitle}` : ''}${x.dates?.text ? ` [${x.dates.text}]` : ''}${x.description ? `: ${x.description}` : ''}`).join('\n')}`);
  }
  if (p.contact) {
    const c = p.contact;
    const bits = [c.email && `email ${c.email}`, c.phone && `phone ${c.phone}`, c.websites?.length && `websites ${c.websites.join(' ')}`, c.twitter && `twitter ${c.twitter}`].filter(Boolean);
    if (bits.length) out.push(`\nContact: ${bits.join('; ')}`);
  }
  return out.join('\n').trim();
}
