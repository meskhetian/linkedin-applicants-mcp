import fs from 'node:fs';
import path from 'node:path';
import type { Page, Response } from 'patchright';
import type { Logger } from '../types.js';
import { CAPTURE_URL_HINTS } from '../linkedin/selectors.js';

export type CapturedKind = 'voyager-rest' | 'voyager-graphql' | 'rsc' | 'document' | 'other';

export interface CapturedResponse {
  seq: number;
  url: string;
  method: string;
  status: number;
  contentType: string;
  kind: CapturedKind;
  capturedAt: string;
  /** Request headers worth replaying (x-li-track, x-li-page-instance, csrf-token are stored; cookies never) */
  requestHeaders: Record<string, string>;
  /** Body text (truncated to maxBodyBytes) */
  body: string;
  truncated: boolean;
  /** Parsed JSON when content type is JSON and parse succeeded */
  json?: unknown;
}

const TYPES = ['application/vnd.linkedin.normalized+json', 'application/json', 'text/x-component', 'text/html', 'application/graphql'];
const KEEP_REQ_HEADERS = ['x-li-track', 'x-li-page-instance', 'x-li-lang', 'x-restli-protocol-version', 'accept', 'csrf-token', 'x-li-pem-metadata', 'x-li-graphql-pegasus-client'];

export interface CaptureOptions {
  maxEntries?: number;
  maxBodyBytes?: number;
  /**
   * Budget for all kept bodies together (approximate bytes; a parsed JSON copy counts as much again). The capture lives
   * as long as the browser session, often days: without a budget 400 entries of up to 4 MB each kept gigabytes in the
   * worker and every task slowed down as garbage collection struggled. Oldest entries go first.
   */
  maxTotalBytes?: number;
  /** Persist every captured body to <rawDir>/<date>/<seq>-<kind>.json|txt */
  rawDir?: string;
  /** Extra URL substrings to capture */
  extraHints?: string[];
}

/**
 * Passive network capture: records the JSON / RSC bodies LinkedIn's own web app fetches while we
 * navigate like a human. Zero extra requests, and structured data that no innerText parser gives us.
 * Install BEFORE navigation. Bodies are read asynchronously with a bounded drain so a stuck body()
 * never blocks the scraper.
 */
export class NetworkCapture {
  private entries: CapturedResponse[] = [];
  private pending = new Set<Promise<void>>();
  private seq = 0;
  private totalBytes = 0;
  private readonly maxTotalBytes: number;
  private handlers = new WeakMap<Page, (r: Response) => void>();
  private lastVoyagerHeaders: Record<string, string> = {};
  private readonly maxEntries: number;
  private readonly maxBodyBytes: number;
  private readonly hints: string[];

  constructor(
    private readonly log: Logger,
    private readonly opts: CaptureOptions = {},
  ) {
    this.maxEntries = opts.maxEntries ?? 400;
    this.maxBodyBytes = opts.maxBodyBytes ?? 4 * 1024 * 1024;
    this.maxTotalBytes = opts.maxTotalBytes ?? 96 * 1024 * 1024;
    this.hints = [...CAPTURE_URL_HINTS, ...(opts.extraHints ?? [])];
  }

  attach(page: Page): void {
    if (this.handlers.has(page)) return;
    const handler = (res: Response) => {
      try {
        this.onResponse(res);
      } catch (e) {
        this.log.debug('capture handler error', { error: String(e) });
      }
    };
    page.on('response', handler);
    this.handlers.set(page, handler);
    page.once('close', () => this.detach(page));
  }

  detach(page: Page): void {
    const h = this.handlers.get(page);
    if (h) {
      page.off('response', h);
      this.handlers.delete(page);
    }
  }

