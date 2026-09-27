import os from 'node:os';
import path from 'node:path';
import type { BrowserMode, DelayKind, DelaySpec, LogLevel, PacingSettings, ProfileStrategy, Speed } from './types.js';

export interface Config {
  dataDir: string;
  dbPath: string;
  filesDir: string;
  debugDir: string;
  logsDir: string;
  profileDir: string;
  browserMode: BrowserMode;
  cdpUrl: string;
  chromeChannel: 'chrome' | 'msedge' | 'chromium';
  headless: boolean;
  logLevel: LogLevel;
  /** Persist raw Voyager JSON responses under debugDir/raw (heavy; off by default) */
  captureRaw: boolean;
  /** auto | voyager | dom, see ProfileStrategy */
  profileStrategy: ProfileStrategy;
  pacingDefaults: PacingSettings;
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const v = Number.parseInt(env(name, String(fallback)), 10);
  return Number.isFinite(v) ? v : fallback;
}

function envFloat(name: string, fallback: number): number {
  const v = Number.parseFloat(env(name, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Delay tables per speed. Values are milliseconds: {min, median, max} of a clipped log-normal.
 * "normal" is tuned to look like a recruiter working through applicants attentively.
 */
const DELAY_TABLES: Record<Speed, Record<DelayKind, DelaySpec>> = {
  slow: {
    micro: { minMs: 250, medianMs: 600, maxMs: 1500 },
    short: { minMs: 1500, medianMs: 3000, maxMs: 7000 },
    read: { minMs: 8000, medianMs: 18000, maxMs: 45000 },
    betweenPages: { minMs: 12000, medianMs: 25000, maxMs: 60000 },
    betweenApplicants: { minMs: 45000, medianMs: 90000, maxMs: 240000 },
    betweenProfiles: { minMs: 60000, medianMs: 120000, maxMs: 300000 },
  },
  normal: {
    micro: { minMs: 150, medianMs: 400, maxMs: 1000 },
    short: { minMs: 900, medianMs: 2000, maxMs: 5000 },
    read: { minMs: 5000, medianMs: 11000, maxMs: 30000 },
    betweenPages: { minMs: 7000, medianMs: 15000, maxMs: 40000 },
    betweenApplicants: { minMs: 25000, medianMs: 55000, maxMs: 150000 },
    betweenProfiles: { minMs: 35000, medianMs: 75000, maxMs: 200000 },
  },
  brisk: {
    micro: { minMs: 100, medianMs: 250, maxMs: 700 },
    short: { minMs: 600, medianMs: 1200, maxMs: 3000 },
    read: { minMs: 3000, medianMs: 6000, maxMs: 15000 },
    betweenPages: { minMs: 4000, medianMs: 8000, maxMs: 20000 },
    betweenApplicants: { minMs: 12000, medianMs: 25000, maxMs: 70000 },
    betweenProfiles: { minMs: 20000, medianMs: 40000, maxMs: 100000 },
  },
};

export function delaysForSpeed(speed: Speed): Record<DelayKind, DelaySpec> {
  return structuredClone(DELAY_TABLES[speed]);
}

export function defaultPacing(speed: Speed = 'normal'): PacingSettings {
  const [start, end] = env('LINKEDIN_MCP_WORK_HOURS', '09:00-19:00').split('-') as [string, string];
  const workDays = env('LINKEDIN_MCP_WORK_DAYS', '1,2,3,4,5')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  const capScale = speed === 'slow' ? 0.6 : speed === 'brisk' ? 1.4 : 1;
  return {
    speed,
    workHoursStart: start ?? '09:00',
    workHoursEnd: end ?? '19:00',
    workDays: workDays.length ? workDays : [1, 2, 3, 4, 5],
    timezone: process.env.LINKEDIN_MCP_TIMEZONE || undefined,
    dailyApplicantCap: Math.round(envInt('LINKEDIN_MCP_DAILY_APPLICANT_CAP', 120) * capScale),
    dailyProfileCap: Math.round(envInt('LINKEDIN_MCP_DAILY_PROFILE_CAP', 80) * capScale),
    hourlyActionCap: Math.round(envInt('LINKEDIN_MCP_HOURLY_ACTION_CAP', 40) * capScale),
    breakEveryActions: [25, 60],
    breakMinutes: [5, 20],
    delays: delaysForSpeed(speed),
    randomizeOrder: true,
    warmupProbability: 0.08,
    rampStart: envInt('LINKEDIN_MCP_RAMP_START', 25),
    rampPerDay: envInt('LINKEDIN_MCP_RAMP_PER_DAY', 10),
    dailyCapVariance: Math.min(0.5, Math.max(0, envFloat('LINKEDIN_MCP_DAILY_CAP_VARIANCE', 0.35))),
    savePdfMonthlyCap: envInt('LINKEDIN_MCP_SAVE_PDF_MONTHLY_CAP', 150),
  };
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(expandHome(env('LINKEDIN_MCP_DATA_DIR', '~/.linkedin-applicants-mcp')));
  const speed = (env('LINKEDIN_MCP_SPEED', 'normal').toLowerCase() as Speed) || 'normal';
  const browserMode = (env('LINKEDIN_MCP_BROWSER_MODE', 'persistent').toLowerCase() as BrowserMode) || 'persistent';
  const chromeChannel = env('LINKEDIN_MCP_CHROME_CHANNEL', 'chrome') as Config['chromeChannel'];
  const logLevel = env('LINKEDIN_MCP_LOG_LEVEL', 'info').toLowerCase() as LogLevel;
  const profileStrategy = env('LINKEDIN_MCP_PROFILE_STRATEGY', 'auto').toLowerCase() as ProfileStrategy;
  const cfg: Config = {
    dataDir,
    dbPath: path.join(dataDir, 'db.sqlite'),
    filesDir: path.join(dataDir, 'files'),
    debugDir: path.join(dataDir, 'debug'),
    logsDir: path.join(dataDir, 'logs'),
    profileDir: path.join(dataDir, 'chrome-profile'),
    browserMode: browserMode === 'cdp' ? 'cdp' : 'persistent',
    cdpUrl: env('LINKEDIN_MCP_CDP_URL', 'http://127.0.0.1:9222'),
    chromeChannel: ['chrome', 'msedge', 'chromium'].includes(chromeChannel) ? chromeChannel : 'chrome',
    headless: envBool('LINKEDIN_MCP_HEADLESS', false),
    logLevel: ['debug', 'info', 'warn', 'error'].includes(logLevel) ? logLevel : 'info',
    captureRaw: envBool('LINKEDIN_MCP_CAPTURE_RAW', false),
    profileStrategy: ['auto', 'voyager', 'dom'].includes(profileStrategy) ? profileStrategy : 'auto',
    pacingDefaults: defaultPacing(['slow', 'normal', 'brisk'].includes(speed) ? speed : 'normal'),
  };
  return { ...cfg, ...overrides };
}
