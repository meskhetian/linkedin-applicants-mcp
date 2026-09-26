import { describe, expect, it } from 'vitest';
import { defaultPacing } from '../src/config.js';
import { Scheduler, localParts, zonedToUtc } from '../src/queue/scheduler.js';
import { Db } from '../src/storage/db.js';
import type { PacingSettings } from '../src/types.js';

const TZ = 'Europe/Istanbul'; // UTC+3, no DST

function make(nowIso: string, over: Partial<PacingSettings> = {}) {
  const db = new Db(':memory:');
  const pacing: PacingSettings = { ...defaultPacing('normal'), timezone: TZ, workHoursStart: '09:00', workHoursEnd: '19:00', workDays: [1, 2, 3, 4, 5], ...over };
  let now = new Date(nowIso);
  const rng = () => 0; // zero jitter → deterministic window edges
  const s = new Scheduler(db, () => pacing, () => now, rng);
  return { db, s, pacing, setNow: (iso: string) => (now = new Date(iso)) };
}

describe('localParts / zonedToUtc', () => {
  it('round-trips a wall clock time in a time zone', () => {
    const d = zonedToUtc('2026-09-25', '09:00', TZ);
    const lp = localParts(d, TZ);
    expect(lp.hour).toBe(9);
    expect(lp.minute).toBe(0);
    expect(lp.dateKey).toBe('2026-09-25');
    expect(d.toISOString()).toBe('2026-09-25T06:00:00.000Z');
  });
});

describe('Scheduler window', () => {
  it('allows work inside the window on a weekday', () => {
    const { s } = make('2026-09-25T08:00:00Z'); // Fri 11:00 Istanbul
    expect(s.inWorkWindow()).toBe(true);
    expect(s.check('fetch_application')).toEqual({ ok: true });
  });

  it('defers to the next window start when outside hours', () => {
    const { s } = make('2026-09-25T18:30:00Z'); // Fri 21:30 Istanbul
    const r = s.check('fetch_application');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/working hours/);
      // next work day is Monday 2026-09-28 09:00 Istanbul = 06:00Z
      expect(r.resumeAt.toISOString()).toBe('2026-09-28T06:00:00.000Z');
    }
  });

  it('skips non-work days', () => {
    const { s } = make('2026-09-26T08:00:00Z'); // Saturday
    expect(s.inWorkWindow()).toBe(false);
    expect(s.nextWindowStart().toISOString()).toBe('2026-09-28T06:00:00.000Z');
  });

  it('returns today start when before the window', () => {
    const { s } = make('2026-09-25T03:00:00Z'); // Fri 06:00 Istanbul
    expect(s.nextWindowStart().toISOString()).toBe('2026-09-25T06:00:00.000Z');
  });
});

describe('Scheduler caps and breaks', () => {
  it('enforces the daily applicant cap and resumes next work day', () => {
    const { s } = make('2026-09-25T08:00:00Z', { dailyApplicantCap: 2, breakEveryActions: [1000, 1000] });
    s.recordAction('fetch_application');
    s.recordAction('fetch_application');
    const r = s.check('fetch_application');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/daily applicant cap/);
      expect(r.resumeAt.toISOString()).toBe('2026-09-28T06:00:00.000Z');
    }
    // profiles are capped independently
    expect(s.check('fetch_profile')).toEqual({ ok: true });
  });

  it('enforces the hourly action cap', () => {
    const { s } = make('2026-09-25T08:10:00Z', { hourlyActionCap: 3, breakEveryActions: [1000, 1000] });
    s.recordAction('sync_applicants');
    s.recordAction('sync_applicants');
    s.recordAction('fetch_profile');
    const r = s.check('sync_applicants');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/hourly/);
      expect(r.resumeAt.getTime()).toBeGreaterThan(new Date('2026-09-25T09:00:00Z').getTime());
    }
  });

  it('schedules a long break after N actions and clears it once elapsed', () => {
    const { s, setNow } = make('2026-09-25T08:00:00Z', { breakEveryActions: [2, 2], breakMinutes: [10, 10] });
    expect(s.recordAction('fetch_application').breakMs).toBeUndefined();
    const res = s.recordAction('fetch_application');
    expect(res.breakMs).toBeGreaterThanOrEqual(10 * 60_000);
    const r = s.check('fetch_application');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('on a break');
    setNow('2026-09-25T08:15:00Z');
    expect(s.check('fetch_application')).toEqual({ ok: true });
  });

  it('counters persist in the database across scheduler instances', () => {
    const { db, s } = make('2026-09-25T08:00:00Z');
    s.recordAction('fetch_profile');
    const s2 = new Scheduler(db, () => ({ ...defaultPacing('normal'), timezone: TZ }), () => new Date('2026-09-25T08:30:00Z'));
    expect(s2.todayCounts().profiles).toBe(1);
    expect(s2.todayCounts().actions).toBe(1);
  });
});
