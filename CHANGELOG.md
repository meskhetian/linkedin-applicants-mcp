# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, minor versions may contain breaking
changes; they are called out explicitly.

## [Unreleased]

### Fixed

- **A worker that ran for days got slower every hour.** The passive network capture lives as long as the browser
  session and kept up to 400 responses of up to 4 MB each (LinkedIn's hiring pages are about 4 MB), plus a parsed
  copy of every JSON body. After three days the worker held 4.5 GB and an application fetch took about 3 minutes
  instead of 1 at the same pace, as garbage collection struggled. The capture now has a total budget (96 MB by
  default, `maxTotalBytes`) and drops the oldest bodies first.
- The dashboard said "working: fetch_application" while the worker was idle. The note naming the current task was
  only cleared after the pause that follows a task, so a worker killed during that pause (Claude Desktop quitting
  with the worker in one of its terminal tabs) left it behind, and the next worker never cleared it. The note is now
  cleared as soon as a task's work ends and whenever a worker takes over the queue.
- **Profiles of strong candidates were never fetched.** A profile visit queued after an application (the
  `includeProfile` chain) got the default profile priority, 40, below every remaining application (50 to 79 with fit
  ordering). Profiles therefore only ran on days the application cap was used up, and with hundreds of applications
  queued that did not happen for days. The chained profile now keeps its application's priority, so a top candidate's
  profile follows soon after their application.
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
- A lost internet connection (DNS or network errors from Chrome) no longer counts as task failures or triggers the
  "LinkedIn markup may have changed" cool-down: the task is requeued and the worker waits a few minutes.
- List syncs and sweeps remember their offset after every page, so a failure in the middle of a chunk resumes from
  that page instead of the chunk's first page.
- **The table sweep never ran on its own.** It was queued from inside the list task that was still running, and the
  two shared a deduplication key, so the queue refused it every time while the log and the dashboard claimed a
  sweep was pending. Sweeps have their own key now, the queue's answer is checked before anything is announced, and a
  test runs the production list runner against a stub crawl to prove the sweep lands in the queue.
- A task cancelled while it ran could come back: a later failure of the same task put it back to pending, and a
  normal finish marked it done. Both now leave it cancelled, and a cancelled application fetch queues no profile.
- The sweep stored LinkedIn's table match label ("Not a fit", "Maybe") as the recruiter's rating, so recovered
  applicants looked rejected although nobody had rated them. The label stays in the raw data only; rows stored that
  way are repaired at the next start (`npm run reparse` does it by hand).
- The sweep could store a row under another applicant's id: the network fallback took the first id it saw in any
  response, which for the table page is the first row of the page, and the clipboard was read even when nothing had
  been copied. The clipboard is read first and only when its text changed, a response only counts when it names
  exactly one application, ids of another job are refused, and an id that is already stored is never written again
  (a row is only opened because no stored applicant carries its name). Two applicants sharing a name are now both
  found: a row is opened when the page shows more rows with that name than the job has stored, and names compare
  with Unicode case folding instead of SQLite's ASCII `lower()`.
- Inside the sweep, a LinkedIn checkpoint, a lost browser or a cancellation was logged as a failed row and the sweep
  went on; these now end the sweep at once so the queue pauses as it does everywhere else.
- **The sweep opened drawers outside the pacing rules.** Every unmatched table row is an application view, yet a
  whole chunk (up to 12 pages) was one scheduler action: the daily applicant cap, the hourly cap, working hours,
  breaks and `queue_cancel` were not consulted between rows. Each row now goes through the same checks as an
  application fetch and is counted as one; a chunk that hits a cap or the end of the day is deferred and resumes on
  the same page (recovered rows are not opened again). Lists stored below 80 percent of LinkedIn's count are not
  swept at all, since that gap is a broken crawl rather than display ties.
- The sweep reloaded the table page before every row and clicked the row by its old position in the page, which any
  focusable element rendered before it could shift (the click could land on another control). It now closes the
  drawer like a person does and clicks the next row, finds the row again by its content and checks the element's
  text right before clicking, reloads only when the drawer will not close or shows someone else, and pauses after the
  drawer opens and after the Share menu appears. The Share button is looked up inside the drawer first, so a
  page-level "Share job" cannot be picked. The clipboard permission is cleared after each read, and the previous
  clipboard content is only written back when it was text (an empty read used to wipe a copied image or file).
  A run that learns no id from three rows stops and retries later instead of cycling through the page.
- A blank or half-rendered table page ended the sweep for good ("not shown by LinkedIn after 1 sweep"). Blank pages
  now follow the list crawl's policy (retried in later runs, given up after three), rows that failed to parse still
  count as rows, and a short page where a full one is expected is read again first.
- A blank list page with no readable total (the first run of a job) marked the list complete with 0 applicants; it now
  takes the same retry path. Blank-page retries wait 20 minutes instead of running back to back.
- Fit-ordered application fetches (priority 50 plus a bonus of up to 34) outranked list syncs and sweeps (80). The
  bonus now tops out at 29, so lists always come first.
- `applicants_sync` with `restart` cancels the job's queued list chunks and sweep first; before, the fresh crawl was
  deduplicated against them and a leftover sweep marked the cleared list complete. A sweep also refuses to run
  without a complete Hiring Pro list to sweep, and the sweep logic ignores legacy lists (no table view there).
- Table rows: names are cleaned like list names (badges, connection degree), a row with title, company and location
  uses the fixed column order instead of guessing, and "Applied on" dates are read day-first when the first number
  is above 12, rejecting impossible dates instead of rolling them into another month.
- Stopping the worker (Ctrl-C, `browser_close`) while a task runs no longer counts as a failed attempt for that task:
  it goes back to the queue untouched. The "Chrome went away unexpectedly" warning no longer fires for the session's
  own shutdown.
- The session logs when Chrome goes away unexpectedly, and a task whose page vanished during the resume step fails
  instead of finishing without a resume, so the retry policy can react.
- Log lines carry host and path of resume URLs only; signed tokens stay in the raw capture next to the file.

### Changed

- LinkedIn "Save to PDF" for profiles is skipped with a warning while Chrome downloads are denied (the option is
  reserved); the structured profile is stored as before.
- Applicant lists ended about 4 to 5 percent short of LinkedIn's count and still read "list complete": LinkedIn's
  date order shifts between page loads, so duplicates on one page displace applicants that never render. A complete
  list that is more than 2 percent short now gets one sweep through LinkedIn's table view in date order (the list
  view ignores sort parameters, the table honours them), matching rows by name and opening only the unknown ones
  to learn their ids; the dashboard shows the remaining gap instead of a bare "complete".
