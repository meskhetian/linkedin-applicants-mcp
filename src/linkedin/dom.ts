import type { Locator, Page } from 'patchright';
import { SelectorNotFoundError } from '../errors.js';

/**
 * Selector-list helpers. Every LinkedIn element is looked up through an ordered list of candidate
 * selectors so a single markup change does not break the scraper.
 */

/** First candidate that currently matches at least one visible element (checked in order). */
export async function firstVisible(root: Page | Locator, candidates: string[], opts: { timeoutMs?: number } = {}): Promise<Locator | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 0);
  do {
    for (const sel of candidates) {
      try {
        const loc = root.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) return loc;
      } catch {
        /* invalid selector for this engine, skip */
      }
    }
    if (Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < deadline);
  return null;
}

/** First candidate that matches at least one element (visible or not). */
export async function firstPresent(root: Page | Locator, candidates: string[]): Promise<Locator | null> {
  for (const sel of candidates) {
    try {
      const loc = root.locator(sel);
      if ((await loc.count().catch(() => 0)) > 0) return loc.first();
    } catch {
      /* skip */
    }
  }
  return null;
}

/** All elements for the first candidate that matches anything. */
export async function allOfFirst(root: Page | Locator, candidates: string[]): Promise<Locator[]> {
  for (const sel of candidates) {
    try {
      const loc = root.locator(sel);
      const n = await loc.count().catch(() => 0);
      if (n > 0) return Array.from({ length: n }, (_, i) => loc.nth(i));
    } catch {
      /* skip */
    }
  }
  return [];
}

export async function requireVisible(root: Page | Locator, candidates: string[], what: string, timeoutMs = 10_000, url?: string): Promise<Locator> {
  const loc = await firstVisible(root, candidates, { timeoutMs });
  if (!loc) throw new SelectorNotFoundError(what, candidates, url);
  return loc;
}

export async function textOf(loc: Locator | null | undefined): Promise<string | undefined> {
  if (!loc) return undefined;
  try {
    const t = (await loc.innerText({ timeout: 2000 })).trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

export async function attrOf(loc: Locator | null | undefined, name: string): Promise<string | undefined> {
  if (!loc) return undefined;
  try {
    return (await loc.getAttribute(name, { timeout: 2000 })) ?? undefined;
  } catch {
    return undefined;
  }
}

/** innerText of the page's <main> (or body), capped. Cheap, locale-agnostic raw snapshot. */
export async function mainText(page: Page, maxChars = 200_000): Promise<string> {
  try {
    const t = await page.evaluate(() => {
      const el = document.querySelector('main') ?? document.body;
      return (el as HTMLElement | null)?.innerText ?? '';
    });
    return t.length > maxChars ? t.slice(0, maxChars) : t;
  } catch {
    return '';
  }
}

/** All anchors (href + text) under root, profile links, resume links, detail links. */
export async function collectLinks(page: Page, rootSelector = 'main'): Promise<Array<{ href: string; text: string }>> {
  try {
    return await page.evaluate((sel) => {
      const root = document.querySelector(sel) ?? document.body;
      return Array.from(root.querySelectorAll('a[href]'))
        .map((a) => ({ href: (a as HTMLAnchorElement).href, text: ((a as HTMLElement).innerText || a.getAttribute('aria-label') || '').trim().slice(0, 200) }))
        .filter((l) => l.href.startsWith('http'));
    }, rootSelector);
  } catch {
    return [];
  }
}

/** Wheel-scroll until innerText length of `selector` stops growing (SDUI lazy lists). */
export async function scrollUntilStable(page: Page, scrollOnce: () => Promise<void>, selector = 'main', maxRounds = 25): Promise<void> {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < maxRounds && stable < 2; i++) {
    await scrollOnce();
    const len = await page.evaluate((s) => ((document.querySelector(s) as HTMLElement | null)?.innerText ?? '').length, selector).catch(() => 0);
    if (len === last) stable++;
    else stable = 0;
    last = len;
  }
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(\+?\(?\d[\d\s().-]{7,}\d)/;

export function extractEmail(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return EMAIL_RE.exec(text)?.[0];
}

export function extractPhone(text: string | undefined): string | undefined {
  if (!text) return undefined;
  // Year ranges ("2009-2011", "2021 - Present") and counters ("6/6") are not phone numbers.
  const cleaned = text
    .replace(/\u00a0/g, ' ')
    .replace(/\b(19|20)\d{2}\s*[-\u2013]\s*((19|20)\d{2}|present|now|current)\b/gi, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}\b/g, ' ');
  const m = PHONE_RE.exec(cleaned);
  if (!m) return undefined;
  const candidate = m[1]!.trim();
  const digits = candidate.replace(/\D/g, '');
  if (digits.length > 15) return undefined;
  // A bare run of more than ten digits with no separators is an id (application, member), not a phone number.
  if (/^\d+$/.test(candidate) && digits.length > 10) return undefined;
  // Local numbers can be short, but without a country code we want at least 9 digits to avoid dates and ids.
  return digits.length >= (candidate.startsWith('+') ? 8 : 9) ? candidate : undefined;
}

/** "Applied 3 days ago" / "2 weeks ago" → ISO date (approximate). */
export function relativeToIso(text: string | undefined, now: Date = new Date()): string | undefined {
  if (!text) return undefined;
  // "Applied 3 days ago", "2 weeks ago", and LinkedIn's short forms "3d ago", "5h ago", "2w ago", "1mo ago", "1yr ago"
  const m = /(\d+)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|yrs?|mo|d|h|w|m|y)\s*ago/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  const u = m[2]!.toLowerCase();
  const unit = u.startsWith('min') || u === 'm' ? 'minute' : u.startsWith('h') ? 'hour' : u.startsWith('d') ? 'day' : u.startsWith('w') ? 'week' : u.startsWith('mo') ? 'month' : u.startsWith('y') ? 'year' : 'day';
  const ms: Record<string, number> = { minute: 60e3, hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 };
  return new Date(now.getTime() - n * ms[unit]!).toISOString();
}

/** "1,234 applicants" → 1234 */
export function parseCount(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = /(\d[\d,.]*)\s*\+?\s*applicants?/i.exec(text) ?? /(\d[\d,.]*)/.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]!.replace(/[,.](?=\d{3}\b)/g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}
