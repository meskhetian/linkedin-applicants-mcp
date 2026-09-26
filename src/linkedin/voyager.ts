import type { Page } from 'patchright';
import type { CertificationItem, DateRange, EducationItem, ExperienceItem, GenericItem, LanguageItem, Profile, ProjectItem } from '../types.js';
import { classifyVoyagerResponse, type VoyagerHealth } from '../browser/checkpoint.js';
import { CheckpointError, RateLimitedError } from '../errors.js';

/**
 * LinkedIn's internal Rest.li API ("Voyager"), called from INSIDE the logged-in tab via page.evaluate(fetch)
 * so cookies, UA, sec-ch-ua and referer are the real browser's. Used only for full profiles when
 * config profileStrategy is 'auto' or 'voyager'. Endpoint facts: docs/research/linkedin-profile-extraction.md.
 */

export interface VoyagerEntity {
  entityUrn?: string;
  $type?: string;
  [k: string]: unknown;
}

export interface VoyagerResponse {
  data?: VoyagerEntity & { '*elements'?: string[]; elements?: unknown[]; paging?: { total?: number; count?: number; start?: number } };
  included?: VoyagerEntity[];
}

export interface VoyagerResult {
  status: number;
  contentType: string;
  health: VoyagerHealth;
  json?: VoyagerResponse;
  /** First bytes of a non-JSON body (for debugging) */
  text?: string;
  retryAfterMs?: number;
}

/** Graph over the `included` array: follow `*field` URN pointers and `*elements` collections. */
export class EntityGraph {
  private byUrn = new Map<string, VoyagerEntity>();
  readonly root: VoyagerEntity | undefined;

  constructor(...responses: VoyagerResponse[]) {
    for (const res of responses) {
      for (const e of res.included ?? []) {
        if (!e || typeof e.entityUrn !== 'string') continue;
        const prev = this.byUrn.get(e.entityUrn);
        this.byUrn.set(e.entityUrn, prev ? { ...e, ...prev } : e);
      }
    }
    this.root = responses[0]?.data;
  }

  get(urn?: unknown): VoyagerEntity | undefined {
    return typeof urn === 'string' ? this.byUrn.get(urn) : undefined;
  }

  ref(e: VoyagerEntity | undefined, field: string): VoyagerEntity | undefined {
    return this.get(e?.[`*${field}`]);
  }

  refs(e: VoyagerEntity | undefined, field: string): VoyagerEntity[] {
    const urns = e?.[`*${field}`];
    if (!Array.isArray(urns)) return [];
    return urns.map((u) => this.get(u)).filter((x): x is VoyagerEntity => !!x);
  }

  /** `*field` → CollectionResponse → `*elements` (plus paging.total for truncation checks). */
  collection(e: VoyagerEntity | undefined, field: string): { elements: VoyagerEntity[]; total?: number } {
    const coll = this.ref(e, field) as (VoyagerEntity & { paging?: { total?: number } }) | undefined;
    return { elements: this.refs(coll, 'elements'), total: coll?.paging?.total };
  }

  rootElements(): VoyagerEntity[] {
    return this.refs(this.root, 'elements');
  }

  ofTypeSuffix(suffix: string): VoyagerEntity[] {
    return [...this.byUrn.values()].filter((e) => (e.$type ?? '').endsWith(suffix));
  }

  size(): number {
    return this.byUrn.size;
  }
}

/** Decoration ids to try, in order. Suffixes rotate; keep them in one place. */
export const FULL_PROFILE_DECORATIONS = [101, 96, 93, 128].map((n) => `com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-${n}`);

export const SECTION_ROUTES = [
  'profilePositions',
  'profileEducations',
  'profileSkills',
  'profileCertifications',
  'profileLanguages',
  'profileProjects',
  'profileVolunteerExperiences',
  'profileHonors',
  'profilePublications',
  'profileCourses',
] as const;
export type SectionRoute = (typeof SECTION_ROUTES)[number];

/** Which entity $type suffix each section route returns (used to recognise top-up responses). */
const SECTION_TYPE: Record<SectionRoute, string> = {
  profilePositions: '.identity.profile.Position',
  profileEducations: '.identity.profile.Education',
  profileSkills: '.identity.profile.Skill',
  profileCertifications: '.identity.profile.Certification',
  profileLanguages: '.identity.profile.Language',
  profileProjects: '.identity.profile.Project',
  profileVolunteerExperiences: '.identity.profile.VolunteerExperience',
  profileHonors: '.identity.profile.Honor',
  profilePublications: '.identity.profile.Publication',
  profileCourses: '.identity.profile.Course',
};

const ALLOWED_EXTRA_HEADERS = ['x-li-track', 'x-li-page-instance', 'x-li-pem-metadata'];

