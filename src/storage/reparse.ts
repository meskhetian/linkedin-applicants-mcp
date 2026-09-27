import { parseAppliedOn, parseApplicantCardText, parseProRowText } from '../linkedin/applicants.js';
import type { Db } from './db.js';

/**
 * Bump when a list-card parser fix should be applied to rows that are already stored.
 * `bootstrap` re-parses once per version; `npm run reparse` does it on demand.
 */
export const LIST_PARSER_VERSION = 3;
export const PARSER_VERSION_SETTING = 'parser.listVersion';

export interface ReparseResult {
  rows: number;
  changed: number;
  /** Rows whose rating was LinkedIn's table match label rather than a recruiter rating, now cleared */
  ratingsCleared: number;
}

interface StoredRow {
  application_id: string;
  full_name: string;
  headline: string | null;
  location: string | null;
  applied_at: string | null;
  is_viewed: number | null;
  detail_fetched_at: string | null;
  raw: string | null;
}

/**
 * Re-run the current list-card parsers over the raw card text stored with every applicant row and
 * update name, headline, location, applied date and the viewed flag where the new parse differs.
 * Rows whose detail page was already fetched keep the detail parser's values unless the stored
 * name still carries a LinkedIn badge ("Jane Doe, new applicant"). Rows recovered by a table sweep
 * lose the rating an older version derived from LinkedIn's match label.
 */
export function reparseListRows(db: Db, jobId?: string): ReparseResult {
  const rows = db.rawApplicantRows(jobId) as unknown as StoredRow[];
  let changed = 0;
  let ratingsCleared = 0;
  db.transaction(() => {
    ratingsCleared = db.clearTableLabelRatings(jobId);
    for (const r of rows) {
      let raw: Record<string, unknown>;
      try {
        raw = r.raw ? (JSON.parse(r.raw) as Record<string, unknown>) : {};
      } catch {
        continue;
      }
      // Rows recovered by a table sweep were parsed from the table view, whose text the list parsers do not
      // understand; re-parsing them would blank the headline. They keep what the sweep stored.
      if (raw.source === 'table-sweep') continue;
      const rowText = typeof raw.rowText === 'string' ? raw.rowText : undefined;
      const cardText = typeof raw.cardText === 'string' ? raw.cardText : undefined;
      if (!rowText && !cardText) continue;

      let fullName: string;
      let headline: string | undefined;
      let location: string | undefined;
      let appliedAt: string | undefined;
      let isNew: boolean | undefined;
      let openToWork: boolean | undefined;
      if (rowText) {
        const p = parseProRowText(rowText);
        fullName = p.fullName;
        headline = [p.title, p.company].filter(Boolean).join(' at ') || undefined;
        location = p.location;
        appliedAt = parseAppliedOn(p.appliedOn);
        isNew = p.isNew;
        openToWork = p.openToWork;
      } else {
        const p = parseApplicantCardText(cardText!);
        fullName = p.fullName;
        headline = p.headline;
        location = p.location;
        appliedAt = parseAppliedOn(p.appliedAgo);
      }
      if (!fullName) continue;

      const badgeStillStored = /,\s*new applicant$|\bis open to work\b/i.test(r.full_name);
      if (r.detail_fetched_at && !badgeStillStored) continue;

      const next = {
        fullName,
        headline: headline ?? null,
        location: location ?? r.location,
        appliedAt: appliedAt ?? r.applied_at,
        isViewed: isNew ? 0 : r.is_viewed,
      };
      const same =
        next.fullName === r.full_name &&
        next.headline === (r.headline ?? null) &&
        next.location === r.location &&
        next.appliedAt === r.applied_at &&
        next.isViewed === r.is_viewed;
      if (same) continue;

      const newRaw = openToWork === undefined ? raw : { ...raw, openToWork };
      db.applyReparsedRow(r.application_id, { ...next, raw: newRaw });
      changed++;
    }
  });
  return { rows: rows.length, changed, ratingsCleared };
}

/** Run `reparseListRows` once per parser version and remember that it happened. */
export function reparseIfParserChanged(db: Db): ReparseResult | undefined {
  const stored = db.getSetting<number>(PARSER_VERSION_SETTING);
  if (stored === LIST_PARSER_VERSION) return undefined;
  const result = reparseListRows(db);
  db.setSetting(PARSER_VERSION_SETTING, LIST_PARSER_VERSION);
  return result;
}
