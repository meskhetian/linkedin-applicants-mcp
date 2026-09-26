# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, minor versions may contain breaking
changes; they are called out explicitly.

## [Unreleased]

### Fixed

- Applicant names no longer carry LinkedIn's badge text ("Jane Doe, new applicant", "Jane Doe is open to work"),
  and the headline of those rows is no longer "Jane Doe at <headline>". The badge now sets the viewed flag
  (unopened applications) and an `openToWork` marker in the raw row data. Rows stored by earlier versions are
  re-parsed automatically the first time the server, worker or dashboard starts.

### Added

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
