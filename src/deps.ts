import type { Config } from './config.js';
import type { Db } from './storage/db.js';
import type { BrowserSession } from './browser/session.js';
import type { Scheduler } from './queue/scheduler.js';
import type { Worker } from './queue/worker.js';
import type { Logger, PacingSettings } from './types.js';

/** Shared dependency bag handed to every tool module and the worker. */
export interface Deps {
  cfg: Config;
  db: Db;
  log: Logger;
  session: BrowserSession;
  scheduler: Scheduler;
  worker: Worker;
  /** Current pacing = env defaults overlaid with the persisted 'pacing' setting */
  getPacing: () => PacingSettings;
  setPacing: (patch: Partial<PacingSettings>) => PacingSettings;
}
