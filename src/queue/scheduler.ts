import type { Db } from '../storage/db.js';
import type { PacingSettings, TaskType } from '../types.js';
import { randInt, type Rng } from '../browser/humanize.js';

/** `scope: 'type'` blocks only that task type (a daily cap); everything else blocks the whole queue. */
export type ScheduleDecision = { ok: true } | { ok: false; reason: string; resumeAt: Date; scope: 'type' | 'global' };

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
  dateKey: string; // YYYY-MM-DD
  hourKey: string; // YYYY-MM-DDTHH
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const SEED_SETTING = 'pacing.seed';

/** Deterministic hash of a string to [0, 1): FNV-1a with a final avalanche, so neighbouring keys spread apart. */
export function hashUnit(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

export function localParts(d: Date, timeZone?: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  const hour = Number(p.hour) % 24; // "24" can appear for midnight in some engines
  const dateKey = `${p.year}-${p.month}-${p.day}`;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour,
    minute: Number(p.minute),
    weekday: WEEKDAYS[p.weekday ?? 'Mon'] ?? 1,
    dateKey,
    hourKey: `${dateKey}T${String(hour).padStart(2, '0')}`,
  };
}

/** Convert a wall-clock time in a time zone to a UTC Date (two-pass to handle DST edges). */
export function zonedToUtc(dateKey: string, hhmm: string, timeZone?: string): Date {
  const [hh, mm] = hhmm.split(':').map((s) => Number.parseInt(s, 10)) as [number, number];
  const guess = new Date(`${dateKey}T${String(hh).padStart(2, '0')}:${String(mm || 0).padStart(2, '0')}:00Z`);
  if (!timeZone) {
    // System local time
    const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
    return new Date(y, m - 1, d, hh, mm || 0, 0, 0);
  }
  let result = guess;
  for (let i = 0; i < 2; i++) {
    const lp = localParts(result, timeZone);
    const asUtc = Date.UTC(lp.year, lp.month - 1, lp.day, lp.hour, lp.minute);
    const offset = asUtc - result.getTime();
    result = new Date(guess.getTime() - offset);
  }
  return result;
}

function addDays(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((s) => Number.parseInt(s, 10)) as [number, number];
  return (h || 0) * 60 + (m || 0);
}

export const COUNTER_APPLICANTS = 'applicants';
export const COUNTER_PROFILES = 'profiles';
export const COUNTER_ACTIONS = 'actions';

export function counterKindsFor(type: TaskType): string[] {
  switch (type) {
    case 'fetch_application':
      return [COUNTER_APPLICANTS, COUNTER_ACTIONS];
    case 'fetch_profile':
      return [COUNTER_PROFILES, COUNTER_ACTIONS];
    default:
      return [COUNTER_ACTIONS];
  }
}

/**
 * Decides whether the worker may act now: working hours & days (with per-day jitter so we
 * do not start at 09:00:00 sharp), daily caps for applicant/profile views, an hourly action cap,
 * and periodic long breaks. All counters live in SQLite so they survive restarts.
 */
export class Scheduler {
  private actionsSinceBreak = 0;
  private nextBreakAt: number;
  private breakUntil?: Date;
  private dayJitter = new Map<string, { startOffsetMin: number; endOffsetMin: number }>();

  constructor(
    private readonly db: Db,
    private readonly getPacing: () => PacingSettings,
    private readonly now: () => Date = () => new Date(),
    private readonly rng: Rng = Math.random,
  ) {
    this.nextBreakAt = this.sampleBreakInterval();
  }

  private sampleBreakInterval(): number {
    const [a, b] = this.getPacing().breakEveryActions;
    return randInt(Math.min(a, b), Math.max(a, b), this.rng);
  }

  /**
   * Per-installation random seed for the cap variance, created once and kept in the database. The first process to
   * store it wins (insert-if-absent, then read back), so the MCP server, the worker and the dashboard always agree.
   */
  private seedValue?: string;
  private seed(): string {
    if (this.seedValue) return this.seedValue;
    const existing = this.db.getSetting<string>(SEED_SETTING);
    this.seedValue = existing || this.db.setSettingIfAbsent(SEED_SETTING, Math.floor(this.rng() * 0xffffffff).toString(36) + Date.now().toString(36));
    return this.seedValue;
  }

