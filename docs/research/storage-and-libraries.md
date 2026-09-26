# Research notes (2026-09-25, auto-collected; verify before relying on any single claim)

####################################################################################################
SUMMARY: Verified 2026-09-25 against the npm registry, primary docs and a live run on the local Node v26.5.0. (1) SQLite: node:sqlite is un-flagged since v22.13.0/v23.4.0 and is "Stability 1.2 – Release candidate" in both Node 24 (v24.21.0 docs) and Node 26 (v26.10.0 docs); it works with no warning on Node 26.5.0 (SQLite 3.53.3). It has no .transaction() helper (use exec('BEGIN IMMEDIATE')/COMMIT/ROLLBACK + db.isTransaction) and double-quoted string literals are OFF by default (verified error: "no such column ... should this be a string literal in single-quotes?"). better-sqlite3 13.0.3 (2026-08-05) is the first N-API build (13.0.0, 2026-07-21), ships prebuilds (darwin-arm64 included) in the tarball, engines node>=22, needs @types/better-sqlite3 9.6.0; 12.x and earlier fail to compile on Node 26. Recommendation: node:sqlite for this app-level, single-process MCP server (zero native deps, no install-time build); better-sqlite3 13.x is a fine alternative if you want db.transaction() ergonomics. (2) PDF/DOCX: unpdf 1.8.1 (2026-08-13, Node>=22, ESM, bundles a serverless PDF.js 6.1 build with polyfills, @napi-rs/canvas only optional for rendering) is the recommended extractor; pdfjs-dist 6.3.289 (2026-08-29, engines >=22.13.0||>=24, legacy/build/pdf.mjs still present, @napi-rs/canvas ^1 is optionalDependencies) as a direct fallback; pdf-parse 2.4.5 works (class API PDFParse/getText/destroy) but was last published 2025-10-20, CI covers Node 20–24 only, and hard-pins pdfjs-dist 5.4.296 + @napi-rs/canvas 0.1.80; pdf2json 4.1.0 (2026-09-11, engines >=22.23.2, ESM default export, event API) is heavier and unnecessary; mammoth 1.12.3 (2026-09-12) extractRawText({buffer}) for DOCX. (3) CSV: csv-stringify 6.9.0 (2026-09-25) sync API with header/columns/bom/escape_formulas; a 15-line hand-rolled writer is also fine. (4) Logging: MCP docs require stderr for stdio servers; protocol logging (notifications/message) is deprecated in the 2026-07-28 spec in favor of stderr/OpenTelemetry. pino 10.3.1 with pino.destination({dest:2,sync:true}) or plain console.error both work; avoid worker-thread transports in a stdio server. (5) Testing: vitest 5.0.2 (5.0.0 released 2026-09-03), engines ^22.12.0||^24.0.0||>=26.0.0, vite is now a peer dep (^6.4||^7||^8; vite 8.3.1 current), clearMocks defaults true. (6) zod: 4.6.5 is latest; zod 4 has been the root export since 4.0.0 (2025-07-08); zod/v3 subpath still exists; TS>=5.5 strict. MCP SDK: @modelcontextprotocol/sdk 1.30.1 (2026-09-23) accepts zod ^3.25||^4.0 and registerTool takes a raw zod shape; the new v2 packages @modelcontextprotocol/server 2.1.0 (2026-09-23) require zod ^4.2.0, inputSchema as z.object(...) (Standard Schema), engines node>=20. Bonus: typescript latest is 7.0.2 (native Go tsc, 2026-07-08); 6.0.3 is the last JS-based release.