async function csrfToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies('https://www.linkedin.com');
  const c = cookies.find((k) => k.name === 'JSESSIONID');
  if (!c) throw new CheckpointError({ kind: 'login', url: page.url(), message: 'No JSESSIONID cookie: not logged in to LinkedIn' });
  return c.value.replace(/^"|"$/g, '');
}

/** GET https://www.linkedin.com/voyager/api<pathAndQuery> from the page context (real cookies, UA, referer). */
export async function voyagerGet(page: Page, pathAndQuery: string, extraHeaders: Record<string, string> = {}): Promise<VoyagerResult> {
  const csrf = await csrfToken(page);
  const extra: Record<string, string> = {};
  for (const k of ALLOWED_EXTRA_HEADERS) if (extraHeaders[k]) extra[k] = extraHeaders[k]!;
  const res = await page.evaluate(
    async ({ path, csrf, extra }) => {
      const r = await fetch('https://www.linkedin.com/voyager/api' + path, {
        credentials: 'include',
        headers: {
          'csrf-token': csrf,
          'x-restli-protocol-version': '2.0.0',
          accept: 'application/vnd.linkedin.normalized+json+2.1',
          'x-li-lang': 'en_US',
          ...extra,
        },
      });
      const ct = r.headers.get('content-type') ?? '';
      const text = await r.text();
      return { status: r.status, ct, text, retryAfter: r.headers.get('retry-after') };
    },
    { path: pathAndQuery, csrf, extra },
  );
  const health = classifyVoyagerResponse(res.status, res.ct);
  let json: VoyagerResponse | undefined;
  if (health === 'ok' && /json/i.test(res.ct)) {
    try {
      json = JSON.parse(res.text) as VoyagerResponse;
    } catch {
      json = undefined;
    }
  }
  const ra = res.retryAfter ? Number(res.retryAfter) : NaN;
  return {
    status: res.status,
    contentType: res.ct,
    health,
    json,
    text: json ? undefined : res.text.slice(0, 4000),
    retryAfterMs: Number.isFinite(ra) ? ra * 1000 : undefined,
  };
}

/** Convert a non-OK Voyager result into the right error for the worker. */
export function throwOnVoyagerHealth(r: VoyagerResult, page: Page, what: string): void {
  switch (r.health) {
    case 'ok':
    case 'endpoint-retired':
      return;
    case 'rate-limited':
      throw new RateLimitedError(`Voyager 429 on ${what}`, r.retryAfterMs ?? 2 * 3600_000);
    case 'edge-bot-block':
      throw new RateLimitedError(`Voyager 999 (edge block) on ${what}`, 4 * 3600_000);
    case 'session-or-permission':
    case 'login-wall':
    case 'session-revoked':
      throw new CheckpointError({ kind: 'login', url: page.url(), message: `Voyager ${r.status} (${r.health}) on ${what}` });
  }
}

export interface FullProfileFetch {
  full: VoyagerResponse;
  /** Section top-ups, tagged with the route they came from */
  extra: Array<{ route: SectionRoute; json: VoyagerResponse }>;
  usedDecoration: string;
  profileUrn?: string;
  requests: number;
}

function findProfileEntity(g: EntityGraph): VoyagerEntity | undefined {
  const isProfile = (e: VoyagerEntity) => (e.$type ?? '').endsWith('.identity.profile.Profile') || (typeof e.entityUrn === 'string' && e.entityUrn.startsWith('urn:li:fsd_profile:') && ('firstName' in e || 'publicIdentifier' in e));
  return g.rootElements().find(isProfile) ?? g.ofTypeSuffix('.identity.profile.Profile').find((e) => 'firstName' in e || 'publicIdentifier' in e) ?? g.ofTypeSuffix('.identity.profile.Profile')[0];
}

/**
 * One FullProfileWithEntities call (with decoration fallbacks) + per-section top-ups only for
 * collections the decoration truncated (paging.total > returned). 1–3 requests per profile, spaced by opts.pauseMs.
 */
