import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium, type Browser, type BrowserContext, type Page } from 'patchright';
import type { Config } from '../config.js';
import type { BrowserStatus, CheckpointInfo, Logger, PacingSettings } from '../types.js';
import { BrowserNotConnectedError, CheckpointError, NotLoggedInError, errorMessage } from '../errors.js';
import { firstVisible } from '../linkedin/dom.js';
import { SEL } from '../linkedin/selectors.js';
import { URLS } from '../linkedin/urls.js';
import { NetworkCapture } from './capture.js';
import { BLOCKER_URL, detectCheckpoint } from './checkpoint.js';
import { Humanizer, sleep } from './humanize.js';

export interface SessionDeps {
  cfg: Config;
  log: Logger;
  getPacing: () => PacingSettings;
}

const LINKEDIN_HOST = /^https?:\/\/(www\.)?linkedin\.com\//i;

/** Pure decision behind isLoggedIn (unit-tested). */
export function decideLoggedIn(input: { url: string; hasLiAt: boolean; navVisible: boolean }): boolean {
  if (!LINKEDIN_HOST.test(input.url)) return false;
  if (BLOCKER_URL.test(input.url)) return false;
  return input.navVisible || input.hasLiAt;
}

/**
 * Chrome preferences we need in the dedicated profile, written while Chrome is not running (what chromedriver does):
 *  - PDFs stay in Chrome's viewer and never turn into downloads. Earlier versions forced the opposite so that a
 *    resume link opening a signed URL would produce a Playwright download event; Chrome 154 then crashed its
 *    browser process every time such a download started. Resume bytes are now read at the network layer by
 *    ResumeTrap in src/linkedin/application.ts, so nothing may ever reach the download manager;
 *  - no download prompt; no "restore pages?" bubble after an unclean exit.
 * Idempotent: only rewrites the file when something changed. Applies to persistent mode; in cdp mode the profile
 * belongs to the Chrome the user launched (scripts/launch-chrome.sh points it at the same directory).
 */
/**
 * Chromium 152 to 154 crash their browser process when a download starts over the DevTools pipe in a profile that
 * already holds persisted download history (microsoft/playwright#42506, MicrosoftEdge/DevTools#461). A denied
 * download still creates the download item, so the only safe profile is one without download rows. Run while
 * Chrome is not running. Returns the number of rows removed, or undefined when the History database was not
 * available (locked by a running Chrome, or not created yet).
 */
export function clearDownloadHistory(profileDir: string, log?: Logger): number | undefined {
  const historyFile = path.join(profileDir, 'Default', 'History');
  if (!fs.existsSync(historyFile)) return undefined;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(historyFile);
    db.exec('PRAGMA busy_timeout = 1500');
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('downloads', 'downloads_url_chains', 'downloads_slices')").all() as Array<{ name: string }>).map((r) => r.name));
    let removed = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const t of ['downloads_slices', 'downloads_url_chains', 'downloads']) if (tables.has(t)) removed += Number(db.prepare(`DELETE FROM ${t}`).run().changes);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    if (removed) log?.info('cleared Chrome download history from the profile (Chromium 152-154 download crash workaround)', { rows: removed });
    return removed;
  } catch (e) {
    log?.warn('could not clear Chrome download history (is Chrome still running on this profile?)', { error: errorMessage(e) });
    return undefined;
  } finally {
    db?.close();
  }
}

