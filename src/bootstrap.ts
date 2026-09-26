import fs from 'node:fs';
import { delaysForSpeed, loadConfig, type Config } from './config.js';
import { createLogger } from './log.js';
import { Db } from './storage/db.js';
import { BrowserSession } from './browser/session.js';
import { Scheduler } from './queue/scheduler.js';
import { SETTINGS, Worker } from './queue/worker.js';
import type { Deps } from './deps.js';
import type { PacingSettings } from './types.js';

/** Merge env defaults with the persisted pacing override. A speed-only override recomputes the delay table. */
export function mergePacing(defaults: PacingSettings, override: Partial<PacingSettings> | undefined): PacingSettings {
  if (!override) return defaults;
  const merged: PacingSettings = { ...defaults, ...override };
  if (override.speed && !override.delays) merged.delays = delaysForSpeed(override.speed);
  return merged;
}

/** Wire config → logger → db → session → scheduler → worker into a Deps bag. */
export function bootstrap(opts: { ownerKind: 'mcp' | 'cli'; cfg?: Config }): Deps {
  const cfg = opts.cfg ?? loadConfig();
  for (const dir of [cfg.dataDir, cfg.filesDir, cfg.debugDir, cfg.logsDir]) fs.mkdirSync(dir, { recursive: true });
  // The data directory holds applicant PII and the LinkedIn session: owner-only permissions (best effort).
  try {
    fs.chmodSync(cfg.dataDir, 0o700);
  } catch {
    /* Windows or unusual FS */
  }
  const log = createLogger({ level: cfg.logLevel, logsDir: cfg.logsDir }, { app: 'linkedin-applicants-mcp', owner: opts.ownerKind, pid: process.pid });
  const db = new Db(cfg.dbPath);
  const stale = db.resetStaleRunning();
  if (stale) log.warn('reset stale running tasks from a previous process', { count: stale });

  const getPacing = (): PacingSettings => mergePacing(cfg.pacingDefaults, db.getSetting<Partial<PacingSettings>>(SETTINGS.pacing));
  // Other processes (dashboard, CLI worker started without the MCP env) read the effective pacing from here.
  const publishEffective = () => db.setSetting(SETTINGS.pacingEffective, getPacing());
  const setPacing = (patch: Partial<PacingSettings>): PacingSettings => {
    const current = db.getSetting<Partial<PacingSettings>>(SETTINGS.pacing) ?? {};
    const next: Partial<PacingSettings> = { ...current, ...patch };
    if (patch.speed && !patch.delays) delete next.delays;
    db.setSetting(SETTINGS.pacing, next);
    publishEffective();
    return getPacing();
  };
  publishEffective();

  const session = new BrowserSession({ cfg, log: log.child({ mod: 'browser' }), getPacing });
  const scheduler = new Scheduler(db, getPacing);
  const worker = new Worker({ cfg, db, log: log.child({ mod: 'worker' }), session, scheduler, getPacing, ownerKind: opts.ownerKind });
  log.info('bootstrapped', { dataDir: cfg.dataDir, browserMode: cfg.browserMode, profileStrategy: cfg.profileStrategy, speed: getPacing().speed });
  return { cfg, db, log, session, scheduler, worker, getPacing, setPacing };
}