export async function fetchFullProfileVoyager(
  page: Page,
  vanity: string,
  opts: { pauseMs?: () => Promise<void>; extraHeaders?: Record<string, string> } = {},
): Promise<FullProfileFetch> {
  let full: VoyagerResponse | undefined;
  let used = '';
  let requests = 0;
  const tried: string[] = [];
  for (const deco of FULL_PROFILE_DECORATIONS) {
    requests++;
    tried.push(`${deco} → `);
    const r = await voyagerGet(page, `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(vanity)}&decorationId=${deco}`, opts.extraHeaders);
    tried[tried.length - 1] += String(r.status);
    if (r.health === 'endpoint-retired') {
      await opts.pauseMs?.();
      continue;
    }
    throwOnVoyagerHealth(r, page, 'profile');
    if (r.json) {
      full = r.json;
      used = deco;
      break;
    }
    await opts.pauseMs?.();
  }
  if (!full) throw new Error(`Voyager: no working FullProfileWithEntities decoration (${tried.join('; ')})`);

  const g = new EntityGraph(full);
  const profile = findProfileEntity(g);
  const profileUrn = typeof profile?.entityUrn === 'string' ? profile.entityUrn : undefined;
  const extra: FullProfileFetch['extra'] = [];
  if (profile && profileUrn) {
    for (const route of SECTION_ROUTES) {
      const { elements, total } = g.collection(profile, route);
      if (total === undefined || total <= elements.length) continue;
      await opts.pauseMs?.();
      requests++;
      const r = await voyagerGet(page, `/identity/dash/${route}?q=viewee&profileUrn=${encodeURIComponent(profileUrn)}&start=0&count=100`, opts.extraHeaders);
      if (r.health === 'endpoint-retired') continue;
      throwOnVoyagerHealth(r, page, route);
      if (r.json) extra.push({ route, json: r.json });
    }
  }
  return { full, extra, usedDecoration: used, profileUrn, requests };
}

// ---------------- normalization ----------------

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