/** "MacBook-Pro.local-50715" → 50715: the pid Chrome wrote into the SingletonLock symlink target. */
export function parseSingletonLockPid(target: string): number | undefined {
  const m = /-(\d+)$/.exec(target.trim());
  const pid = m ? Number(m[1]) : NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** The live process that holds this profile's SingletonLock, if any (a stale lock from a crash is ignored). */
export function profileLockHolder(profileDir: string): number | undefined {
  try {
    const pid = parseSingletonLockPid(fs.readlinkSync(path.join(profileDir, 'SingletonLock')));
    if (!pid || pid === process.pid) return undefined;
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

export function ensureChromePreferences(profileDir: string, downloadsPath: string, log?: Logger): void {
  try {
    const defDir = path.join(profileDir, 'Default');
    fs.mkdirSync(defDir, { recursive: true });
    const prefFile = path.join(defDir, 'Preferences');
    let prefs: Record<string, unknown> = {};
    if (fs.existsSync(prefFile)) {
      try {
        prefs = JSON.parse(fs.readFileSync(prefFile, 'utf8')) as Record<string, unknown>;
      } catch {
        prefs = {};
      }
    }
    const before = JSON.stringify(prefs);
    const plugins = (prefs.plugins as Record<string, unknown> | undefined) ?? {};
    // Let PDFs open in Chrome's viewer instead of turning into downloads; resume files are read at the network layer.
    plugins.always_open_pdf_externally = false;
    prefs.plugins = plugins;
    const download = (prefs.download as Record<string, unknown> | undefined) ?? {};
    download.prompt_for_download = false;
    download.directory_upgrade = true;
    download.default_directory = downloadsPath;
    prefs.download = download;
    const profile = (prefs.profile as Record<string, unknown> | undefined) ?? {};
    profile.exit_type = 'Normal';
    profile.exited_cleanly = true;
    prefs.profile = profile;
    if (JSON.stringify(prefs) !== before) fs.writeFileSync(prefFile, JSON.stringify(prefs), 'utf8');
    const firstRun = path.join(profileDir, 'First Run');
    if (!fs.existsSync(firstRun)) fs.writeFileSync(firstRun, '', 'utf8');
  } catch (e) {
    log?.warn('could not write Chrome preferences', { error: errorMessage(e) });
  }
}

/**
 * Owns the browser: launches the user's installed Google Chrome with a dedicated persistent profile
 * (mode 'persistent') or attaches to a Chrome the user started with --remote-debugging-port (mode 'cdp').
 * One LinkedIn tab is used for scraping; it is created lazily and reused. Always headed, never a UA override.
 */
export class BrowserSession {
  readonly human: Humanizer;
  readonly capture: NetworkCapture;
  private browser: Browser | undefined; // cdp mode only
  private context: BrowserContext | undefined;
  private closing = false;
  private page: Page | undefined;
  private connecting: Promise<Page> | undefined;

  constructor(protected readonly deps: SessionDeps) {
    this.human = new Humanizer(deps.getPacing, Math.random, deps.log.child({ mod: 'human' }));
    this.capture = new NetworkCapture(deps.log.child({ mod: 'capture' }), {
      rawDir: deps.cfg.captureRaw ? path.join(deps.cfg.debugDir, 'raw') : undefined,
    });
  }

  isConnected(): boolean {
    return !!this.context;
  }

  /** Connect/launch if needed and return the working LinkedIn tab. Concurrent callers share one connect. */
  async ensure(): Promise<Page> {
    if (this.connecting) return this.connecting;
    this.connecting = this.ensureInner().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async ensureInner(): Promise<Page> {
    if (!this.context) await this.connect();
    const ctx = this.context!;
    if (!this.page || this.page.isClosed()) {
      const open = ctx.pages().filter((p) => !p.isClosed());
      const existing = open.find((p) => LINKEDIN_HOST.test(p.url())) ?? open.find((p) => p.url() === 'about:blank');
      this.page = existing ?? (await ctx.newPage());
      this.page.setDefaultTimeout(30_000);
      this.page.setDefaultNavigationTimeout(60_000);
      this.capture.attach(this.page);
      const page = this.page;
      page.once('close', () => {
        if (this.page === page) this.page = undefined;
      });
    }
    return this.page;
  }

  private async connect(): Promise<void> {
    const { cfg, log } = this.deps;
    if (cfg.browserMode === 'cdp') {
      log.info('connecting to Chrome over CDP', { cdpUrl: cfg.cdpUrl });
      let browser: Browser;
      try {
        browser = await chromium.connectOverCDP(cfg.cdpUrl, { timeout: 15_000 });
      } catch (e) {
        throw new BrowserNotConnectedError(
          `Could not connect to Chrome at ${cfg.cdpUrl}. Start it with scripts/launch-chrome.sh (Chrome 136+ only allows remote debugging with a non-default --user-data-dir). ${errorMessage(e)}`,
        );
      }
      this.browser = browser;
      this.context = browser.contexts()[0] ?? (await browser.newContext({ acceptDownloads: false }));
      // The attached default context keeps Chrome's own download settings; deny downloads at the browser level so
      // an automation-triggered download can never start (Chrome 154 crashes on them).
      try {
        const cdp = await browser.newBrowserCDPSession();
        await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
      } catch (e) {
        log.warn('could not deny downloads in the attached Chrome; resume files are still read from the network', { error: errorMessage(e) });
      }
      browser.once('disconnected', () => this.onContextGone('cdp disconnected'));
      this.context.once('close', () => this.onContextGone('context closed'));
      return;
    }

    fs.mkdirSync(cfg.profileDir, { recursive: true });
    // Two Chromes on one profile close each other (and Chrome kills an unresponsive holder after 20 s): refuse.
    const holder = profileLockHolder(cfg.profileDir);
    if (holder) {
      throw new BrowserNotConnectedError(
        `Chrome (pid ${holder}) is already running on profile ${cfg.profileDir}. Another worker or debug session owns it; stop that process first (Ctrl-C on "npm run worker", or browser_close in the client that runs the queue).`,
      );
    }
    const downloadsPath = path.join(cfg.dataDir, 'downloads');
    fs.mkdirSync(downloadsPath, { recursive: true });
    ensureChromePreferences(cfg.profileDir, downloadsPath, log);
    clearDownloadHistory(cfg.profileDir, log);
    log.info('launching Chrome with persistent profile', { channel: cfg.chromeChannel, profileDir: cfg.profileDir });
    try {
      this.context = await chromium.launchPersistentContext(cfg.profileDir, {
        channel: cfg.chromeChannel,
        headless: false, // never headless: a visible window is part of looking like a person
        viewport: null, // use the real window size
        // Chrome 154 crashed its browser process whenever an automation-triggered download started, so downloads
        // are denied here and resume files are read from the network response instead (see ResumeTrap).
        acceptDownloads: false,
        // Playwright passes --no-sandbox unless the sandbox is explicitly enabled; Chrome then shows a yellow
        // "unsupported command-line flag" bar. Keep the real sandbox on: normal Chrome, no warning bar.
        chromiumSandbox: true,
        // Playwright >= 1.60 no longer passes --enable-automation; what matters is AutomationControlled
        // (patchright adds it too). Keep the flag set small and identical across runs so the profile's
        // cookie encryption stays stable.
        args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
        timeout: 90_000,
      });
    } catch (e) {
      const msg = errorMessage(e);
      throw new BrowserNotConnectedError(
        `Could not launch ${cfg.chromeChannel} with profile ${cfg.profileDir}. If a Chrome window is already using this profile, close it first (or set LINKEDIN_MCP_BROWSER_MODE=cdp and use scripts/launch-chrome.sh). Original error: ${msg}`,
      );
    }
    this.context.once('close', () => this.onContextGone('context closed'));
  }

  private onContextGone(how: string): void {
    if (!this.closing) this.deps.log.warn('Chrome went away unexpectedly (crash or closed by hand); it will be relaunched on demand', { how });
    this.reset();
  }

  private reset(): void {
    this.context = undefined;
    this.page = undefined;
    this.browser = undefined;
  }

  private async loggedInSignals(page: Page): Promise<{ url: string; hasLiAt: boolean; navVisible: boolean }> {
    const url = page.url();
    const cookies = await page.context().cookies('https://www.linkedin.com').catch(() => []);
    const hasLiAt = cookies.some((c) => c.name === 'li_at');
    const nav = LINKEDIN_HOST.test(url) ? await firstVisible(page, [...SEL.legacy.loggedIn, ...SEL.sdui.loggedIn], { timeoutMs: 1500 }) : null;
    return { url, hasLiAt, navVisible: !!nav };
  }

  /** Navigates to the feed if the tab is not on LinkedIn yet, then decides from URL + nav + li_at cookie. */
  async isLoggedIn(page?: Page): Promise<boolean> {
    const p = page ?? (await this.ensure());
    if (!LINKEDIN_HOST.test(p.url())) await this.human.goto(p, URLS.feed, { settle: false });
    return decideLoggedIn(await this.loggedInSignals(p));
  }

  async detectCheckpoint(page?: Page): Promise<CheckpointInfo | null> {
    const p = page ?? this.page;
    if (!p || p.isClosed()) return null;
    const url = p.url();
    let text: string | undefined;
    if (LINKEDIN_HOST.test(url)) {
      text = await p.evaluate(() => (document.body?.innerText ?? '').slice(0, 5000)).catch(() => undefined);
    }
    return detectCheckpoint(url, text);
  }

  /** Throws CheckpointError / NotLoggedInError when LinkedIn wants a human. Call after every navigation. */
  async assertHealthy(page?: Page): Promise<void> {
    const p = page ?? this.page;
    if (!p || p.isClosed()) throw new BrowserNotConnectedError();
    const cp = await this.detectCheckpoint(p);
    if (!cp) return;
    if (cp.kind === 'login') throw new NotLoggedInError(`LinkedIn redirected to ${cp.url}. Sign in via the browser_open_login tool, then queue_resume.`);
    throw new CheckpointError(cp);
  }

  /** Never launches the browser just to answer. */
  async status(): Promise<BrowserStatus> {
    const { cfg } = this.deps;
    const base = { mode: cfg.browserMode, profileDir: cfg.profileDir, cdpUrl: cfg.browserMode === 'cdp' ? cfg.cdpUrl : undefined };
    if (!this.context || !this.page || this.page.isClosed()) return { ...base, connected: !!this.context, loggedIn: null };
    const url = this.page.url();
    const checkpoint = await this.detectCheckpoint(this.page);
    const loggedIn = LINKEDIN_HOST.test(url) ? decideLoggedIn(await this.loggedInSignals(this.page)) : null;
    return { ...base, connected: true, loggedIn, currentUrl: url, checkpoint };
  }

  /**
   * Opens the login page in the visible window and waits for the human to sign in. Nothing is typed
   * on their behalf. Returns the status when logged in or when the timeout elapses.
   */
  async openLogin(timeoutMs = 180_000): Promise<BrowserStatus> {
    const page = await this.ensure();
    if (await this.isLoggedIn(page)) return this.status();
    await this.human.goto(page, URLS.login, { settle: false });
    await page.bringToFront().catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(3000);
      if (page.isClosed()) break;
      if (decideLoggedIn(await this.loggedInSignals(page))) break;
    }
    return this.status();
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      if (this.deps.cfg.browserMode === 'cdp') {
        // Playwright: for a browser obtained via connectOverCDP, close() "clears all created contexts belonging to this
        // browser and disconnects from the browser server", it does NOT terminate the user's Chrome process.
        await this.browser?.close().catch(() => {});
      } else {
        await this.context?.close().catch(() => {});
      }
    } finally {
      this.reset();
      this.closing = false;
    }
  }
}