  private onResponse(res: Response): void {
    const url = res.url();
    if (!/^https:\/\/(www\.)?linkedin\.com\//i.test(url)) return;
    const ct = (res.headers()['content-type'] ?? '').toLowerCase();
    if (!TYPES.some((t) => ct.startsWith(t))) return;
    if (!this.hints.some((h) => url.includes(h))) return;
    const req = res.request();
    const kind: CapturedKind = url.includes('/voyager/api/graphql')
      ? 'voyager-graphql'
      : url.includes('/voyager/api/')
        ? 'voyager-rest'
        : url.includes('/flagship-web/rsc-action/') || ct.startsWith('text/x-component')
          ? 'rsc'
          : ct.startsWith('text/html')
            ? 'document'
            : 'other';
    const reqHeaders: Record<string, string> = {};
    const all = req.headers();
    for (const k of KEEP_REQ_HEADERS) if (all[k]) reqHeaders[k] = all[k];
    if (kind.startsWith('voyager') && Object.keys(reqHeaders).length) this.lastVoyagerHeaders = { ...this.lastVoyagerHeaders, ...reqHeaders };

    const p = res
      .body()
      .then((buf) => {
        const truncated = buf.length > this.maxBodyBytes;
        const body = (truncated ? buf.subarray(0, this.maxBodyBytes) : buf).toString('utf8');
        const entry: CapturedResponse = {
          seq: ++this.seq,
          url,
          method: req.method(),
          status: res.status(),
          contentType: ct,
          kind,
          capturedAt: new Date().toISOString(),
          requestHeaders: reqHeaders,
          body,
          truncated,
        };
        if (!truncated && ct.includes('json')) {
          try {
            entry.json = JSON.parse(body);
          } catch {
            /* leave undefined */
          }
        }
        this.push(entry);
        if (this.opts.rawDir) this.persist(entry);
      })
      .catch(() => {})
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  private persist(e: CapturedResponse): void {
    try {
      const dir = path.join(this.opts.rawDir!, e.capturedAt.slice(0, 10));
      fs.mkdirSync(dir, { recursive: true });
      const ext = e.json ? 'json' : 'txt';
      const file = path.join(dir, `${String(e.seq).padStart(5, '0')}-${e.kind}.${ext}`);
      const header = `# ${e.method} ${e.url}\n# ${e.status} ${e.contentType}\n# req: ${JSON.stringify(e.requestHeaders)}\n`;
      fs.writeFileSync(file, e.json ? JSON.stringify(e.json, null, 1) : header + e.body, 'utf8');
    } catch (err) {
      this.log.debug('capture persist failed', { error: String(err) });
    }
  }

  private static cost(e: CapturedResponse): number {
    return e.body.length * (e.json === undefined ? 1 : 2);
  }

  /** Keep an entry, then drop the oldest ones until both the entry limit and the byte budget hold (the newest stays). */
  private push(entry: CapturedResponse): void {
    this.entries.push(entry);
    this.totalBytes += NetworkCapture.cost(entry);
    let drop = 0;
    let bytes = this.totalBytes;
    while (this.entries.length - drop > 1 && (this.entries.length - drop > this.maxEntries || bytes > this.maxTotalBytes)) {
      bytes -= NetworkCapture.cost(this.entries[drop]!);
      drop++;
    }
    if (drop) {
      this.entries.splice(0, drop);
      this.totalBytes = bytes;
    }
  }

  /** How much the capture holds right now (for logs and tests). */
  stats(): { entries: number; bytes: number } {
    return { entries: this.entries.length, bytes: this.totalBytes };
  }

  /** Wait (bounded) for in-flight bodies to finish. Call after navigation settles, before parsing. */
  async drain(ms = 2500): Promise<void> {
    if (!this.pending.size) return;
    await Promise.race([Promise.allSettled([...this.pending]), new Promise((r) => setTimeout(r, ms))]);
  }

  all(): CapturedResponse[] {
    return [...this.entries];
  }

  /** Entries captured after a given seq (use `mark()` before navigation). */
  since(seq: number): CapturedResponse[] {
    return this.entries.filter((e) => e.seq > seq);
  }

  mark(): number {
    return this.seq;
  }

  find(pred: (e: CapturedResponse) => boolean, sinceSeq = 0): CapturedResponse | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.seq <= sinceSeq) break;
      if (pred(e)) return e;
    }
    return undefined;
  }

  findAll(pred: (e: CapturedResponse) => boolean, sinceSeq = 0): CapturedResponse[] {
    return this.entries.filter((e) => e.seq > sinceSeq && pred(e));
  }

  /** Resolve when a matching response has been captured, or null on timeout. */
  async waitFor(pred: (e: CapturedResponse) => boolean, timeoutMs = 8000, sinceSeq = 0): Promise<CapturedResponse | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.drain(300);
      const hit = this.find(pred, sinceSeq);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  }

  /** Headers copied from LinkedIn's own Voyager calls (x-li-track, x-li-page-instance, ...). */
  voyagerHeaders(): Record<string, string> {
    return { ...this.lastVoyagerHeaders };
  }

  clear(): void {
    this.entries = [];
    this.totalBytes = 0;
  }

  /** Write all current entries to a directory (for debug_snapshot). Returns the directory. */
  dump(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const index = this.entries.map((e) => ({ seq: e.seq, url: e.url, method: e.method, status: e.status, contentType: e.contentType, kind: e.kind, capturedAt: e.capturedAt, truncated: e.truncated }));
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 2));
    for (const e of this.entries) {
      const ext = e.json ? 'json' : 'txt';
      fs.writeFileSync(path.join(dir, `${String(e.seq).padStart(5, '0')}-${e.kind}.${ext}`), e.json ? JSON.stringify(e.json, null, 1) : `# ${e.method} ${e.url}\n# ${e.status} ${e.contentType}\n${e.body}`);
    }
    return dir;
  }
}