function ym(d: unknown): string | undefined {
  if (!d || typeof d !== 'object') return undefined;
  const { year, month } = d as { year?: unknown; month?: unknown };
  if (typeof year !== 'number') return undefined;
  return typeof month === 'number' ? `${year}-${String(month).padStart(2, '0')}` : String(year);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmt(d: unknown): string | undefined {
  if (!d || typeof d !== 'object') return undefined;
  const { year, month } = d as { year?: unknown; month?: unknown };
  if (typeof year !== 'number') return undefined;
  return typeof month === 'number' && month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${year}` : String(year);
}

export function toDateRange(range: unknown): DateRange | undefined {
  if (!range || typeof range !== 'object') return undefined;
  const { start, end } = range as { start?: unknown; end?: unknown };
  const s = ym(start);
  const e = ym(end);
  if (!s && !e) return undefined;
  const text = `${fmt(start) ?? '?'} - ${e ? fmt(end) : 'Present'}`;
  return { start: s, end: e, isCurrent: !!s && !e, text };
}

function imageUrl(pic: unknown): string | undefined {
  const v = (pic as { displayImageReference?: { vectorImage?: { rootUrl?: string; artifacts?: Array<{ width?: number; fileIdentifyingUrlPathSegment?: string }> } } } | undefined)?.displayImageReference?.vectorImage;
  if (!v?.rootUrl || !Array.isArray(v.artifacts)) return undefined;
  const a = [...v.artifacts].filter((x) => x.fileIdentifyingUrlPathSegment).sort((x, y) => (y.width ?? 0) - (x.width ?? 0))[0];
  return a ? v.rootUrl + a.fileIdentifyingUrlPathSegment : undefined;
}

/** Normalize the Voyager entity graph into our Profile type. Throws on schema drift (no Profile entity). */
export function normalizeVoyagerProfile(fetch: FullProfileFetch, profileUrl: string): Profile {
  const g = new EntityGraph(fetch.full, ...fetch.extra.map((x) => x.json));
  const p = findProfileEntity(g);
  if (!p) throw new Error('schema drift: no Profile entity in Voyager response');

  /** Elements for a section: prefer the (complete) top-up response, else the decoration's collection. */
  const section = (route: SectionRoute): VoyagerEntity[] => {
    const topUp = fetch.extra.find((x) => x.route === route);
    if (topUp) {
      const els = new EntityGraph(topUp.json).rootElements();
      if (els.length) return els.map((e) => g.get(e.entityUrn) ?? e);
    }
    const coll = g.collection(p, route).elements;
    if (coll.length) return coll;
    // Last resort: everything of that type in the graph
    return g.ofTypeSuffix(SECTION_TYPE[route]);
  };

  const positionsFromGroups = (): ExperienceItem[] =>
    g.collection(p, 'profilePositionGroups').elements.flatMap((grp) => {
      const grpCompany = g.ref(grp, 'company');
      return g.collection(grp, 'profilePositionInPositionGroup').elements.map((pos) => toExperience(pos, g, grp, grpCompany));
    });
  const topUpPositions = fetch.extra.find((x) => x.route === 'profilePositions');
  const experience = topUpPositions
    ? new EntityGraph(topUpPositions.json).rootElements().map((pos) => toExperience(g.get(pos.entityUrn) ?? pos, g))
    : positionsFromGroups().length
      ? positionsFromGroups()
      : g.ofTypeSuffix('.identity.profile.Position').map((pos) => toExperience(pos, g));

  const education: EducationItem[] = section('profileEducations').map((e) => ({
    school: str(e.schoolName) ?? str(g.ref(e, 'school')?.name) ?? '',
    schoolUrl: str(g.ref(e, 'school')?.url),
    degree: str(e.degreeName),
    fieldOfStudy: str(e.fieldOfStudy),
    dates: toDateRange(e.dateRange),
    grade: str(e.grade),
    activities: str(e.activities),
    description: str(e.description),
  }));

  const skills = [...new Set(section('profileSkills').map((s) => str(s.name)).filter((x): x is string => !!x))];

  const certifications: CertificationItem[] = section('profileCertifications').map((c) => ({
    name: str(c.name) ?? '',
    issuer: str(c.authority) ?? str(g.ref(c, 'company')?.name),
    issuedAt: ym((c.dateRange as { start?: unknown } | undefined)?.start),
    expiresAt: ym((c.dateRange as { end?: unknown } | undefined)?.end),
    credentialId: str(c.licenseNumber),
    credentialUrl: str(c.url),
  }));

  const languages: LanguageItem[] = section('profileLanguages').map((l) => ({ name: str(l.name) ?? '', proficiency: str(l.proficiency) }));

  const projects: ProjectItem[] = section('profileProjects').map((x) => ({
    name: str(x.title) ?? '',
    dates: toDateRange(x.dateRange),
    description: str(x.description),
    url: str(x.url),
  }));

  const honors: GenericItem[] = section('profileHonors').map((x) => ({
    title: str(x.title) ?? '',
    subtitle: str(x.issuer),
    dates: x.issuedOn ? { start: ym(x.issuedOn), text: fmt(x.issuedOn) } : undefined,
    description: str(x.description),
  }));

  const volunteering: GenericItem[] = section('profileVolunteerExperiences').map((x) => ({
    title: str(x.role) ?? '',
    subtitle: [str(x.companyName) ?? str(g.ref(x, 'company')?.name), str(x.cause)].filter(Boolean).join(' · ') || undefined,
    dates: toDateRange(x.dateRange),
    description: str(x.description),
  }));

  const publications: GenericItem[] = section('profilePublications').map((x) => ({
    title: str(x.name) ?? '',
    subtitle: str(x.publisher),
    dates: x.publishedOn ? { start: ym(x.publishedOn), text: fmt(x.publishedOn) } : undefined,
    description: str(x.description),
    url: str(x.url),
  }));

  const courses: GenericItem[] = section('profileCourses').map((x) => ({ title: str(x.name) ?? '', subtitle: str(x.number) }));

  const geo = g.ref(p.geoLocation as VoyagerEntity | undefined, 'geo');
  const firstName = str(p.firstName);
  const lastName = str(p.lastName);

  return {
    profileUrl,
    vanityName: str(p.publicIdentifier),
    urn: str(p.entityUrn),
    fullName: [firstName, lastName].filter(Boolean).join(' ') || undefined,
    firstName,
    lastName,
    headline: str(p.headline),
    location: str(geo?.defaultLocalizedName) ?? str(p.locationName) ?? str(p.geoLocationName),
    industry: str(g.ref(p, 'industry')?.name) ?? str(p.industryName),
    about: str(p.summary),
    photoUrl: imageUrl(p.profilePicture),
    backgroundUrl: imageUrl(p.backgroundPicture),
    openToWork: bool(p.openToWork),
    experience,
    education,
    skills,
    certifications,
    languages,
    projects,
    honors,
    volunteering,
    publications,
    courses,
    source: 'voyager',
    fetchedAt: new Date().toISOString(),
    raw: { usedDecoration: fetch.usedDecoration, profileUrn: fetch.profileUrn, requests: fetch.requests, entities: g.size() },
  };
}

function toExperience(pos: VoyagerEntity, g: EntityGraph, grp?: VoyagerEntity, grpCompany?: VoyagerEntity): ExperienceItem {
  const company = g.ref(pos, 'company') ?? grpCompany;
  return {
    title: str(pos.title) ?? '',
    company: str(pos.companyName) ?? str(grp?.companyName) ?? str(company?.name),
    companyUrl: str(company?.url),
    employmentType: str(g.ref(pos, 'employmentType')?.name) ?? str(pos.employmentTypeName),
    location: str(pos.locationName) ?? str(pos.geoLocationName),
    locationType: str(pos.workplaceType) ?? str(g.ref(pos, 'workplaceType')?.localizedName),
    dates: toDateRange(pos.dateRange),
    description: str(pos.description),
  };
}
