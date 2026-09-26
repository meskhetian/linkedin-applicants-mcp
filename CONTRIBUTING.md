# Contributing to linkedin-applicants-mcp

Thank you for taking the time to contribute. This document explains how the project is set up, how the code
is organised, how to fix things when LinkedIn changes its markup (the most common kind of contribution), and
what we expect from a pull request.

Please read the [ground rules](#ground-rules) first; they are short and they are not negotiable.

## Ground rules

1. **The project stays read-only on LinkedIn.** It only reads what the job poster can already see in their
   own hiring dashboard. Pull requests that add rating, notes, messaging, InMail, connection requests, job
   editing, applying, or *any* other write action on LinkedIn will not be accepted, regardless of how they are
   framed. The same goes for features that bypass LinkedIn checkpoints or CAPTCHAs, or that make the default
   pacing more aggressive.
2. **No real applicant data, ever.** Test fixtures use fictional people and companies only (the existing tests
   use names like "Acme Robotics"). Never commit anything from the data directory
   (`~/.linkedin-applicants-mcp` by default): no `db.sqlite`, no resumes, no `profile.json`, no raw snapshots,
   no screenshots, no Chrome profile. Redact names, application ids, emails and phone numbers from anything you
   paste into an issue or PR. See [SECURITY.md](SECURITY.md) for what the tool stores.
3. **The user's own browser, visibly.** The design relies on the user's installed Chrome, their real cookies
   and their real IP. Do not add headless mode, browser downloads, proxy rotation or user-agent spoofing.

## Development setup

Requirements: Node.js >= 22.13 (CI runs 22, 24 and 26) and Google Chrome for anything that actually touches
LinkedIn. Unit tests and the stdio smoke test do **not** need Chrome or a LinkedIn account.

```bash
git clone https://github.com/meskhetian/linkedin-applicants-mcp.git
cd linkedin-applicants-mcp
npm install
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the MCP server from source over stdio (tsx). Point Claude Desktop / Claude Code at it, or drive it with an MCP client. |
| `npm test` | Build, then run the unit tests and the stdio smoke test (`test/stdio-smoke.test.ts` spawns `dist/index.js` exactly like Claude Desktop does). No browser, no LinkedIn. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run typecheck` | `tsc --noEmit` with the strict settings from `tsconfig.json`. |
| `npm run build` | Compile `src/` to `dist/`. |
| `npm run dashboard` | Local read-only dashboard of the SQLite data on `http://127.0.0.1:4173`. Never touches LinkedIn. |
| `npm run worker` | Run the queue worker in a standalone process (for overnight runs without Claude Desktop). |
| `npm run login` | Open the dedicated Chrome profile so you can sign in to LinkedIn by hand. |

Configuration is by environment variables; see [.env.example](.env.example). For development you will usually
want `LINKEDIN_MCP_LOG_LEVEL=debug` and a throwaway `LINKEDIN_MCP_DATA_DIR`.

## How the code is organised

```
src/
  index.ts              stdio entry point (what Claude spawns)
  server.ts             builds the McpServer and registers tools and prompts
  bootstrap.ts          data directory, database, config wiring
  config.ts             environment variables -> typed config
  types.ts              shared domain types (Job, Applicant, Task, ...)
  browser/              driving Chrome
    session.ts          launches / attaches to the user's Chrome (persistent or cdp mode), owner lock
    humanize.ts         Bezier mouse paths, uneven scrolling, typing rhythm, log-normal delays
    checkpoint.ts       detects verification / "unusual activity" / login pages
    capture.ts          records the JSON responses LinkedIn's own web app fetches
  linkedin/             reading LinkedIn pages (no writes)
    selectors.ts        EVERY selector, as ordered candidate lists, for both DOM generations
    dom.ts              generic helpers: first matching selector, scroll-until-stable, text extraction
    urls.ts             URL builders and parsers for the hiring dashboard and profiles
    jobs.ts             posted-jobs page -> Job records
    applicants.ts       applicant list (legacy per-bucket pagination and the 2026 Hiring Pro list)
    application.ts      single application page: contact info, screening answers, rating, resume file
    profile.ts          full profile (page text and/or one in-page Voyager request)
    voyager.ts          parsing of LinkedIn's internal profile API payload
    context.ts          scrape context factory shared by the scrapers
  queue/
    scheduler.ts        working hours, daily/hourly caps, warm-up ramp, breaks, back-off
    worker.ts           picks tasks, runs scrapers, persists progress, handles checkpoints
  storage/
    db.ts               SQLite schema and queries (jobs, applicants, tasks, counters, settings, FTS)
    files.ts            on-disk layout under the data directory
    extract.ts          resume text extraction (PDF via unpdf, DOCX via mammoth)
    export.ts           CSV / JSON / JSONL exports
  tools/                MCP tool definitions, one file per group (session, jobs, applicants, data, queue, debug)
  dashboard.ts          the local HTTP dashboard (127.0.0.1 only)
  worker-cli.ts         standalone worker process
test/                   vitest unit tests + stdio smoke test
scripts/                login helper, Chrome launcher for cdp mode, postinstall notice
docs/research/          the verified research behind URL patterns, selectors, Voyager endpoints and pacing
```

Three ideas run through the whole codebase:

- **Two DOM generations.** LinkedIn currently serves two front-ends side by side: the legacy Ember/artdeco
  markup with stable BEM class names, and the new server-driven UI (SDUI / React Server Components) with hashed
  class names where only `data-view-name`, `componentkey`, `aria-label`, `role` and visible text survive
  deploys. `detectGeneration()` decides which one a page is, and every scraper reads `SEL[generation]` from
  `src/linkedin/selectors.ts`. Selectors are *ordered candidate lists*; text-based fallbacks come last.
- **Raw snapshots.** Every scraper stores the raw page text, links and captured network payloads next to the
  parsed data (`raw-*.json`). Parsers are pure functions over that raw material, so when LinkedIn changes
  something you can fix the parser offline and re-parse without touching LinkedIn again.
- **Everything that touches LinkedIn is a queued task.** Tools only enqueue; the worker browses, paced by the
  scheduler. Keep it that way: no new tool should perform LinkedIn page actions synchronously.

## When LinkedIn changes its markup

This is the most common failure mode ("Could not find applicant cards", `stoppedEarly`, empty contact info,
three failures in a row triggering a cool-down). The workflow:

1. **Pause** the queue (`queue_pause`) so the worker stops retrying.
2. **Snapshot** the failing page with `debug_snapshot` (optionally `debug_navigate` there first, linkedin.com
   only). You get a screenshot (`page.png`), the HTML (`page.html`), the visible text (`page.txt`) and the
   captured network payloads under `<data>/debug/<timestamp>-<name>/`. Work out which generation you are
   looking at: stable `hiring-applicants__*` / `artdeco-*` class names mean `legacy`; hashed class names with
   `data-view-name` attributes mean `sdui` (the `LEGACY_MARKERS` list in `selectors.ts` is what the detector
   checks).
3. **Find** a selector that works with `debug_find` (it reports match count and sample text for a CSS or text
   selector on the live page). Prefer, in this order: `data-view-name` / `componentkey` / `aria-label` / `role`
   attributes, then structural relations (an anchor whose `href` matches `/hiring/applicants/...`), then visible
   text. Never rely on hashed SDUI class names; they change every deploy.
4. **Look at the data LinkedIn fetched** with `debug_captures` when the DOM is hostile; often the page already
   holds a JSON payload with exactly the fields you need.
5. **Try interactions** with `debug_click` (for example the "Contact" button, the ratings filter, a page
   button) before encoding them in a scraper.
6. **Update `src/linkedin/selectors.ts`.** Add the new candidate at the front of the list for the affected
   generation; keep the old candidates behind it unless you have confirmed they are gone. Add a one-line
   comment with the date you verified it live (see existing comments such as "verified 2026-09-25").
7. **Add a fixture-based test.** Copy the *text* or the *minimal HTML fragment* that the parser needs into a
   test in `test/`, with all names, companies, locations and ids replaced by fictional ones, and assert the
   parsed result. Parsers are pure functions (`parseJobCardText`, `parseApplicantCardText`, `parseProRowText`,
   `parseDetailHeaderText`, `parseScreeningText`, ...) precisely so this is easy. Never commit a raw snapshot from your data directory.
8. If you learned something about LinkedIn's URLs, parameters or endpoints, write it down in
   `docs/research/` so the next person does not have to rediscover it.

## Tests

- Vitest, `test/**/*.test.ts`. Run `npm test` (builds first because the smoke test needs `dist/`).
- Tests must be deterministic and offline: no network, no Chrome, no wall-clock dependence (inject clocks and
  random sources as the scheduler and worker tests do).
- The stdio smoke test spawns the built server with a temporary data directory and checks the tool list and
  the tools that work without a browser. If you add or rename a tool, update `EXPECTED_TOOLS` there.
- Fixtures contain fictional people only. If a test needs realistic text, invent it.

## Commit style

- One logical change per commit, with a short imperative subject line (<= 72 characters) that names the area
  first when it helps, in the style of the existing history: `Hiring Pro list: resume via start= URL offset`,
  `Fix applied-date parsing guards`.
- Explain *why* in the body when it is not obvious, especially for pacing or selector changes (what you saw on
  LinkedIn, on which date, in which generation).
- Reference issues with `Fixes #123` / `Refs #123`.

## Pull requests

Before opening a PR, please make sure that:

- `npm run typecheck`, `npm run build` and `npm test` pass locally (CI runs them on Node 22, 24 and 26).
- The change is read-only on LinkedIn and does not loosen the pacing defaults.
- No real applicant data, screenshots of real applicants, raw snapshots or anything else from your data
  directory is included; fixtures use fictional names.
- New selectors are covered by a fixture-based test and dated in `selectors.ts`.
- The README, `.env.example` and `CHANGELOG.md` ("Unreleased" section) are updated if behaviour or
  configuration changed.
- The PR description says which LinkedIn dashboard(s) you verified against (legacy / Hiring Pro) and when.

Small, focused PRs are reviewed faster. If you plan a larger change, open an issue first so we can agree on
the approach.

## Reporting problems

- LinkedIn markup changes and other bugs: use the issue templates. Remove applicant names and any other
  personal data from logs and snapshots before attaching them.
- Security issues: see [SECURITY.md](SECURITY.md). Please do not open a public issue for those.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE) that covers
the project.