- A Hiring Pro applicant list declared itself complete after a page rendered no cards while the reported total
  said thousands remained (a slow render or a click that landed mid-load). The crawler now waits and reads the
  page again, leaves the list incomplete at that page so the next run retries it with a fresh navigation, and
  only gives up after three runs end on the same blank page.
- `queue_cancel` now also cancels a running task: a list sync stops after its current page, and a cancelled
  task's own requeue no longer brings it back. The tool description and the README say so (they still read
  "pending only").
- The README documents how the sweep reads application ids (Share menu, "Copy application URL", system clipboard
  with the previous text restored) and no longer claims the Hiring Pro list is sorted by applied date.
- Contact details were captured for 3 of 21 applications although the Contact button was present in 20 of them:
  the SDUI button's text content carries hidden helper text, so the exact-text selector missed it. The button is
  now found by its stable data-view-name (with a contains-text fallback that excludes "Contacted"), the popover's
  email link and phone block are read directly, and LinkedIn's own match label ("Top fit", "Not a fit") is stored
  with the application.
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

- **Caps vary like a person's workload.** Each day's application and profile caps and each hour's action cap are
  drawn once between 65 and 100 percent of the configured (ramped) value (67 one day, 43 the next) and fixed for
  that day or hour, so a restart or a second process cannot change today's number. The draw only ever lowers a cap:
  the configured value stays a ceiling, so the documented safe limits hold on every day (a first version drew up to
  35 percent above it, which turned a configured 80 profiles into days of 108). `dailyCapVariance` (also
  `LINKEDIN_MCP_DAILY_CAP_VARIANCE`, `.env.example`) sets the spread; 0 restores exact caps. Multi-day estimates
  use an average day's caps rather than today's single draw, and the seed is stored first-writer-wins so every
  process draws the same numbers. `queue_status`, `pacing_get` and the
  dashboard show today's numbers.
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
