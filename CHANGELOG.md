# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, minor versions may contain breaking
changes; they are called out explicitly.

## [Unreleased]

### Fixed

- **Chrome no longer crashes when a resume is opened.** Google Chrome 154 crashed its browser process
  ("Google Chrome quit unexpectedly") the moment an automation-triggered download started. Resume files are now
  captured passively: Chrome makes every request itself, the worker reads the resume viewer's responses to learn
  the document URL (or the file bytes when the viewer fetches them) and fetches the file from inside the page.
  Nothing is intercepted or replayed, so timing, headers, HTTP cache and TLS fingerprint stay Chrome's own. Downloads are denied at the
  context level (in cdp mode through a browser-level CDP command) and PDFs stay in Chrome's viewer; a stray
  download is cancelled, and if Chrome is still lost during an application fetch the
  retry captures the details without the resume and records why. `applicants_fetch_details` with its defaults now
  also targets applicants whose resume is still missing.
- The crash is a known Chromium 152 to 154 issue (microsoft/playwright#42506, MicrosoftEdge/DevTools#461): once a
  profile holds download history, any download start over the DevTools pipe crashes the browser process, and a
  denied download still creates the download item. Before every launch the session now clears the `downloads`
  tables of the profile's History database (nothing else is touched), so the trigger is gone even if a download
  slips through. Links that carry a `download` attribute bypass request interception, so they are fetched, never
  clicked.
- Launch refuses to start when another live process holds the profile's SingletonLock, with a message naming the
  pid, instead of two Chromes closing each other.
- A task type that reached its daily cap no longer blocks the other types: applications capped for today used to
  sit at the top of the queue and starve the profile tasks that still had quota. The worker now skips capped types
  and only idles when nothing at all can run.
- The passive capture never waits on streaming responses (LinkedIn keeps a realtime event stream open) and bounds
  every body read, so an application fetch cannot stall on the resume step.
- The session logs when Chrome goes away unexpectedly, and a task whose page vanished during the resume step fails
  instead of finishing without a resume, so the retry policy can react.
- Log lines carry host and path of resume URLs only; signed tokens stay in the raw capture next to the file.

### Changed

- LinkedIn "Save to PDF" for profiles is skipped with a warning while Chrome downloads are denied (the option is
  reserved); the structured profile is stored as before.
- Hiring Pro application details: the detail pane is now isolated as the whole block from the applicant header
  down to "View full profile" instead of the header card alone, so the Contact button, the Qualifications section
  and the experience summary are read. Contact popovers without ARIA roles are captured by diffing the page text,
  the Qualifications section is stored with the application, and a failed resume download records what the page
  showed (tabs, dialogs, frames, file-like requests) for offline debugging.
- Debug tools refuse to launch Chrome while another process owns the queue, because two Chromes on one profile
  close each other.
- Applicant names no longer carry LinkedIn's badge text ("Jane Doe, new applicant", "Jane Doe is open to work"),
  and the headline of those rows is no longer "Jane Doe at <headline>". The badge now sets the viewed flag
  (unopened applications) and an `openToWork` marker in the raw row data. Rows stored by earlier versions are
  re-parsed automatically the first time the server, worker or dashboard starts.

### Added

- README: what LinkedIn actually limits (documented versus folklore), a concrete pacing plan for a job with about
  1,000 applicants, and the warning signs with the response to each.
- `applicants_fetch_details` fetches the applicants who match the job's must-have qualifications best first
  (`orderByFit`, on by default, from the counters LinkedIn shows on the list card), and `profileMinMustHave` limits
  profile visits to strong matches so a long queue spends its daily budget where it matters. The others still get
  details and resume; their profiles can be queued later with `applicants_fetch_profiles`.
- `npm run reparse [jobId]` re-runs the current parsers over the raw card text kept with every stored row,
  without touching LinkedIn.

## [0.1.0] - 2026-09-26

Initial public release.

### Added

- **MCP server over stdio** (`dist/index.js`) for Claude Desktop, Claude Code and any MCP client, with tools
  for session, jobs, applicants, local data, queue/pacing and debugging, plus a `review_applicants` prompt.
- **Drives the user's own installed Google Chrome** through [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)
  in a dedicated profile: `persistent` mode (launch Chrome, visible window, real fingerprint) and `cdp` mode
  (attach to a Chrome started with `scripts/launch-chrome.sh`). Never headless, never downloads a browser,
  never types credentials: the user signs in by hand (`npm run login` / `browser_open_login`).
- **Posted-jobs crawl** (`jobs_sync`, `jobs_list`) over every `jobState=` tab including Closed, with
  applicant counts, status and dates parsed from the 2026 card layout and the legacy layout.
- **Applicant-list crawl** (`applicants_sync`) supporting both LinkedIn hiring dashboards: the classic list
  (25 per page, crawled per rating bucket including the hidden *Not a fit*, sorted by applied date) and the
  2026 "Hiring Pro" list (`rating=ALL&sort=DateApplied`, numbered pages, resumable via `start=` offsets).
  Progress is saved after every page; rows are deduplicated by application id.
- **Application details** (`applicants_fetch_details`): contact email/phone when shared, screening-question
  answers, your rating, and the resume file (PDF/DOCX) including popup-based downloads, with text extraction
  (unpdf / mammoth) into a full-text-searchable SQLite index.
- **Full profiles** (`applicants_fetch_profiles`, or chained after details): about, experience, education,
  skills, certifications, languages, projects, honors. `LINKEDIN_MCP_PROFILE_STRATEGY` = `auto` (visit like a
  person, then one in-page Voyager request), `voyager` or `dom` (page text only).
- **Raw snapshots** next to every parsed record (`raw-*.json`, list pages, captured JSON) so parsers can be
  fixed and re-run offline after LinkedIn changes its markup.
- **Human-like pacing**: working hours and days (with per-day jitter, IANA time zone), daily caps for
  application pages and profile views with a warm-up ramp, hourly action cap, random long breaks, log-normal
  delays, shuffled task order, occasional feed visits, Bezier mouse paths, uneven scrolling and variable typing
  rhythm. `slow` / `normal` / `brisk` speed presets; runtime overrides with `pacing_set` (persisted).
- **Resumable SQLite-backed queue** with `queue_status` (counts, today's usage vs caps, working-hours state,
  next eligible time, per-job list progress, checkpoints), `queue_start` / `pause` / `resume` / `cancel` /
  `retry_failed` / `tasks`, and a single-owner lock so the MCP server and the standalone worker
  (`npm run worker`) never drive the browser at the same time.
- **Checkpoint handling**: verification / unusual-activity / login pages stop the worker, requeue without
  burning an attempt and report `needsHuman`; HTTP 429/999 back off for hours; three consecutive unexpected
  failures trigger a cool-down.
- **Local data tools**: `applicants_list` (filters + full-text search), `applicant_get`, `resume_text`,
  `applicants_export` (CSV / JSON / JSONL). Instant, no LinkedIn traffic.
- **Local dashboard** (`npm run dashboard`, `127.0.0.1:4173` only): jobs, progress meters, applicant table,
  detail drawer, exports.
- **Debug tools** for when LinkedIn changes: `debug_snapshot`, `debug_navigate` (linkedin.com only),
  `debug_page_text`, `debug_find`, `debug_click`, `debug_captures`.
- **Two DOM generations** (legacy Ember/artdeco and the 2026 SDUI / Hiring Pro UI) handled through a single
  selector map (`src/linkedin/selectors.ts`) with runtime generation detection.
- Data directory (`~/.linkedin-applicants-mcp`, `LINKEDIN_MCP_DATA_DIR`) created with owner-only permissions;
  JSON-lines logs; all configuration via `LINKEDIN_MCP_*` environment variables (see `.env.example`).
- Unit tests and a stdio smoke test that spawns the built server (no browser, no LinkedIn); research notes
  under `docs/research/`.

[Unreleased]: https://github.com/meskhetian/linkedin-applicants-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/meskhetian/linkedin-applicants-mcp/releases/tag/v0.1.0
