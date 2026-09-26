import { describe, expect, it } from 'vitest';
import { Db } from '../src/storage/db.js';
import { LIST_PARSER_VERSION, PARSER_VERSION_SETTING, reparseIfParserChanged, reparseListRows } from '../src/storage/reparse.js';

const now = '2026-09-25T10:00:00.000Z';
const badgeRow = 'Dana Whitfield, new applicant\nDana Whitfield\n\nHead of Operations | Scaling logistics platforms\n\nSan Francisco Bay Area\n\n4/6\n\nMust-have\n\n5/5\n\nPreferred';
const openRow = 'Priya Raman is open to work, new applicant\nPriya Raman\n\n--\n\nAustin, Texas, United States\n\n1/6\n\nMust-have\n\n2/5\n\nPreferred';

function seed() {
  const db = new Db(':memory:');
  db.upsertJob({ jobId: 'j1', title: 'COO', status: 'open', url: 'https://www.linkedin.com/hiring/jobs/j1/applicants/', syncedAt: now });
  // Rows exactly as an older parser stored them: badge line taken as the name, real name folded into the headline.
  db.upsertApplicantFromList({ applicationId: 'a1', jobId: 'j1', fullName: 'Dana Whitfield, new applicant', headline: 'Dana Whitfield at Head of Operations | Scaling logistics platforms', location: 'San Francisco Bay Area', listSyncedAt: now, raw: { rowText: badgeRow, listPage: 5 } });
  db.upsertApplicantFromList({ applicationId: 'a2', jobId: 'j1', fullName: 'Priya Raman is open to work, new applicant', headline: 'Priya Raman at --', location: 'Austin, Texas, United States', listSyncedAt: now, raw: { rowText: openRow, listPage: 6 } });
  db.upsertApplicantFromList({ applicationId: 'a3', jobId: 'j1', fullName: 'Grace Hopper', headline: 'Compiler pioneer', location: 'Arlington, Virginia, United States', listSyncedAt: now, raw: { rowText: 'Grace Hopper\n\n· 2nd\n\nCompiler pioneer\n\nArlington, Virginia, United States' } });
  return db;
}

describe('reparseListRows', () => {
  it('repairs names, headlines and the viewed flag from the stored raw text', () => {
    const db = seed();
    const r = reparseListRows(db);
    expect(r).toEqual({ rows: 3, changed: 2 });
    const a1 = db.getApplicant('a1')!;
    expect(a1.fullName).toBe('Dana Whitfield');
    expect(a1.headline).toBe('Head of Operations | Scaling logistics platforms');
    expect(a1.location).toBe('San Francisco Bay Area');
    expect(a1.isViewed).toBe(false);
    const a2 = db.getApplicant('a2')!;
    expect(a2.fullName).toBe('Priya Raman');
    expect(a2.headline).toBeUndefined();
    expect((a2.raw as { openToWork?: boolean }).openToWork).toBe(true);
    expect(db.getApplicant('a3')!.fullName).toBe('Grace Hopper');
    // Search index follows the repaired values.
    expect(db.listApplicants({ search: 'whitfield' }).items.map((a) => a.applicationId)).toEqual(['a1']);
    expect(db.listApplicants({ search: 'applicant' }).total).toBe(0);
  });

  it('is idempotent and keeps detail-fetched rows unless they still carry a badge', () => {
    const db = seed();
    db.updateApplicantDetail('a3', { fullName: 'Grace B. Hopper', headline: 'Rear Admiral' });
    expect(reparseListRows(db).changed).toBe(2);
    expect(reparseListRows(db).changed).toBe(0);
    expect(db.getApplicant('a3')!.fullName).toBe('Grace B. Hopper');
    expect(db.getApplicant('a3')!.headline).toBe('Rear Admiral');
  });

  it('runs once per parser version at startup', () => {
    const db = seed();
    expect(reparseIfParserChanged(db)?.changed).toBe(2);
    expect(db.getSetting<number>(PARSER_VERSION_SETTING)).toBe(LIST_PARSER_VERSION);
    expect(reparseIfParserChanged(db)).toBeUndefined();
  });
});