  /**
   * A cap varied for one key (a day or an hour): drawn once between (1 - variance) and 1 times the base, fixed for
   * that key on this installation, so a restart or a second process cannot change today's number. The draw only ever
   * lowers the cap: the configured value stays a ceiling, so every limit documented for it still holds.
   */
  private varied(key: string, base: number, variance: number): number {
    if (base <= 0 || variance <= 0) return base;
    const factor = 1 - variance * hashUnit(`${this.seed()}|${key}`);
    return Math.max(1, Math.min(base, Math.round(base * factor)));
  }

  private jitterFor(dateKey: string) {
    let j = this.dayJitter.get(dateKey);
    if (!j) {
      j = { startOffsetMin: randInt(0, 25, this.rng), endOffsetMin: randInt(0, 20, this.rng) };
      this.dayJitter.set(dateKey, j);
    }
    return j;
  }

  private tz(): string | undefined {
    return this.getPacing().timezone || undefined;
  }

  /** Is `d` inside today's (jittered) work window on a work day? */
  inWorkWindow(d: Date = this.now()): boolean {
    const p = this.getPacing();
    const lp = localParts(d, this.tz());
    if (!p.workDays.includes(lp.weekday)) return false;
    const j = this.jitterFor(lp.dateKey);
    const nowMin = lp.hour * 60 + lp.minute;
    const start = hhmmToMinutes(p.workHoursStart) + j.startOffsetMin;
    const end = hhmmToMinutes(p.workHoursEnd) - j.endOffsetMin;
    return nowMin >= start && nowMin < end;
  }

  /** Start of the next work window strictly after `d` (or today's start if we are before it). */
  nextWindowStart(d: Date = this.now()): Date {
    const p = this.getPacing();
    const tz = this.tz();
    const lp = localParts(d, tz);
    for (let i = 0; i < 14; i++) {
      const dateKey = addDays(lp.dateKey, i);
      const weekday = (lp.weekday + i) % 7;
      if (!p.workDays.includes(weekday)) continue;
      const j = this.jitterFor(dateKey);
      const startMin = hhmmToMinutes(p.workHoursStart) + j.startOffsetMin;
      const start = zonedToUtc(dateKey, `${Math.floor(startMin / 60)}:${startMin % 60}`, tz);
      if (start.getTime() > d.getTime()) return start;
    }
    return new Date(d.getTime() + 86_400_000);
  }

  /** Start of the next work window on a later day than `d` (used when a daily cap is hit). */
  nextDayWindowStart(d: Date = this.now()): Date {
    const lp = localParts(d, this.tz());
    const tomorrow = zonedToUtc(addDays(lp.dateKey, 1), '00:00', this.tz());
    return this.nextWindowStart(new Date(tomorrow.getTime() - 1));
  }

  todayCounts(d: Date = this.now()): { applicants: number; profiles: number; actions: number } {
    const lp = localParts(d, this.tz());
    return {
      applicants: this.db.getCounter(COUNTER_APPLICANTS, lp.dateKey),
      profiles: this.db.getCounter(COUNTER_PROFILES, lp.dateKey),
      actions: this.db.getCounter(COUNTER_ACTIONS, lp.dateKey),
    };
  }

  hourCount(d: Date = this.now()): number {
    const lp = localParts(d, this.tz());
    return this.db.getCounter(COUNTER_ACTIONS, lp.hourKey);
  }

  /** Days since the first recorded action (0 on the first day). Persisted in settings. */
  daysSinceFirstAction(d: Date = this.now()): number {
    const first = this.db.getSetting<string>('first_action_at');
    if (!first) return 0;
    return Math.max(0, Math.floor((d.getTime() - new Date(first).getTime()) / 86_400_000));
  }

  /** The configured caps after the warm-up ramp, before the day's variation (the ceiling for the day). */
  rampedCaps(d: Date = this.now()): { applicants: number; profiles: number } {
    const p = this.getPacing();
    let applicants = p.dailyApplicantCap;
    let profiles = p.dailyProfileCap;
    if (p.rampStart && p.rampPerDay) {
      const ramp = p.rampStart + p.rampPerDay * this.daysSinceFirstAction(d);
      applicants = Math.min(applicants, Math.max(1, ramp));
      profiles = Math.min(profiles, Math.max(1, Math.round(ramp * 0.7)));
    }
    return { applicants, profiles };
  }

