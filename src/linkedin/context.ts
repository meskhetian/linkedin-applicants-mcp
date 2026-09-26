import type { Page } from 'patchright';
import type { Config } from '../config.js';
import type { Humanizer } from '../browser/humanize.js';
import type { NetworkCapture } from '../browser/capture.js';
import type { Db } from '../storage/db.js';
import type { Logger } from '../types.js';
import type { BrowserSession } from '../browser/session.js';
import { LEGACY_MARKERS, type Generation } from './selectors.js';

/** Everything a LinkedIn page module needs. Built by the worker (or a tool) from the BrowserSession. */
export interface ScrapeContext {
  page: Page;
  human: Humanizer;
  capture: NetworkCapture;
  log: Logger;
  cfg: Config;
  db: Db;
  /** Throws CheckpointError / NotLoggedInError if LinkedIn is asking for a human. Call after every navigation. */
  assertHealthy(): Promise<void>;
  /** Which DOM generation the current page renders ('legacy' artdeco vs 'sdui'). Cached per page load. */
  generation(): Promise<Generation>;
  /** Optional: report progress for long tasks (pages visited, items found) */
  progress?(msg: string, data?: Record<string, unknown>): void;
}

/** Legacy artdeco markup vs. SDUI: sdui_ver cookie present, or none of the legacy marker classes in the DOM. */
export async function detectGeneration(page: Page): Promise<Generation> {
  try {
    const cookies = await page.context().cookies('https://www.linkedin.com');
    if (cookies.some((c) => c.name === 'sdui_ver')) return 'sdui';
  } catch {
    /* ignore */
  }
  try {
    const hasLegacy = await page.evaluate((markers) => markers.some((m) => document.querySelector(m) !== null), LEGACY_MARKERS);
    return hasLegacy ? 'legacy' : 'sdui';
  } catch {
    return 'sdui';
  }
}

export function createScrapeContext(
  session: BrowserSession,
  base: { cfg: Config; db: Db; log: Logger },
  page: Page,
  progress?: (msg: string, data?: Record<string, unknown>) => void,
): ScrapeContext {
  let cached: { url: string; gen: Generation } | undefined;
  return {
    page,
    human: session.human,
    capture: session.capture,
    log: base.log,
    cfg: base.cfg,
    db: base.db,
    assertHealthy: () => session.assertHealthy(page),
    async generation() {
      const url = page.url();
      if (cached && cached.url === url) return cached.gen;
      const gen = await detectGeneration(page);
      cached = { url, gen };
      return gen;
    },
    progress,
  };
}
