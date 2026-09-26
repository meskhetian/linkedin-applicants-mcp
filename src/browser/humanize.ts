import type { Locator, Page } from 'patchright';
import type { DelayKind, DelaySpec, Logger, PacingSettings } from '../types.js';

export type Rng = () => number;

/** Standard normal via Box-Muller. */
export function randn(rng: Rng = Math.random): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function randInt(min: number, max: number, rng: Rng = Math.random): number {
  return Math.floor(min + rng() * (max - min + 1));
}

export function randFloat(min: number, max: number, rng: Rng = Math.random): number {
  return min + rng() * (max - min);
}

/**
 * Sample a delay from a clipped log-normal whose median is `medianMs` and whose
 * ~95% interval spans [minMs, maxMs]. Humans have long right tails; this does too.
 */
export function sampleLogNormal(spec: DelaySpec, rng: Rng = Math.random): number {
  const min = Math.max(1, spec.minMs);
  const max = Math.max(min + 1, spec.maxMs);
  const median = Math.min(Math.max(spec.medianMs, min), max);
  const mu = Math.log(median);
  const sigma = Math.max(0.05, (Math.log(max) - Math.log(min)) / 4);
  const x = Math.exp(mu + sigma * randn(rng));
  return Math.round(Math.min(max, Math.max(min, x)));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface Point {
  x: number;
  y: number;
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Points along a cubic Bezier from p0 to p3 with random perpendicular control offsets. */
export function bezierPath(p0: Point, p3: Point, steps: number, rng: Rng = Math.random): Point[] {
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = -dy / dist;
  const ny = dx / dist;
  const spread = Math.min(120, dist * 0.35);
  const c1: Point = {
    x: p0.x + dx * randFloat(0.2, 0.4, rng) + nx * randFloat(-spread, spread, rng),
    y: p0.y + dy * randFloat(0.2, 0.4, rng) + ny * randFloat(-spread, spread, rng),
  };
  const c2: Point = {
    x: p0.x + dx * randFloat(0.6, 0.85, rng) + nx * randFloat(-spread, spread, rng),
    y: p0.y + dy * randFloat(0.6, 0.85, rng) + ny * randFloat(-spread, spread, rng),
  };
  const pts: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = easeInOutQuad(i / steps);
    const mt = 1 - t;
    const x = mt ** 3 * p0.x + 3 * mt ** 2 * t * c1.x + 3 * mt * t ** 2 * c2.x + t ** 3 * p3.x;
    const y = mt ** 3 * p0.y + 3 * mt ** 2 * t * c1.y + 3 * mt * t ** 2 * c2.y + t ** 3 * p3.y;
    // tiny hand tremor
    pts.push({ x: x + randFloat(-0.8, 0.8, rng), y: y + randFloat(-0.8, 0.8, rng) });
  }
  pts[pts.length - 1] = p3;
  return pts;
}

export interface ScrollPageOptions {
  /** Stop when this returns true (checked after each chunk). */
  until?: () => Promise<boolean>;
  maxScrolls?: number;
  /** Fraction of scrolls that briefly reverse direction (looks like re-reading). Default 0.1 */
  backtrackProbability?: number;
}

/**
 * Human-like input on top of Playwright: log-normal pauses, Bezier mouse paths,
 * chunked wheel scrolling, variable-speed typing, idle fidgeting.
 */
export class Humanizer {
  private cursors = new WeakMap<Page, Point>();

  constructor(
    private readonly getPacing: () => PacingSettings,
    private readonly rng: Rng = Math.random,
    private readonly log?: Logger,
  ) {}

  delayMs(kind: DelayKind): number {
    return sampleLogNormal(this.getPacing().delays[kind], this.rng);
  }

  async pause(kind: DelayKind, signal?: AbortSignal): Promise<number> {
    const ms = this.delayMs(kind);
    this.log?.debug('pause', { kind, ms });
    await sleep(ms, signal);
    return ms;
  }

  async pauseMs(minMs: number, maxMs: number, signal?: AbortSignal): Promise<void> {
    await sleep(randInt(minMs, maxMs, this.rng), signal);
  }

  private async viewport(page: Page): Promise<{ w: number; h: number }> {
    const vs = page.viewportSize();
    if (vs) return { w: vs.width, h: vs.height };
    try {
      return await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    } catch {
      return { w: 1280, h: 800 };
    }
  }

  private cursor(page: Page, vp: { w: number; h: number }): Point {
    let c = this.cursors.get(page);
    if (!c) {
      c = { x: randFloat(vp.w * 0.3, vp.w * 0.7, this.rng), y: randFloat(vp.h * 0.3, vp.h * 0.7, this.rng) };
      this.cursors.set(page, c);
    }
    return c;
  }

  /** Move the mouse along a curved path to (x, y). */
  async moveTo(page: Page, x: number, y: number): Promise<void> {
    const vp = await this.viewport(page);
    const from = this.cursor(page, vp);
    const to: Point = { x: Math.max(1, Math.min(vp.w - 1, x)), y: Math.max(1, Math.min(vp.h - 1, y)) };
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist < 2) return;
    const steps = Math.max(8, Math.min(60, Math.round(dist / 12) + randInt(0, 6, this.rng)));
    // Occasionally overshoot a little and come back.
    const overshoot = dist > 200 && this.rng() < 0.18;
    const target = overshoot
      ? { x: to.x + randFloat(-18, 18, this.rng), y: to.y + randFloat(-14, 14, this.rng) }
      : to;
    for (const p of bezierPath(from, target, steps, this.rng)) {
      await page.mouse.move(p.x, p.y);
      await sleep(randInt(4, 16, this.rng));
    }
    if (overshoot) {
      await sleep(randInt(40, 120, this.rng));
      for (const p of bezierPath(target, to, randInt(4, 8, this.rng), this.rng)) {
        await page.mouse.move(p.x, p.y);
        await sleep(randInt(6, 18, this.rng));
      }
    }
    this.cursors.set(page, to);
  }

  /** Pick a natural click point inside the element (gaussian around center, avoiding edges). */
  private async targetPoint(locator: Locator): Promise<Point | null> {
    const box = await locator.boundingBox();
    if (!box || box.width < 1 || box.height < 1) return null;
    const gx = Math.max(-0.42, Math.min(0.42, randn(this.rng) * 0.18));
    const gy = Math.max(-0.42, Math.min(0.42, randn(this.rng) * 0.18));
    return { x: box.x + box.width * (0.5 + gx), y: box.y + box.height * (0.5 + gy) };
  }

  async hover(page: Page, locator: Locator): Promise<void> {
    await this.scrollToLocator(page, locator);
    const p = await this.targetPoint(locator);
    if (!p) throw new Error('hover: element has no bounding box');
    await this.moveTo(page, p.x, p.y);
  }

  /** Scroll into view (if needed), move there on a curve, press, hold, release. */
  async click(page: Page, locator: Locator, opts: { button?: 'left' | 'right' | 'middle'; noScroll?: boolean } = {}): Promise<void> {
    if (!opts.noScroll) await this.scrollToLocator(page, locator);
    let p = await this.targetPoint(locator);
    const vp = await this.viewport(page);
    if (p && (p.x < 0 || p.y < 0 || p.x > vp.w || p.y > vp.h)) {
      // Still outside the viewport (nested scroll pane): let Playwright scroll it, then re-measure.
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(randInt(200, 500, this.rng));
      p = await this.targetPoint(locator);
    }
    if (!p || p.x < 0 || p.y < 0 || p.x > vp.w || p.y > vp.h) {
      // Fallback: element not visible/in layout, let Playwright do it, still with a delay.
      await locator.click({ delay: randInt(40, 130, this.rng), button: opts.button });
      return;
    }
    await this.moveTo(page, p.x, p.y);
    await sleep(randInt(60, 220, this.rng));
    await page.mouse.down({ button: opts.button });
    await sleep(randInt(45, 140, this.rng));
    await page.mouse.up({ button: opts.button });
  }

  /** Scroll by deltaY pixels in uneven wheel ticks with micro pauses. */
  async scrollBy(page: Page, deltaY: number): Promise<void> {
    const dir = Math.sign(deltaY) || 1;
    let remaining = Math.abs(deltaY);
    const vp = await this.viewport(page);
    const c = this.cursor(page, vp);
    // Wheel events originate where the cursor is; nudge it into the content area if it is off in a margin.
    if (c.x < vp.w * 0.15 || c.x > vp.w * 0.85) await this.moveTo(page, randFloat(vp.w * 0.3, vp.w * 0.7, this.rng), c.y);
    while (remaining > 0) {
      const chunk = Math.min(remaining, randInt(70, 260, this.rng));
      await page.mouse.wheel(0, dir * chunk);
      remaining -= chunk;
      await sleep(randInt(25, 110, this.rng));
    }
  }

  /**
   * Bring the element into the comfortable middle band of the viewport by scrolling like a human.
   * If wheel scrolling does not move the element (it lives in a nested scroll pane, e.g. LinkedIn's
   * applicant list), fall back to Playwright's scrollIntoViewIfNeeded, which scrolls the right container.
   */
  async scrollToLocator(page: Page, locator: Locator, maxIterations = 30): Promise<void> {
    const vp = await this.viewport(page);
    let lastY: number | undefined;
    let unmoved = 0;
    for (let i = 0; i < maxIterations; i++) {
      const box = await locator.boundingBox().catch(() => null);
      if (!box) {
        // Not laid out yet (virtualized list or hidden). Try a native scrollIntoView as a last resort.
        if (i >= 2) {
          await locator.scrollIntoViewIfNeeded().catch(() => {});
          await sleep(randInt(200, 500, this.rng));
          return;
        }
        await this.scrollBy(page, randInt(300, 700, this.rng));
        await sleep(randInt(120, 350, this.rng));
        continue;
      }
      const centerY = box.y + box.height / 2;
      const top = vp.h * 0.18;
      const bottom = vp.h * 0.82;
      if (centerY >= top && centerY <= bottom) return;
      if (lastY !== undefined && Math.abs(centerY - lastY) < 2) {
        unmoved++;
        if (unmoved >= 2) {
          // Window scrolling is not moving it: nested scroll container.
          await locator.scrollIntoViewIfNeeded().catch(() => {});
          await sleep(randInt(250, 600, this.rng));
          return;
        }
      } else unmoved = 0;
      lastY = centerY;
      const diff = centerY < top ? centerY - vp.h * randFloat(0.3, 0.5, this.rng) : centerY - vp.h * randFloat(0.5, 0.7, this.rng);
      await this.scrollBy(page, Math.max(-900, Math.min(900, diff)));
      await sleep(randInt(80, 260, this.rng));
    }
    await locator.scrollIntoViewIfNeeded().catch(() => {});
  }

  /** Scroll down through a page the way someone skims it. */
  async scrollPage(page: Page, opts: ScrollPageOptions = {}): Promise<number> {
    const max = opts.maxScrolls ?? 25;
    const back = opts.backtrackProbability ?? 0.1;
    let scrolls = 0;
    for (; scrolls < max; scrolls++) {
      const before = await page.evaluate(() => window.scrollY).catch(() => 0);
      await this.scrollBy(page, randInt(250, 750, this.rng));
      await sleep(randInt(300, 1400, this.rng));
      if (this.rng() < back) {
        await this.scrollBy(page, -randInt(80, 260, this.rng));
        await sleep(randInt(300, 900, this.rng));
      }
      if (opts.until && (await opts.until())) break;
      const after = await page.evaluate(() => window.scrollY).catch(() => 0);
      if (after <= before) break; // reached bottom
    }
    return scrolls;
  }

  /** Click into the field, then type with variable per-key delay and occasional thinking pauses. */
  async type(page: Page, locator: Locator, text: string, opts: { clear?: boolean } = {}): Promise<void> {
    await this.click(page, locator);
    await sleep(randInt(120, 400, this.rng));
    if (opts.clear) {
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await sleep(randInt(40, 120, this.rng));
      await page.keyboard.press('Backspace');
      await sleep(randInt(80, 200, this.rng));
    }
    for (const ch of text) {
      await page.keyboard.type(ch, { delay: 0 });
      let d = sampleLogNormal({ minMs: 40, medianMs: 95, maxMs: 260 }, this.rng);
      if (/[\s.,;:!?]/.test(ch) && this.rng() < 0.35) d += randInt(120, 450, this.rng);
      await sleep(d);
    }
  }

  /** Small aimless movements / a tiny scroll, what a person does while a page loads or while thinking. */
  async idle(page: Page, totalMs?: number): Promise<void> {
    const budget = totalMs ?? randInt(800, 3000, this.rng);
    const start = Date.now();
    const vp = await this.viewport(page);
    while (Date.now() - start < budget) {
      const c = this.cursor(page, vp);
      const r = this.rng();
      if (r < 0.55) {
        await this.moveTo(page, c.x + randFloat(-140, 140, this.rng), c.y + randFloat(-90, 90, this.rng));
      } else if (r < 0.75) {
        await this.scrollBy(page, randInt(-120, 160, this.rng));
      }
      await sleep(randInt(250, 900, this.rng));
    }
  }

  /** Navigate and settle like a person would: load, glance, small scroll. */
  async goto(page: Page, url: string, opts: { waitUntil?: 'domcontentloaded' | 'load' | 'networkidle'; settle?: boolean } = {}): Promise<void> {
    await page.goto(url, { waitUntil: opts.waitUntil ?? 'domcontentloaded', timeout: 60_000 });
    await this.pause('short');
    if (opts.settle !== false) {
      if (this.rng() < 0.6) await this.scrollBy(page, randInt(80, 320, this.rng));
      await sleep(randInt(200, 900, this.rng));
    }
  }
}