FACTS:
 - [high] node:sqlite in the Node v26.10.0 docs is 'Stability: 1.2 - Release candidate'; it moved to RC in v25.7.0 and has not required --experimental-sqlite since v22.13.0 / v23.4.0. Node 24 docs (v24.21.0) show the same 1.2 status.  <https://nodejs.org/api/sqlite.html>
 - [high] On the local Node v26.5.0, `import { DatabaseSync } from 'node:sqlite'` runs with no flag and no ExperimentalWarning; process.versions.sqlite = 3.53.3. Prepared statements, named params (:name), ON CONFLICT DO NOTHING, RETURNING, iterate(), and BEGIN IMMEDIATE/COMMIT all worked in an in-memory smoke test.  <https://nodejs.org/api/sqlite.html>
 - [high] node:sqlite has NO transaction helper; you must exec('BEGIN')/exec('COMMIT')/exec('ROLLBACK') and can check db.isTransaction. DatabaseSync options include open, readOnly, enableForeignKeyConstraints (default true), enableDoubleQuotedStringLiterals (default false), timeout (busy timeout ms, default 0, added v24.0.0), readBigInts, returnArrays, allowBareNamedParameters, defensive (default true since v25.5.0). StatementSync.run() returns { changes, lastInsertRowid }. Symbol.dispose on DatabaseSync is non-experimental since v24.2.0.  <https://nodejs.org/api/sqlite.html>
 - [high] node:sqlite gotcha (verified): double-quoted string literals are disabled by default, so DEFAULT "pending" fails with ERR_SQLITE_ERROR 'no such column: "pending" - should this be a string literal in single-quotes?'. Use single quotes in all SQL.  <https://nodejs.org/api/sqlite.html>
 - [high] @types/node 26.6.2 ships sqlite.d.ts (typings for node:sqlite), HTTP 200 at cdn.jsdelivr.net/npm/@types/node@26.6.2/sqlite.d.ts.  <https://cdn.jsdelivr.net/npm/@types/node@26.6.2/sqlite.d.ts>
 - [high] better-sqlite3 latest is 13.0.3 (published 2026-08-05); 13.0.0 (2026-07-21) is the first N-API (node-addon-api ^8) build with prebuilt binaries shipped inside the package (prebuilds/darwin-arm64.node, darwin-x64, linux-x64/arm64, linuxmusl, win32). engines: node >=22. Adds db.explain() and stmt.toString(). No bundled TS types; use @types/better-sqlite3 9.6.0 (updated 2026-08-01).  <https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0>
 - [medium] better-sqlite3 <=12.x fails to compile / has no prebuilds on Node 26; multiple downstream projects fixed it by bumping to ^13.0.3.  <https://github.com/mvschwarz/openrig/pull/16>
 - [high] better-sqlite3 API: new Database(path, { readonly, fileMustExist, timeout: 5000, verbose }); db.pragma('journal_mode = WAL'); stmt.run/get/all/iterate; db.transaction(fn) returns a function with .deferred/.immediate/.exclusive variants.  <https://raw.githubusercontent.com/WiseLibs/better-sqlite3/master/docs/api.md>
 - [medium] Benchmarks show node:sqlite roughly on par with better-sqlite3 for single-row get and inserts, but slower for .all()/iterate over 100 rows (~23k vs ~37k ops/s). Not material for a human-paced scraper.  <https://sqg.dev/blog/sqlite-driver-benchmark/>
 - [high] Node release schedule (nodejs/Release schedule.json): v24 'Krypton' LTS since 2025-10-28, maintenance 2026-10-20, EOL 2028-04-30; v26 started 2026-05-05, becomes LTS 2026-10-28, EOL 2029-04-30. v26 is 'Current' today.  <https://raw.githubusercontent.com/nodejs/Release/main/schedule.json>
 - [high] unpdf latest is 1.8.1 (2026-08-13); engines node >=22; type: module. v1.8.0 (2026-07-24) upgraded the bundled serverless PDF.js build to v6.1 (package.json devDep pdfjs-dist ~6.1.200; the README line 'built from PDF.js v5.6.205' is stale) and added @napi-rs/canvas v1 support (only needed for rendering). API: getDocumentProxy(new Uint8Array(buf)) then extractText(pdf, { mergePages: true }) -> { totalPages, text }; also getMeta(), extractTextItems() (1.6.0), definePDFJSModule(() => import('pdfjs-dist')) to swap in the official build.  <https://github.com/unjs/unpdf/releases>
 - [high] pdfjs-dist latest is 6.3.289 (2026-08-29); engines node '>=22.13.0 || >=24'; @napi-rs/canvas ^1.0.0 is an optionalDependency (needed only for rendering/DOMMatrix polyfill, not for getTextContent). legacy/build/pdf.mjs and legacy/build/pdf.worker.mjs still exist in 6.3.289 (HTTP 200 on jsdelivr). Mozilla's own Node example imports 'pdfjs-dist/legacy/build/pdf.mjs' and reads page.getTextContent().items[].str.  <https://raw.githubusercontent.com/mozilla/pdf.js/master/examples/node/getinfo.mjs>
 - [high] pdf-parse latest is 2.4.5 (published 2025-10-20; the 'minor' dist-tag 1.1.4 is the legacy v1 line, last 2025-10-29). engines '>=20.16.0 <21 || >=22.3.0'; type: module with CJS fallback; subpaths './node' and './worker'. Hard dependencies: pdfjs-dist 5.4.296 and @napi-rs/canvas 0.1.80. v2 API: import { PDFParse } from 'pdf-parse'; const p = new PDFParse({ data: buffer }); const r = await p.getText(); r.text / r.pages; await p.destroy(). GitHub CI covers Node 20–24 only; Node 26 not mentioned; 221 stars, 22 open issues.  <https://raw.githubusercontent.com/mehmet-kozan/pdf-parse/main/README.md>
 - [high] pdf2json latest is 4.1.0 (2026-09-11); npm engines node >=22.23.2 (README still says 20.18.0); type: module with CJS build; default export: import PDFParser from 'pdf2json'; raw-text mode: new PDFParser(null, 1), then on('pdfParser_dataReady') call getRawTextContent(); parseBuffer(buf). v4.0.0 changed text output to plain UTF-8 (no decodeURIComponent needed).  <https://cdn.jsdelivr.net/npm/pdf2json@4.1.0/readme.md>
 - [high] mammoth latest is 1.12.3 (2026-09-12); engines node >=12; CommonJS package (bluebird promises). mammoth.extractRawText({ buffer }) (Node) or { path } / { arrayBuffer } -> { value: string (paragraphs separated by two newlines), messages: [] }.  <https://raw.githubusercontent.com/mwilliamson/mammoth.js/master/README.md>
 - [high] csv-stringify latest is 6.9.0 (2026-09-25); ESM + CJS; sync API: import { stringify } from 'csv-stringify/sync'; stringify(records, { header: true, columns, bom, quoted, quoted_string, record_delimiter, cast, escape_formulas }). escape_formulas (since 6.3.0) prefixes values starting with = + - @ \t \r with a quote to prevent CSV injection.  <https://csv.js.org/stringify/options/>
 - [high] MCP official debugging guide: for stdio servers 'all messages logged to stderr will be captured by the host application automatically' and 'Local MCP servers should not log messages to stdout, as this will interfere with protocol operation.' Claude Desktop writes captured stderr to ~/Library/Logs/Claude/mcp*.log on macOS.  <https://modelcontextprotocol.io/docs/tools/debugging>
 - [high] Protocol-level logging (notifications/message / server.sendLoggingMessage) is DEPRECATED as of MCP spec 2026-07-28 (SEP-2577): 'New implementations SHOULD NOT adopt it; existing implementations SHOULD migrate to logging to stderr for stdio transports, or to OpenTelemetry.'  <https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/logging>
 - [high] pino latest is 10.3.1 (2026-02-09); pino-pretty 13.1.3. pino 10.0.0's only breaking change was dropping Node 18. To log to stderr: pino(pino.destination(2)) or pino(pino.destination({ dest: 2, sync: true })); pretty transport: pino({ transport: { target: 'pino-pretty', options: { destination: 2 } } }). Transports run in a worker thread, so logs written right before process.exit() can be lost, prefer a sync destination in a stdio server.  <https://raw.githubusercontent.com/pinojs/pino/main/docs/api.md>
 - [high] vitest latest is 5.0.2 (dist-tag V4 = 4.1.11, 2026-08-18); Vitest 5.0.0 was released 2026-09-03. engines node '^22.12.0 || ^24.0.0 || >=26.0.0'; vite is now a peer dependency '^6.4.0 || ^7.0.0 || ^8.0.0' (current vite 8.3.1). Breaking: clearMocks defaults to true; test.sequential/describe.sequential removed (use concurrent: false); config is no longer looked up in ancestor directories; VITEST_POOL_ID/WORKER_ID start at 1; reports go under .vitest/; vi.mock outside top level throws.  <https://vitest.dev/guide/migration>
 - [high] zod latest is 4.6.5 (2026-09-13). Zod 4 became the package-root export with zod@4.0.0 on 2025-07-08; zod@3.25.x exposes 'zod/v4'; 'zod/v3' remains available in v4 for legacy code; also 'zod/mini'. Requires TypeScript >=5.5 with strict: true. Library authors are told to declare peer 'zod': '^3.25.0 || ^4.0.0'. Notable v4 changes: z.email()/z.url() top-level formats, unified { error } param, z.toJSONSchema().  <https://zod.dev/v4/versioning>
 - [high] @modelcontextprotocol/sdk (v1 line) latest is 1.30.1 (2026-09-23), not deprecated; engines node >=18; dependencies/peer: zod '^3.25 || ^4.0' ('internally imports from zod/v4, but maintains backwards compatibility with projects using Zod v3.25 or later'). registerTool(name, { title, description, inputSchema: { a: z.number() } /* raw shape */, outputSchema }, async (args, extra) => ({ content, structuredContent })); imports from '@modelcontextprotocol/sdk/server/mcp.js' and '/server/stdio.js'. v1.x continues to get fixes for at least 6 months after v2.  <https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/docs/server.md>
 - [high] MCP SDK v2 ships as NEW packages: @modelcontextprotocol/server 2.1.0 (2.0.0 on 2026-07-27, 2.1.0 on 2026-09-23; 'the stable release line, released alongside the 2026-07-28 spec'), plus /client and /core. dependencies: zod '^4.2.0' (hard requirement; v3 no longer works), engines node >=20. inputSchema must be a Standard Schema object (z.object({...})), raw shapes are a deprecated auto-wrapped overload. Server.sendLoggingMessage is @deprecated. The README's TypeScript note is only that TS >=6.0 no longer auto-includes @types/*, so add "types": ["node"] to tsconfig, it is not a TS >=6 requirement.  <https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/migration/upgrade-to-v2.md>
 - [medium] typescript latest on npm is 7.0.2 (2026-07-08): the native Go compiler now ships as `tsc` in the regular package; TypeScript 6.0.3 (2026-04-16) is the last JS-based release. TS 7 has no stable programmatic API until 7.1 (affects typescript-eslint and framework language tools, not tsx/esbuild/Vitest). Removed options in 7.0: baseUrl, moduleResolution node10/classic, target es5, module amd/umd/system; esModuleInterop cannot be false. Keep 6.x side-by-side via "typescript": "npm:@typescript/typescript6@^6.0.2" if needed.  <https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/>
 - [high] Other current versions checked via npm view on 2026-09-25: playwright 1.63.0, tsx 4.23.15, @types/node 26.6.2, vite 8.3.1, pino-pretty 13.1.3. Local toolchain: node v26.5.0, npm 11.17.0.  <>

