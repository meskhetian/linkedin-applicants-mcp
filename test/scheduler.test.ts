import { describe, expect, it } from 'vitest';
import { defaultPacing } from '../src/config.js';
import { Scheduler, hashUnit, localParts, zonedToUtc } from '../src/queue/scheduler.js';
import { Db } from '../src/storage/db.js';
import type { PacingSettings } from '../src/types.js';

const TZ = 'Europe/Istanbul'; // UTC+3, no DST

function make(nowIso: string, over: Partial<PacingSettings> = {}) {
  const db = new Db(':memory:');
  const pacing: PacingSettings = { ...defaultPacing('normal'), timezone: TZ, workHoursStart: '09:00', workHoursEnd: '19:00', workDays: [1, 2, 3, 4, 5], dailyCapVariance: 0, ...over };
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

describe('cap variance (no two days alike)', () => {
  const days = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30'];
  it('draws each day within the spread and never the same number every day', () => {
    const { s, setNow } = make('2026-09-21T08:00:00Z', { dailyApplicantCap: 100, dailyProfileCap: 60, hourlyActionCap: 40, rampStart: 0, rampPerDay: 0, dailyCapVariance: 0.35 });
    const seen = new Set<number>();
    for (const day of days) {
      setNow(`${day}T08:00:00Z`);
      const caps = s.effectiveCaps();
      expect(caps.applicants).toBeGreaterThanOrEqual(65);
      expect(caps.applicants).toBeLessThanOrEqual(135);
      expect(caps.profiles).toBeGreaterThanOrEqual(39);
      expect(caps.profiles).toBeLessThanOrEqual(81);
      expect(s.effectiveHourlyCap()).toBeGreaterThanOrEqual(26);
      expect(s.effectiveHourlyCap()).toBeLessThanOrEqual(54);
      seen.add(caps.applicants);
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it('is fixed for the day across restarts and processes, and varies by hour', () => {
    const { db, s, pacing } = make('2026-09-25T08:00:00Z', { dailyApplicantCap: 100, rampStart: 0, rampPerDay: 0, dailyCapVariance: 0.35 });
    const again = new Scheduler(db, () => pacing, () => new Date('2026-09-25T14:00:00Z'), Math.random);
    expect(again.effectiveCaps()).toEqual(s.effectiveCaps());
    expect(db.getSetting<string>('pacing.seed')).toBeTruthy();
    const hours = new Set([8, 9, 10, 11, 12, 13].map((h) => new Scheduler(db, () => pacing, () => new Date(`2026-09-25T${String(h).padStart(2, '0')}:00:00Z`)).effectiveHourlyCap()));
    expect(hours.size).toBeGreaterThan(1);
    // another installation gets other numbers from the same configuration
    const other = make('2026-09-25T08:00:00Z', { dailyApplicantCap: 100, rampStart: 0, rampPerDay: 0, dailyCapVariance: 0.35 });
    other.db.setSetting('pacing.seed', 'elsewhere');
    const differs = days.some((day) => {
      other.setNow(`${day}T08:00:00Z`);
      s.effectiveCaps();
      return other.s.effectiveCaps().applicants !== new Scheduler(db, () => pacing, () => new Date(`${day}T08:00:00Z`)).effectiveCaps().applicants;
    });
    expect(differs).toBe(true);
  });

  it('applies to the ramped value, keeps zero caps at zero, and 0 restores exact numbers', () => {
    const { s, db } = make('2026-09-25T08:00:00Z', { dailyApplicantCap: 120, rampStart: 40, rampPerDay: 15, dailyCapVariance: 0.35 });
    db.setSetting('first_action_at', '2026-09-24T08:00:00Z'); // day 1 of the ramp: 55
    const caps = s.effectiveCaps();
    expect(caps.applicants).toBeGreaterThanOrEqual(36);
    expect(caps.applicants).toBeLessThanOrEqual(74);
    const zero = make('2026-09-25T08:00:00Z', { dailyApplicantCap: 0, rampStart: 0, rampPerDay: 0, dailyCapVariance: 0.35 });
    expect(zero.s.effectiveCaps().applicants).toBe(0);
    const exact = make('2026-09-25T08:00:00Z', { dailyApplicantCap: 100, hourlyActionCap: 40, rampStart: 0, rampPerDay: 0, dailyCapVariance: 0 });
    expect(exact.s.effectiveCaps().applicants).toBe(100);
    expect(exact.s.effectiveHourlyCap()).toBe(40);
    expect(hashUnit('a')).not.toBe(hashUnit('b'));
    expect(hashUnit('2026-09-25')).toBeGreaterThanOrEqual(0);
    expect(hashUnit('2026-09-25')).toBeLessThan(1);
  });
});