  /** Today's caps: the ramped caps, lowered by the day's draw like a person's uneven workload. */
  effectiveCaps(d: Date = this.now()): { applicants: number; profiles: number } {
    const { applicants, profiles } = this.rampedCaps(d);
    const v = this.getPacing().dailyCapVariance ?? 0;
    const { dateKey } = localParts(d, this.tz());
    return { applicants: this.varied(`applicants:${dateKey}`, applicants, v), profiles: this.varied(`profiles:${dateKey}`, profiles, v) };
  }

  /** What an average day allows (the draw averages 1 - variance / 2 of the ceiling): use this for multi-day estimates. */
  expectedDailyCaps(d: Date = this.now()): { applicants: number; profiles: number } {
    const { applicants, profiles } = this.rampedCaps(d);
    const f = 1 - (this.getPacing().dailyCapVariance ?? 0) / 2;
    return { applicants: Math.max(1, Math.round(applicants * f)), profiles: Math.max(1, Math.round(profiles * f)) };
  }

  /** This hour's action cap: the configured cap, varied per hour the same way as the daily caps. */
  effectiveHourlyCap(d: Date = this.now()): number {
    const p = this.getPacing();
    return this.varied(`hour:${localParts(d, this.tz()).hourKey}`, p.hourlyActionCap, p.dailyCapVariance ?? 0);
  }

  /** May a task of this type run right now? */
  check(type: TaskType, d: Date = this.now()): ScheduleDecision {
    const p = this.getPacing();
    const caps = this.effectiveCaps(d);
    if (this.breakUntil && this.breakUntil.getTime() > d.getTime()) {
      return { ok: false, reason: 'on a break', resumeAt: this.breakUntil, scope: 'global' };
    }
    if (!this.inWorkWindow(d)) {
      return { ok: false, reason: 'outside working hours', resumeAt: this.nextWindowStart(d), scope: 'global' };
    }
    const today = this.todayCounts(d);
    if (type === 'fetch_application' && today.applicants >= caps.applicants) {
      return { ok: false, reason: `daily applicant cap reached (${today.applicants}/${caps.applicants})`, resumeAt: this.nextDayWindowStart(d), scope: 'type' };
    }
    if (type === 'fetch_profile' && today.profiles >= caps.profiles) {
      return { ok: false, reason: `daily profile cap reached (${today.profiles}/${caps.profiles})`, resumeAt: this.nextDayWindowStart(d), scope: 'type' };
    }
    const hour = this.hourCount(d);
    const hourlyCap = this.effectiveHourlyCap(d);
    if (hour >= hourlyCap) {
      const lp = localParts(d, this.tz());
      const nextHour = zonedToUtc(lp.dateKey, `${lp.hour}:00`, this.tz());
      const resume = new Date(nextHour.getTime() + 3_600_000 + randInt(60_000, 300_000, this.rng));
      return { ok: false, reason: `hourly action cap reached (${hour}/${hourlyCap})`, resumeAt: resume, scope: 'global' };
    }
    return { ok: true };
  }

  /**
   * Record that a task of this type performed its LinkedIn activity. Returns a break to take, if due.
   */
  recordAction(type: TaskType, d: Date = this.now()): { breakMs?: number } {
    const lp = localParts(d, this.tz());
    if (!this.db.getSetting<string>('first_action_at')) this.db.setSetting('first_action_at', d.toISOString());
    for (const kind of counterKindsFor(type)) {
      this.db.incrementCounter(kind, lp.dateKey);
      if (kind === COUNTER_ACTIONS) this.db.incrementCounter(kind, lp.hourKey);
    }
    this.actionsSinceBreak++;
    if (this.actionsSinceBreak >= this.nextBreakAt) {
      const [a, b] = this.getPacing().breakMinutes;
      const minutes = randInt(Math.min(a, b), Math.max(a, b), this.rng);
      const ms = minutes * 60_000 + randInt(0, 59_000, this.rng);
      this.breakUntil = new Date(d.getTime() + ms);
      this.actionsSinceBreak = 0;
      this.nextBreakAt = this.sampleBreakInterval();
      return { breakMs: ms };
    }
    return {};
  }

  /** Force a break (e.g. after a soft rate-limit signal). */
  takeBreak(ms: number, d: Date = this.now()): Date {
    this.breakUntil = new Date(d.getTime() + ms);
    return this.breakUntil;
  }

  clearBreak(): void {
    this.breakUntil = undefined;
  }
}