RECOMMENDATIONS:
 - SQLite: use built-in node:sqlite (DatabaseSync) for this server. It is un-flagged, RC-stability in Node 24/26, has zero native dependencies (no node-gyp/prebuild failures when the user's Node updates), and its synchronous API fits a single-process queue. Write your own withTransaction() helper (BEGIN IMMEDIATE/COMMIT/ROLLBACK), pass { timeout: 5000 } for busy-timeout, set PRAGMA journal_mode=WAL + synchronous=NORMAL once at open, and use ONLY single-quoted string literals in SQL (DQS is off by default). Pick better-sqlite3 ^13.0.3 (+ @types/better-sqlite3 ^9.6.0) only if you specifically want db.transaction()/db.pragma() ergonomics; never use <13 on Node 26.
 - Queue design with node:sqlite: an `applicants` table with status IN ('pending','in_progress','done','failed'), attempts, last_error, and an index on (status, id); claim work atomically with `UPDATE ... WHERE id = (SELECT id ... WHERE status='pending' ORDER BY id LIMIT 1) RETURNING ...` (works on SQLite 3.53). Store resume bytes on disk and only the path + sha256 + extracted text in SQLite. Use INSERT ... ON CONFLICT(profile_url) DO NOTHING for idempotent re-runs so the job is resumable.
 - PDF text: use unpdf ^1.8.1 (ESM, Node>=22, bundles PDF.js 6.1 with polyfills, no native deps), `getDocumentProxy(new Uint8Array(buf))` then `extractText(pdf, { mergePages: true })`. Keep pdfjs-dist ^6.3.289 legacy build as a fallback via unpdf's definePDFJSModule if a resume fails to parse. Avoid pdf-parse 2.x here: it is 11 months stale, pins pdfjs-dist 5.4.296, and hard-depends on a native @napi-rs/canvas 0.1.80 whose prebuilt binary must load on every install. pdf2json is unnecessary for plain text. Add mammoth ^1.12.3 for .docx (`extractRawText({ buffer })`) and dispatch on magic bytes (%PDF- vs PK\x03\x04) rather than file extension. Treat empty text output as 'scanned/image PDF' and record it; OCR is out of scope unless you add tesseract.js.
 - CSV: csv-stringify ^6.9.0 sync API is the pragmatic choice, set header: true, explicit columns, bom: true (Excel-friendly UTF-8), and escape_formulas: true because applicant-supplied text can start with '=' or '@' (CSV injection). If you want zero deps, a 15-line writer that RFC4180-quotes any field containing , " \n \r and doubles inner quotes is sufficient; still prefix =,+,-,@ with a quote.
 - Logging: everything to stderr, never stdout. Simplest robust option: a tiny logger over `process.stderr.write(JSON.stringify(...)+'\n')` or console.error. If you want pino, use `pino({ level }, pino.destination({ dest: 2, sync: true }))`, a sync fd-2 destination, NOT a worker-thread transport (pino-pretty transport can lose lines on exit and adds a worker to a stdio process). Add a guard at startup that reroutes console.log/info/debug to console.error so Playwright or a dependency cannot corrupt the JSON-RPC stream. Do not build on server.sendLoggingMessage/notifications/message, it is deprecated in the 2026-07-28 spec.
 - Testing: vitest ^5.0.2 with vite ^8 installed explicitly as a devDependency (vite is now a peer dep). Config: `import { defineConfig } from 'vitest/config'` with test.environment 'node', include ['src/**/*.test.ts','test/**/*.test.ts'], and testTimeout raised for any Playwright-touching tests. clearMocks is already true by default in v5; replace any describe.sequential with concurrent: false. Run `vitest run` in CI.
 - Schemas / SDK: use zod ^4.6.5 (import from 'zod'). If you start on the v1 SDK (@modelcontextprotocol/sdk ^1.30.1, zod ^3.25||^4 accepted), pass raw zod shapes to registerTool's inputSchema. If you start on the v2 SDK (@modelcontextprotocol/server ^2.1.0, zod ^4.2 required), pass z.object({...}) and import StdioServerTransport from '@modelcontextprotocol/server/stdio'; v2 is the stable line for the 2026-07-28 spec, so prefer it for a greenfield server unless a client you must support only speaks v1-era protocol versions (v2 serves earlier revisions too). Avoid deprecated string-format methods (use z.url(), z.email()).
 - TypeScript: `typescript@^7.0.2` works as a type-checker/emitter (tsc is now native and ~10x faster) and is fine alongside tsx 4.23 and Vitest (both use esbuild/Vite, not the TS API). Ensure tsconfig has strict: true (zod), "types": ["node"], module/moduleResolution nodenext or node20, and no baseUrl/es5 targets. If you rely on typescript-eslint, pin @typescript/typescript6 via npm alias until TS 7.1 exposes the API.
 - Pin exact versions in package.json now that they are verified: node:sqlite (built-in), unpdf 1.8.1, pdfjs-dist 6.3.289 (optional fallback), mammoth 1.12.3, csv-stringify 6.9.0, pino 10.3.1 (optional), vitest 5.0.2 + vite 8.3.1, zod 4.6.5, @modelcontextprotocol/server 2.1.0 (or @modelcontextprotocol/sdk 1.30.1), playwright 1.63.0, typescript 7.0.2, @types/node 26.6.2, tsx 4.23.15; set engines.node to '>=26' (or '>=24' if you also want the current LTS).

OPEN QUESTIONS:
 - Will node:sqlite reach Stability 2 before Node 26 becomes LTS on 2026-10-28? It is 1.2 (RC) in the v26.10.0 docs today; API has been additive since v22.13, so risk is low, but the docs page should be re-checked at release time.
 - Does the v1 SDK (1.30.1) still receive fixes long enough for this project's lifetime? The README promises 'at least 6 months' after v2's 2026-07-27 release, i.e. through ~2027-01; choosing v2 (@modelcontextprotocol/server) avoids this question but forces zod ^4.2 and z.object() input schemas.
 - pdf-parse 2.4.5 on Node 26 is untested by its maintainers (CI covers Node 20–24 only); if the implementer insists on pdf-parse, a quick local smoke test on Node 26.5 is needed. unpdf is the recommended path and sidesteps this.
 - unpdf's README still says the serverless build is from PDF.js v5.6.205 while v1.8.0 release notes and package.json say 6.1; the exact bundled PDF.js patch version in 1.8.1 was not confirmed from source.
 - Progress reporting for a multi-hour export tool: whether to surface progress via MCP notifications/progress (extra.sendNotification with _meta.progressToken in v1; ctx.sendNotification in v2) or via a separate 'status' tool polling the SQLite queue, the latter is simpler and transport-independent, but the exact v1/v2 progress-token snippet was not verified from a primary source in this pass (medium confidence).
 - Scanned/image-only resume PDFs yield empty text from every library surveyed; whether to add OCR (tesseract.js) or just flag them for manual review is a product decision.
 - Resume file types beyond PDF/DOCX (e.g. legacy .doc, .rtf, .pages) are not covered by mammoth/unpdf; the implementer should record unsupported types instead of failing the queue item.

SNIPPETS:
--- node:sqlite (Node 24/26 built-in): open with WAL + busy timeout, schema, prepared statements, manual transaction helper, atomic queue claim. Verified on Node v26.5.0 in-memory. (typescript) ---
// src/db.ts, no npm dependency; types come from @types/node >= 22.
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path, {
    timeout: 5000,                 // busy_timeout ms (Node >= 24.0.0)
    enableForeignKeyConstraints: true,
    // enableDoubleQuotedStringLiterals stays false: use 'single quotes' for all string literals!
  });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, title TEXT, state TEXT CHECK (state IN ('open','closed')),
      scraped_at TEXT
    );
    CREATE TABLE IF NOT EXISTS applicants (
      id INTEGER PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      profile_url TEXT NOT NULL UNIQUE,
      full_name TEXT, headline TEXT, location TEXT, applied_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      resume_path TEXT, resume_sha256 TEXT, resume_text TEXT,
      profile_json TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS applicants_status_idx ON applicants(status, id);
    CREATE INDEX IF NOT EXISTS applicants_job_idx ON applicants(job_id);
  `);
  return db;
}

// node:sqlite has no db.transaction(); roll your own.
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

export function makeQueue(db: DatabaseSync) {
  const insert: StatementSync = db.prepare(
    `INSERT INTO applicants (job_id, profile_url, full_name)
     VALUES (:job_id, :profile_url, :full_name)
     ON CONFLICT(profile_url) DO NOTHING`);
  const claim = db.prepare(
    `UPDATE applicants SET status = 'in_progress', attempts = attempts + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = (SELECT id FROM applicants WHERE status = 'pending' ORDER BY id LIMIT 1)
     RETURNING id, job_id, profile_url`);
  const finish = db.prepare(
    `UPDATE applicants SET status = ?, last_error = ?, resume_path = ?, resume_sha256 = ?,
        resume_text = ?, profile_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`);
  const counts = db.prepare(`SELECT status, count(*) AS n FROM applicants GROUP BY status`);

  return {
    enqueueMany(rows: { job_id: string; profile_url: string; full_name?: string }[]) {
      return withTransaction(db, () => {
        let added = 0;
        for (const r of rows) added += Number(insert.run({ ...r, full_name: r.full_name ?? null }).changes);
        return added;
      });
    },
    claimNext() {
      return claim.get() as { id: number; job_id: string; profile_url: string } | undefined;
    },
    markDone(id: number, data: { resume_path?: string; resume_sha256?: string; resume_text?: string; profile_json?: string }) {
      finish.run('done', null, data.resume_path ?? null, data.resume_sha256 ?? null,
                 data.resume_text ?? null, data.profile_json ?? null, id);
    },
    markFailed(id: number, error: string) {
      finish.run('failed', error.slice(0, 2000), null, null, null, null, id);
    },
    stats() { return counts.all() as { status: string; n: number }[]; },
    *pending() { yield* db.prepare(`SELECT id, profile_url FROM applicants WHERE status = 'pending' ORDER BY id`).iterate(); },
  };
}
--- better-sqlite3 13.x equivalent (only if you prefer its built-in transaction helper). npm i better-sqlite3@^13.0.3 && npm i -D @types/better-sqlite3@^9.6.0 (typescript) ---
import Database from 'better-sqlite3';

const db = new Database('applicants.db', { timeout: 5000 });
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.exec(`CREATE TABLE IF NOT EXISTS applicants (id INTEGER PRIMARY KEY, profile_url TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'pending')`);

const insert = db.prepare('INSERT INTO applicants (profile_url) VALUES (?) ON CONFLICT DO NOTHING');
const insertMany = db.transaction((urls: string[]) => {
  let n = 0; for (const u of urls) n += insert.run(u).changes; return n;
});
insertMany.immediate(['https://www.linkedin.com/in/a', 'https://www.linkedin.com/in/b']); // BEGIN IMMEDIATE

const next = db.prepare(`UPDATE applicants SET status='in_progress' WHERE id = (SELECT id FROM applicants WHERE status='pending' ORDER BY id LIMIT 1) RETURNING id, profile_url`).get();
--- Resume text extraction from a Buffer: unpdf (primary, PDF.js 6.1 bundled, no native deps) with pdfjs-dist legacy fallback, mammoth for DOCX, dispatch by magic bytes. npm i unpdf@^1.8.1 mammoth@^1.12.3 (optional: pdfjs-dist@^6.3.289) (typescript) ---
// src/extract.ts (ESM)
import { extractText, getDocumentProxy, getMeta } from 'unpdf';
import mammoth from 'mammoth'; // CJS package; default import works under ESM/nodenext

export type Extracted = { kind: 'pdf' | 'docx' | 'unknown'; text: string; pages?: number; warnings: string[] };

export async function extractResumeText(buf: Buffer, filename = ''): Promise<Extracted> {
  const warnings: string[] = [];
  if (isPdf(buf)) {
    const pdf = await getDocumentProxy(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    try {
      const { totalPages, text } = await extractText(pdf, { mergePages: true });
      if (!text.trim()) warnings.push('no extractable text (scanned/image PDF?)');
      return { kind: 'pdf', text: normalize(text), pages: totalPages, warnings };
    } finally {
      await pdf.destroy();
    }
  }
  if (isZip(buf) || /\.docx$/i.test(filename)) {
    const { value, messages } = await mammoth.extractRawText({ buffer: buf });
    warnings.push(...messages.map(m => `${m.type}: ${m.message}`));
    return { kind: 'docx', text: normalize(value), warnings };
  }
  return { kind: 'unknown', text: '', warnings: ['unsupported file type'] };
}

const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';
const isZip = (b: Buffer) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04; // PK\x03\x04 (docx)
const normalize = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// --- Fallback: official pdfjs-dist legacy build (no unpdf). Same PDF.js API surface. ---
// import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
// export async function pdfTextViaPdfjs(buf: Buffer): Promise<string> {
//   const doc = await getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false }).promise;
//   const parts: string[] = [];
//   for (let i = 1; i <= doc.numPages; i++) {
//     const page = await doc.getPage(i);
//     const tc = await page.getTextContent();
//     parts.push(tc.items.map((it: any) => ('str' in it ? it.str : '') + (it.hasEOL ? '\n' : ' ')).join(''));
//     page.cleanup();
//   }
//   await doc.destroy();
//   return parts.join('\n\n');
// }
// Or keep unpdf's API and just swap the engine: await definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'));
--- pdf-parse 2.x usage, in case it is chosen instead (note: stale since 2025-10-20, pins pdfjs-dist 5.4.296 and native @napi-rs/canvas 0.1.80) (typescript) ---
import { PDFParse } from 'pdf-parse';

export async function pdfParseText(buf: Buffer): Promise<{ text: string; pages: number }> {
  const parser = new PDFParse({ data: buf });
  try {
    const r = await parser.getText();          // r.text, r.pages[], also getInfo(), getTable(), getImage()
    return { text: r.text, pages: r.pages.length };
  } finally {
    await parser.destroy();                    // required to free memory
  }
}
--- CSV export: csv-stringify sync API with header, explicit columns, BOM and formula escaping; plus a dependency-free writer. npm i csv-stringify@^6.9.0 (typescript) ---
import { stringify } from 'csv-stringify/sync';
import { writeFile } from 'node:fs/promises';

export async function writeApplicantsCsv(rows: Record<string, unknown>[], outPath: string) {
  const csv = stringify(rows, {
    header: true,
    columns: [
      { key: 'job_id', header: 'Job ID' },
      { key: 'full_name', header: 'Name' },
      { key: 'headline', header: 'Headline' },
      { key: 'location', header: 'Location' },
      { key: 'profile_url', header: 'LinkedIn URL' },
      { key: 'applied_at', header: 'Applied' },
      { key: 'resume_path', header: 'Resume file' },
      { key: 'status', header: 'Status' },
    ],
    bom: true,             // Excel opens UTF-8 correctly
    escape_formulas: true, // guard against =,+,-,@ CSV injection from applicant text
    record_delimiter: 'unix',
    cast: { date: d => d.toISOString(), boolean: b => (b ? 'true' : 'false') },
  });
  await writeFile(outPath, csv, 'utf8');
}

// Zero-dependency alternative (RFC 4180 quoting + formula guard):
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const cell = (v: unknown) => {
    let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                 // formula guard
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [columns.map(cell).join(',')];
  for (const r of rows) lines.push(columns.map(c => cell(r[c])).join(','));
  return '﻿' + lines.join('\n') + '\n';
}
--- stderr-only logging for an MCP stdio server: pino with a synchronous fd-2 destination, plus a console guard so nothing (Playwright, deps) can write to stdout. npm i pino@^10.3.1 (pino-pretty@^13.1.3 optional for local dev) (typescript) ---
// src/log.ts, MUST be imported first in the entrypoint.
import pino from 'pino';

// 1) Nothing but JSON-RPC may touch stdout. Reroute console.* to stderr defensively.
for (const m of ['log', 'info', 'debug', 'trace'] as const) {
  (console as any)[m] = (...args: unknown[]) => console.error(...args);
}

// 2) Synchronous stderr destination: no worker thread, nothing lost on process.exit().
export const log = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { app: 'linkedin-applicants-mcp', pid: process.pid },
    redact: ['cookies', 'headers.cookie', '*.password'],   // never log session cookies
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination({ dest: 2, sync: true }),
);

// Dev-only pretty output (still stderr): LOG_PRETTY=1 node dist/index.js
// const pretty = process.env.LOG_PRETTY ? { transport: { target: 'pino-pretty', options: { destination: 2 } } } : {};

// Minimal no-dependency alternative:
// export const log = { info: (o: object, msg?: string) => process.stderr.write(JSON.stringify({ level: 'info', time: new Date().toISOString(), msg, ...o }) + '\n') };
--- Vitest 5 config for Node 26 (vite must be installed explicitly as a peer). npm i -D vitest@^5.0.2 vite@^8.3.1 (typescript) ---
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,        // Playwright-touching tests need more than the 5s default
    hookTimeout: 60_000,
    // clearMocks is true by default in Vitest 5; `sequential` was removed, use { concurrent: false }
    fileParallelism: false,     // one browser/SQLite file at a time in integration tests
    coverage: { provider: 'v8', include: ['src/**'], reporter: ['text', 'html'] },
  },
});

// package.json scripts:
// "test": "vitest run", "test:watch": "vitest"
// tsconfig: { "compilerOptions": { "strict": true, "module": "nodenext", "moduleResolution": "nodenext", "target": "es2024", "types": ["node"] } }
--- zod 4 with the MCP TypeScript SDK, v1 (@modelcontextprotocol/sdk@1.30.1: raw zod shape) and v2 (@modelcontextprotocol/server@2.1.0: z.object, zod ^4.2 required) (typescript) ---
// ---- SDK v1: npm i @modelcontextprotocol/sdk@^1.30.1 zod@^4.6.5 ----
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'linkedin-applicants', version: '0.1.0' });

server.registerTool(
  'export_job_applicants',
  {
    title: 'Export job applicants',
    description: 'Queue a LinkedIn hiring-dashboard job for applicant export (runs in the background).',
    inputSchema: {                                   // v1: RAW SHAPE, not z.object()
      jobUrl: z.url().describe('https://www.linkedin.com/hiring/jobs/<id>/applicants/'),
      includeResumes: z.boolean().default(true),
      includeFullProfiles: z.boolean().default(true),
      maxPerHour: z.number().int().min(1).max(60).default(20),
    },
    outputSchema: { queued: z.number().int(), jobId: z.string() },
  },
  async ({ jobUrl, includeResumes, includeFullProfiles, maxPerHour }, extra) => {
    const out = { queued: 0, jobId: 'todo' };
    return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
  },
);

await server.connect(new StdioServerTransport());

// ---- SDK v2: npm i @modelcontextprotocol/server@^2.1.0 zod@^4.6.5 ----
// import { McpServer } from '@modelcontextprotocol/server';
// import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
// import * as z from 'zod';
// server.registerTool('export_job_applicants', {
//   description: '...',
//   inputSchema: z.object({ jobUrl: z.url(), includeResumes: z.boolean().default(true) }),  // v2: Standard Schema object
//   outputSchema: z.object({ queued: z.number().int() }),
// }, async ({ jobUrl }, ctx) => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { queued: 0 } }));
// await server.connect(new StdioServerTransport());

