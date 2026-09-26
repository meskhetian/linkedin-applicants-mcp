import fs from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { isLinkedInUrl } from '../linkedin/urls.js';
import { mainText } from '../linkedin/dom.js';
import { safeName } from '../storage/files.js';
import { clip, fail, guard, ok } from './result.js';

/**
 * Debug tools for when LinkedIn changes its markup: inspect the live tab, dump what the page fetched,
 * and try selectors. They operate on the same single tab the worker uses, pause the queue first.
 */
export function registerDebugTools(server: McpServer, deps: Deps): void {
  const { session, cfg } = deps;

  server.registerTool(
    'debug_snapshot',
    {
      title: 'Snapshot the current page',
      description: 'Save a full-page screenshot, the HTML, the visible text and all captured network payloads of the current tab into the debug directory. Use when a task fails with "Could not find …" so selectors can be updated.',
      inputSchema: { name: z.string().optional().describe('Label for the snapshot folder') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ name }) => {
      const page = await session.ensure();
      const dir = path.join(cfg.debugDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeName(name ?? 'snapshot')}`);
      fs.mkdirSync(dir, { recursive: true });
      const out: Record<string, string> = { dir, url: page.url() };
      try {
        await page.screenshot({ path: path.join(dir, 'page.png'), fullPage: true, timeout: 20_000 });
        out.screenshot = path.join(dir, 'page.png');
      } catch (e) {
        out.screenshotError = String(e);
      }
      fs.writeFileSync(path.join(dir, 'page.html'), await page.content().catch(() => ''), 'utf8');
      fs.writeFileSync(path.join(dir, 'page.txt'), await mainText(page), 'utf8');
      out.html = path.join(dir, 'page.html');
      out.text = path.join(dir, 'page.txt');
      out.captures = session.capture.dump(path.join(dir, 'captures'));
      return ok(out);
    }),
  );

  server.registerTool(
    'debug_navigate',
    {
      title: 'Navigate the tab (LinkedIn only)',
      description: 'Navigate the working tab to a linkedin.com URL the human way (paced), then report the final URL, title and checkpoint state. Pause the queue first so you do not fight the worker for the tab.',
      inputSchema: { url: z.string().url() },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(async ({ url }) => {
      if (!isLinkedInUrl(url)) return fail(new Error('Only linkedin.com URLs are allowed'));
      const page = await session.ensure();
      await session.human.goto(page, url);
      const checkpoint = await session.detectCheckpoint(page);
      return ok({ url: page.url(), title: await page.title().catch(() => ''), checkpoint });
    }),
  );

  server.registerTool(
    'debug_page_text',
    {
      title: 'Visible text of the current page',
      description: 'Return the innerText of <main> (or body) of the current tab, clipped. Cheap way to see what LinkedIn is showing.',
      inputSchema: { maxChars: z.number().int().min(500).max(200_000).default(20_000) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ maxChars }) => {
      const page = await session.ensure();
      return ok({ url: page.url(), ...clip(await mainText(page), maxChars) });
    }),
  );

  server.registerTool(
    'debug_find',
    {
      title: 'Try a CSS/Playwright selector',
      description: 'Count and describe elements matching a selector on the current tab: text, href, aria-label, data-view-name, componentkey, class. Use to repair src/linkedin/selectors.ts when LinkedIn changes markup.',
      inputSchema: { selector: z.string(), limit: z.number().int().min(1).max(100).default(20) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ selector, limit }) => {
      const page = await session.ensure();
      const loc = page.locator(selector);
      const count = await loc.count();
      const items: Array<Record<string, unknown>> = [];
      for (let i = 0; i < Math.min(count, limit); i++) {
        const el = loc.nth(i);
        items.push(
          await el
            .evaluate((n) => ({
              tag: n.tagName.toLowerCase(),
              text: ((n as HTMLElement).innerText ?? n.textContent ?? '').trim().slice(0, 300),
              href: (n as HTMLAnchorElement).href || n.getAttribute('href') || undefined,
              ariaLabel: n.getAttribute('aria-label') || undefined,
              dataViewName: n.getAttribute('data-view-name') || undefined,
              componentKey: n.getAttribute('componentkey') || undefined,
              className: typeof n.className === 'string' ? n.className.slice(0, 200) : undefined,
              visible: !!(n as HTMLElement).offsetParent,
            }))
            .catch((e) => ({ error: String(e) })),
        );
      }
      return ok({ selector, count, items });
    }),
  );

  server.registerTool(
    'debug_click',
    {
      title: 'Click an element (human-like)',
      description: 'Click the first visible element matching a selector on the current tab, with the same paced mouse movement the worker uses, then report the resulting URL, title, checkpoint state and the number of matches. For exploring pagination / menus while adapting selectors. Read-only actions only: never use it to rate, shortlist, move or message applicants.',
      inputSchema: { selector: z.string(), waitMs: z.number().int().min(0).max(15000).default(2500).describe('Settle time after the click') },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(async ({ selector, waitMs }) => {
      if (/shortlist|move to|rate|message|reject|hire|good fit|not a fit|maybe/i.test(selector)) return fail(new Error('Refusing: that selector looks like a write action on an applicant.'));
      const page = await session.ensure();
      const loc = page.locator(selector);
      const count = await loc.count();
      if (!count) return fail(new Error(`No element matches ${selector}`));
      await session.human.click(page, loc.first());
      await new Promise((r) => setTimeout(r, waitMs));
      return ok({ clicked: selector, matches: count, url: page.url(), title: await page.title().catch(() => ''), checkpoint: await session.detectCheckpoint(page) });
    }),
  );

  server.registerTool(
    'debug_captures',
    {
      title: 'Captured network payloads',
      description: 'List the JSON / RSC responses LinkedIn\'s own web app fetched while we browsed (Voyager REST, GraphQL, flagship-web). This is how you discover the endpoints and shapes behind the hiring dashboard. Bodies clipped to 2000 chars.',
      inputSchema: { urlContains: z.string().optional(), kind: z.enum(['voyager-rest', 'voyager-graphql', 'rsc', 'document', 'other']).optional(), limit: z.number().int().min(1).max(200).default(20) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ urlContains, kind, limit }) => {
      const all = session.capture.all().filter((e) => (!urlContains || e.url.includes(urlContains)) && (!kind || e.kind === kind));
      const items = all.slice(-limit).map((e) => ({ seq: e.seq, url: e.url, method: e.method, status: e.status, kind: e.kind, contentType: e.contentType, capturedAt: e.capturedAt, requestHeaders: e.requestHeaders, body: e.body.slice(0, 2000), truncated: e.body.length > 2000 || e.truncated }));
      return ok({ total: all.length, items });
    }),
  );
}
