# Research notes (2026-09-25, auto-collected; verify before relying on any single claim)

## Follow-up: 

### Summary

Short answer: as of Sept 2026 there are TWO coexisting applicant-list UIs and the worker must detect which one it lands on.

(1) LEGACY Ember UI at /hiring/jobs/<jobId>/applicants/ (still being linked as late as 2026-07-07 per Wayback): 25 applicants per page; the offset IS a URL query param `start=N` (observed `&start=0`, `&start=25` in 2024-02 notebook output, 2025-01, 2025-04 `?noShare=true&start=0`, and 2026-01 `?sort_by=APPLIED_DATE&start=25`), rendered with artdeco pagination (`button[aria-label="Page N"]`, `li.artdeco-pagination__indicator--number`, `.artdeco-pagination__button--next`). Within a page the 25 cards can render lazily, so wait until 25 `li.hiring-applicants__list-item a[href*="/detail/"]` exist (or the Next button is disabled) before reading. The ratings filter is LinkedIn's own `r=` param with exactly the same tokens Unipile mirrors: default URL is `?r=UNRATED%2CGOOD_FIT%2CMAYBE` (NOT_A_FIT omitted = hidden). Single-value forms `r=UNRATED`, `r=GOOD_FIT` are seen in the wild, so the safest complete crawl is four per-bucket passes (`r=GOOD_FIT`, `r=MAYBE`, `r=UNRATED`, `r=NOT_A_FIT`) unioned by applicationId; or one pass with `r=UNRATED%2CGOOD_FIT%2CMAYBE%2CNOT_A_FIT` (token names certain, 4-value acceptance not directly observed). Sort param is `sort_by=RELEVANCE|APPLIED_DATE`. The applicationId is an 11-digit numeric in the PATH: /hiring/jobs/<jobId>/applicants/<applicationId>/detail/ (e.g. <applicationId> in 2024; 389xxxxxxxx in 2026).

(2) NEW "Hiring Pro" SDUI UI, first archived 2026-07-23: URL shape is /hiring/applicants/?jobId=<jobId>&applicationId=<applicationId>&rating=ALL, i.e. the applicationId moved to a QUERY param and the rating filter is `rating=` (only value observed: ALL). The only exporter that works on it (Liwin-liwi, pushed 2026-09-22) describes the list as "infinite scroll and 'Show more'", uses no class names (rows found by the literal text "Applied on:" and header columns Name/Title/Company/Location/Qualifications), and warns that a "Top fit" filter is on by default ("Switch from Top fit to all applicants first if you want the full list"). No `start=` has ever been observed on this shape, so a `?start=` loop there will refetch page 1 forever, exactly the failure the question anticipated.

Authoritative total count: no public code reads a header total in either UI. Legacy scrapers derive it from the last pagination number (`ul.artdeco-pagination__pages--number span` last / `li.artdeco-pagination__indicator--number` last). LinkedIn's backend does return a total (Unipile exposes `total_count` over the same data), so the robust approach is to intercept the XHR/GraphQL JSON behind the list (`page.on('response')`, match `/voyager/api/` responses whose body has `paging.total` and whose URL mentions job application/hiring) and record `expected_total` per (job, rating bucket); fall back to a header-text regex `/(\d[\d,]*)\s+applicants?/i` and, in the new UI, to Liwin-liwi's idle-stop heuristic (stop after 3 consecutive rounds with no new rows and no Show-more/Next control).

"Not a fit" checkbox: LinkedIn Help (a517574 and a517731) says "go to the Ratings dropdown filter and click the Not a fit checkbox"; no class-name selector is documented anywhere, so use role/label selectors (`getByRole('button',{name:/ratings?/i})` then `getByRole('checkbox',{name:/not a fit/i})`). Note LinkedIn auto-rates out-of-country applicants Not a fit by default and "Not a fit automations" email rejections after 3 days (a521538), so this bucket can be large and the worker must never change ratings.

Idempotency key: use the numeric applicationId, extracted with a regex that accepts both shapes: path `/applicants/(\d{6,})/detail` and query `[?&]applicationId=(\d{6,})`. The 2026 query-param IDs continue the same monotonic numeric sequence as the 2024 path IDs, so they are the same identifier space.

### Facts

- [high] Feb 2024 legacy UI: LinkedIn itself generated applicant URLs of the form https://www.linkedin.com/hiring/jobs/<jobId>/applicants/<applicationId>/detail/?r=UNRATED%2CGOOD_FIT%2CMAYBE&start=0 and .../applicants/<applicationId>/detail/?r=UNRATED%2CGOOD_FIT%2CMAYBE&start=25 (stored notebook output; scraper appended &start={i*25} and read total pages from the last `ul.artdeco-pagination__pages--number span`).  <https://raw.githubusercontent.com/manjuq/LinkedIn-Job-Applicant-Scraper/main/LinkedIn_scraper.ipynb>
- [high] manjuq scraper (commits 2024-02-22/23) reached the applicants list for CLOSED jobs via https://www.linkedin.com/my-items/posted-jobs/?jobState=CLOSED -> /hiring/jobs/<id>/detail/ -> clicking the 'View applicants' span; resume link found under the detail 'More' dropdown (`artdeco-dropdown__item artdeco-dropdown__item--is-dropdown ember-view p0`) or `ui-attachment ui-attachment--doc`.  <https://github.com/manjuq/LinkedIn-Job-Applicant-Scraper>
- [high] Wayback CDX captures of LinkedIn's own legacy URLs show the `r=` ratings param and `start=` offset in use from 2025-01 through 2026-07: e.g. .../applicants/<APP>/detail/?keyword=&r=UNRATED%2CGOOD_FIT&start=25 (2025-01), /applicants/?noShare=true&start=0 (2025-04), /applicants/?r=UNRATED%2CGOOD_FIT%2CMAYBE (2025-05, 2025-08), .../detail/?sort_by=APPLIED_DATE&start=25 (2026-01-09), .../detail/?r=UNRATED,GOOD_FIT,MAYBE (2026-02-07), .../detail/?r=UNRATED&sort_by=RELEVANCE (2026-07-07). Values seen for r=: UNRATED, GOOD_FIT, UNRATED,GOOD_FIT, UNRATED,GOOD_FIT,MAYBE; for sort_by: RELEVANCE, APPLIED_DATE.  <http://web.archive.org/cdx/search/cdx?url=linkedin.com/hiring/jobs/*&output=txt&fl=timestamp,original,statuscode&filter=original:.*applicants.*&from=2025>
- [high] A NEW URL shape first appears in the Wayback index on 2026-07-23 (three captures, HTTP 307 to login): https://www.linkedin.com/hiring/applicants/?applicationId=<applicationId>&rating=ALL&jobId=<jobId> (also param order rating=ALL&applicationId=...&jobId=...). This is the '2026 SDUI hint', applicationId is a query param there, not a path segment. No `start=` param has been observed on this shape.  <http://web.archive.org/cdx/search/cdx?url=linkedin.com/hiring/applicants*&output=txt&fl=timestamp,original,statuscode&from=2024>
- [medium] Both URL shapes coexist in mid-2026: legacy /hiring/jobs/<JOB>/applicants/<APP>/detail/?r=UNRATED&sort_by=RELEVANCE captured 2026-07-07 and new /hiring/applicants/?jobId=...&applicationId=... captured 2026-07-23. Archived redirects for the legacy shape go to /uas/login?session_redirect=<same legacy URL>, i.e. no server-side migration redirect to the new shape is visible.  <http://web.archive.org/cdx/search/cdx?url=linkedin.com/hiring/jobs/*&output=txt&fl=timestamp,original,statuscode&filter=original:.*applicants.*&from=2026>
- [medium] applicationId values are 11-digit numerics in a monotonically increasing sequence across both shapes (two Feb-2024 ids in the ~1.5e10–1.9e10 range; three Jul-2026 ids in the ~3.89e10 range), consistent with one job-application id space.  <http://web.archive.org/cdx/search/cdx?url=linkedin.com/hiring/applicants*&output=txt&fl=timestamp,original&from=2024>
- [high] Liwin-liwi/Linkedin-Filter-ChromeExtension v1.2.0 (created and pushed 2026-09-22) is the only Sept-2026 working hirer-side exporter found. README: 'Reads every applicant in the Hiring Pro list, including infinite scroll and "Show more"'; 'Open your job's applicant list in LinkedIn (the Hiring Pro screen)'; 'Set the list filter. Top fit only covers the top fit applicants. Switch to all applicants if you want everyone checked.'; 'The extension uses no LinkedIn class names. It finds applicant rows by their "Applied on:" text and maps columns by the position of the table headers'. Header labels: Name, Title, Company, Location, Qualifications.  <https://github.com/Liwin-liwi/Linkedin-Filter-ChromeExtension>
- [high] Liwin-liwi content.js paging logic: scrolls the nearest overflow container (or window) in 80%-viewport steps, then looks for a visible control below the last row whose text/aria-label matches /^(next|next page|load more|show more|show more results|show more applicants|show more candidates|see more applicants|see more candidates|view more applicants|view more candidates)$/i, clicks it with synthesized pointer/mouse events, waits ~2.5s with jitter, and stops after 3 idle rounds. It never uses `start=`, URLSearchParams, or `button[aria-label="Page N"]`. Rows are deduped by name|appliedOn (it does not read applicationId or a total count).  <https://raw.githubusercontent.com/Liwin-liwi/Linkedin-Filter-ChromeExtension/main/content.js>
- [high] Liwin-liwi opens the applicant detail by clicking the name/neutral text in the row and then locates the detail as a [role=dialog]/[aria-modal], a side panel, an inline expansion, or a full navigation (location.href changed, closed with history.back()), i.e. the 2026 UI may change the URL when a row is opened; it reveals contact info by clicking buttons labelled like 'contact'/'more', reads mailto:/tel: links, and takes the first a[href*="/in/"] as profile URL. Its NOISE_RE ignores row texts 'resume' / 'view resume', implying a 'View resume' affordance exists on rows.  <https://raw.githubusercontent.com/Liwin-liwi/Linkedin-Filter-ChromeExtension/main/content.js>
- [high] arielsegura/linkedin-applicant-exporter (single commit 2025-07-08; manifest matches https://www.linkedin.com/hiring/jobs/*) paginates the legacy UI by clicking `button[aria-label="Page ${n}"]`, derives totalPages = max of /Page (\d+)/ over `button[aria-label*="Page"]`, verifies with `button[aria-current="true"][aria-label*="Page"]`, falls back to `.artdeco-pagination__button--next:not([disabled])`, waits 5000 ms after each click; cards are `.hiring-applicants__list-item`, name `.hiring-people-card__title`, applied-time `.hiring-applicant-insights__separator`, detail link = card's first <a> href. It does not use `start=`, does not scroll, and does not read a header total.  <https://raw.githubusercontent.com/arielsegura/linkedin-applicant-exporter/main/content.js>
- [high] ist00dent/linkedin-candidate-scraper v1.0.0 (2025-06-29/30) hard-codes maxCandidatesPerPage = 25, waits until 25 `.hiring-applicants__list-item a[href*="/detail/"]` links exist (scrolling `.hiring-applicants__list` container to bottom every 500 ms, max 10 s) whenever `.artdeco-pagination__button--next` is enabled; next page via `.artdeco-pagination__button--next:not([disabled]):not([aria-disabled="true"])` or `li.artdeco-pagination__indicator--next button`; active page via `.artdeco-pagination__indicator.active.selected`; detail pane root `#hiring-detail-root`, applied date `.hiring-applicant-header__tidbit`, dismiss via `button[aria-label="Dismiss"]`/`.artdeco-modal__dismiss`. Confirms per-card hrefs contain '/detail/' (path-style applicationId) as of mid-2025.  <https://raw.githubusercontent.com/ist00dent/linkedin-candidate-scraper/main/src/js/content.js>
- [high] lucasudar/linkedin_applicants_scraper (2024-12-13..23) reads total pages from the last `li.artdeco-pagination__indicator.artdeco-pagination__indicator--number.ember-view` (`button span` text), pages with `//button[@aria-label="Page N"]`, and, per commit 'Remove query parameters from URL to prevent filtering', navigates to `current_url.split('/?')[0]` (drops `?r=...`) so the list is not restricted by the default ratings filter. Detail header selector `.hiring-applicant-header h1`; contact info under `hiring-applicant-header-actions__more-content-dropdown-item-info`.  <https://raw.githubusercontent.com/lucasudar/linkedin_applicants_scraper/master/src/main.py>
- [high] bilalsaci/LinkedIn-Applicant-Anonymizer (2024-10-30) manifest content_script match is exactly https://www.linkedin.com/hiring/jobs/*/applicants/* and it targets `.hiring-selectable-entity > img`, `.hiring-people-card__title`, `.hiring-applicant-header h1`, corroborating the legacy path and class names in late 2024.  <https://github.com/bilalsaci/LinkedIn-Applicant-Anonymizer>
- [high] LinkedIn Help 'Reviewing job applicants' (a517574, 'last updated 1 year ago' as of Sept 2026): 'To view all applicants, go to the Ratings dropdown filter and click the Not a fit checkbox.' It also states: 'For online job postings, bulk downloading or exporting applicant profiles is not available.'  <https://www.linkedin.com/help/linkedin/answer/a517574>
- [high] LinkedIn Help 'Reject applicants on your LinkedIn job post' (a517731, updated ~2 years ago): reject = 'Rate as' -> 'Not a fit'; Not-a-fit applicants are hidden from the list until the Ratings dropdown 'Not a fit' checkbox is ticked; 'Not a fit automations' send rejection emails after three days.  <https://www.linkedin.com/help/linkedin/answer/a517731>
- [high] LinkedIn Help 'Automate sending rejection messages' (a521538, updated ~5 months ago as of Sept 2026): 'By default, applicants outside your selected country are tagged Not a fit'; rejected applicants are notified three calendar days after applying; setting lives under Manage job > Settings (free jobs) or job settings in the post editor (promoted jobs). Implication: the hidden Not-a-fit bucket can be large, and programmatic rating changes could trigger emails.  <https://www.linkedin.com/help/linkedin/answer/a521538>
- [high] Unipile's proxied endpoint GET /api/v1/linkedin/jobs/{id}/applicants documents `ratings` as 'One or more ratings (UNRATED, GOOD_FIT, MAYBE, NOT_A_FIT) separated by commas' (Classic job postings only), `sort_by` = relevance|alphabetical|newest_first|screening_requirements (Recruiter only), `limit` 1-100 (default 10), `cursor` pagination, and response metadata `total_count` ('total applicants available'), `page_count`, `cursor`. These rating tokens are identical to LinkedIn's own `r=` URL tokens.  <https://developer.unipile.com/reference/linkedincontroller_getjobapplicants>
- [high] Unipile also exposes GET /api/v1/linkedin/jobs/applicants/{applicant_id} (Classic only; response has no resume URL field) and GET /api/v1/linkedin/jobs/applicants/{applicant_id}/resume returning binary (string/format binary) with `service=CLASSIC|RECRUITER`; applicant_id format is undocumented (no examples).  <https://developer.unipile.com/reference/linkedincontroller_getjobapplicantresume.md>
- [medium] LinkedIn 'Hiring Pro' (business.linkedin.com) is the SMB job-post product that 'Quickly presorts applicants based on your criteria, surfacing best fits' and 'Delivers instant candidate summaries'; 'currently available to English-speaking LinkedIn members'; free and Promoted tiers. This is the product whose applicant list Liwin-liwi calls 'the Hiring Pro list' with a 'Top fit' default filter.  <https://business.linkedin.com/talent-solutions/hiring-pro>
- [medium] Chrome Web Store 'LinkedIn Job Applicants Exporter – Local, No Login, CSV/Sheets' v0.5.4 (updated 2026-02-24, by joinus.team) works from a side panel that 'auto-extracts each candidate' on 'any LinkedIn Job Applications page'; its store text gives no pagination details and no 'Not a fit'/resume handling; the promised GitHub source was not locatable.  <https://chromewebstore.google.com/detail/linkedin-job-applicants-e/gpncmkeondkmbbchjekdilncigiphljb>
- [high] a third-party LinkedIn MCP server (the reference MCP named in the user request) exposes ~20 tools built on FastMCP + Patchright and has NO hirer-side tools (no posted-jobs, applicants, or hiring-dashboard functionality); its Sept-2026 issue #1057 concerns the job-seeker /jobs-tracker/ page only.  (source omitted)
- [high] LinkedIn Engineering (2020-10-28) describes the hirer applicant-management surface as a two-pane desktop interface with ratings Good Fit / Maybe / Not a Fit replacing pipeline stages, an inline resume viewer, and automations for Not-a-Fit emails, the architecture of the legacy UI that the 2024-2025 scrapers target.  <https://www.linkedin.com/blog/engineering/hiring/the-new-linkedin-jobs-experience>
- [low] No public source (GitHub code, Wayback, help docs) shows `start=` on the new /hiring/applicants/?jobId= shape, nor any `rating=` value other than ALL, nor a header-total selector for either UI. The Voyager endpoint name commonly cited for the legacy list (voyagerHiringDashJobApplications with paging.total) could not be verified online in this session and should be treated as a hypothesis to confirm via network capture.  <>

### Recommendations

- Detect the UI variant on every job before crawling and persist it in SQLite (jobs.ui_variant = 'legacy' | 'hiring_pro'): navigate to https://www.linkedin.com/hiring/jobs/<jobId>/applicants/, wait ~3 s, then (a) if location.pathname starts with /hiring/applicants/ or the URL has jobId=, or the DOM has rows containing the literal text 'Applied on:' with no `.artdeco-pagination` -> hiring_pro; (b) if `li.hiring-applicants__list-item` exists -> legacy.
- Legacy crawl: build URLs as `/hiring/jobs/<jobId>/applicants/?r=<BUCKET>&sort_by=APPLIED_DATE&start=<N>` with N = 0,25,50,... and verify each load by (1) `button[aria-current="true"][aria-label^="Page"]` == N/25+1 and (2) at least one applicationId not seen before; if either check fails twice, fall back to clicking `button[aria-label="Page ${n}"]` (arielsegura/lucasudar approach). Before reading a page, wait until 25 `li.hiring-applicants__list-item a[href*="/detail/"]` exist or the Next button is disabled (ist00dent's lazy-render guard).
- Include the hidden 'Not a fit' bucket by crawling one rating bucket at a time, r=GOOD_FIT, r=MAYBE, r=UNRATED, r=NOT_A_FIT, and unioning by applicationId (single-value r= is proven in the wild; per-bucket runs also give you per-bucket totals and the applicant's rating for free). Optionally try one combined pass `r=UNRATED%2CGOOD_FIT%2CMAYBE%2CNOT_A_FIT` first and only fall back to per-bucket if its count is lower than the sum. As a UI fallback use role selectors: page.getByRole('button',{name:/ratings?/i}).click(); page.getByRole('checkbox',{name:/not a fit/i}).check(), never rely on class names for this control.
- Hiring Pro crawl: if the page has a 'Top fit' filter active, switch to all applicants first (role/label selector, text 'All applicants' / rating=ALL in URL); then loop: read new rows (rows = elements containing 'Applied on:'), scroll the list's overflow container by ~80% viewport, click any visible control matching /^(next|show more( applicants| results)?|load more|see more applicants|view more applicants)$/i that sits below the last row, sleep 2-4 s with jitter, and stop after 3 consecutive idle rounds (Liwin-liwi's proven loop). Extract applicationId from row anchors (`[?&]applicationId=(\d+)`) or, if rows have no anchors, open the row and read location.search, then history.back().
- Make applicationId the SQLite primary key and extract it with a dual-shape regex (see snippet) so both `/applicants/<id>/detail/` (legacy) and `?applicationId=<id>` (Hiring Pro) map to the same key; store the profile URL and public_identifier as secondary unique-ish columns, not as the key.
- Get the authoritative total from the network, not the DOM: register page.on('response') before navigation, keep JSON responses from /voyager/api/ (REST or GraphQL) whose URL or body mentions jobApplication/hiring and whose body has paging.total; store expected_total per (jobId, bucket). Fall back to the legacy pagination's last page number ×25 (lower bound) or a header regex /(\d[\d,]*)\s+applicants?/i, and flag jobs where unique applicationIds < expected_total so the queue re-crawls them.
- Treat every stop condition as 'no new applicationIds for K rounds' rather than 'reached start=total', this makes the worker immune to `start=` being ignored (Hiring Pro) and to LinkedIn re-sorting between pages; use sort_by=APPLIED_DATE for stable ordering during long crawls.
- Never change ratings or click 'Rate as' while exporting: 'Not a fit automations' email rejections three days later, and LinkedIn already auto-rates out-of-country applicants Not a fit by default (so expect that bucket to be large).
- Pace like the working extensions: 2-5 s between page loads with ±40% jitter, 5 s+ between applicant detail opens, batch profile visits across days (Liwin-liwi notes the monthly profile-view limit), and stop the run if location.pathname matches /\/(authwall|checkpoint|login|uas|signup)\b/ (their BLOCKED_PATH) so the queue can resume later.
- For closed jobs, enter via https://www.linkedin.com/my-items/posted-jobs/?jobState=CLOSED -> /hiring/jobs/<id>/detail/ -> 'View applicants' (worked in 2024); confirm the same list URL is served for closed jobs on this account before relying on direct navigation.
- Resume download: in the legacy detail pane the resume is under the header 'More' dropdown (`artdeco-dropdown__item…`) or a `.ui-attachment.ui-attachment--doc` link; in Hiring Pro rows expose a 'View resume' affordance. Use Playwright's page.waitForEvent('download') / context route on the resulting PDF URL rather than guessing the CDN pattern, and name files by applicationId.

### Open questions

- Which UI does the user's specific company page currently get for /hiring/jobs/<jobId>/applicants/, legacy Ember or the Hiring Pro SDUI? (Wayback shows both in July 2026; rollout may be per-account/region.) Confirm by loading one job in the user's own Chrome and checking the URL shape and presence of .artdeco-pagination.
- Does the Hiring Pro shape honor any offset/paging query param (start=, page=, cursor=)? Nothing observed; all evidence points to infinite scroll + 'Show more'.
- What are the full `rating=` values in the Hiring Pro URL besides ALL (GOOD_FIT/MAYBE/NOT_A_FIT/UNRATED/TOP_FIT?), and is 'Top fit' a rating value or a separate filter param?
- Does the legacy UI accept the 4-value r=UNRATED,GOOD_FIT,MAYBE,NOT_A_FIT in one request, and does a bare URL with no r= (lucasudar's approach) include NOT_A_FIT or just reset to the default three?
- Exact Voyager/GraphQL endpoint and field path for the total count in each UI (hypothesis: legacy voyagerHiringDashJobApplications ... paging.total), verify via network capture on first run.
- Is Unipile's applicant_id the same numeric LinkedIn applicationId (very likely but undocumented)?
- Is the applicant detail in Hiring Pro a dialog, side panel, or full navigation on this account (Liwin-liwi handles all four modes), and does opening it change the URL to include applicationId= (which would be the cheapest id source)?
- Where the Sept-2026 header/total text lives in Hiring Pro (no exporter reads it); whether the 'Manage job posts' list count can serve as a cross-check.

### Snippets

#### Dual-shape applicationId/jobId extraction (SQLite primary key), accepts legacy path and 2026 query-param URLs

```typescript
export function parseApplicantUrl(href: string): { jobId?: string; applicationId?: string; variant: 'legacy' | 'hiring_pro' | 'unknown' } {
  const u = new URL(href, 'https://www.linkedin.com');
  // Legacy (2024–2026): /hiring/jobs/<jobId>/applicants/<applicationId>/detail/?r=...&start=N
  const m = u.pathname.match(/\/hiring\/jobs\/(\d{6,})\/applicants\/(\d{6,})\/detail\/?/);
  if (m) return { jobId: m[1], applicationId: m[2], variant: 'legacy' };
  // Hiring Pro / SDUI (first seen 2026-07): /hiring/applicants/?jobId=...&applicationId=...&rating=ALL
  if (u.pathname.startsWith('/hiring/applicants')) {
    const jobId = u.searchParams.get('jobId') ?? undefined;
    const applicationId = u.searchParams.get('applicationId') ?? undefined;
    if (jobId || applicationId) return { jobId, applicationId, variant: 'hiring_pro' };
  }
  return { variant: 'unknown' };
}
```

#### Legacy list URL builder with LinkedIn's own ratings param (r=) and offset (start=), per-bucket crawl to include hidden Not-a-fit applicants

```typescript
export type Bucket = 'GOOD_FIT' | 'MAYBE' | 'UNRATED' | 'NOT_A_FIT';
export const BUCKETS: Bucket[] = ['GOOD_FIT', 'MAYBE', 'UNRATED', 'NOT_A_FIT'];
export const PAGE_SIZE = 25;

export function legacyListUrl(jobId: string, buckets: Bucket[], start: number) {
  const p = new URLSearchParams();
  p.set('r', buckets.join(','));            // LinkedIn encodes the commas as %2C; both forms observed in the wild
  p.set('sort_by', 'APPLIED_DATE');           // observed values: RELEVANCE, APPLIED_DATE
  p.set('start', String(start));              // observed: start=0, start=25 (25 per page)
  return `https://www.linkedin.com/hiring/jobs/${jobId}/applicants/?${p}`;
}
// default LinkedIn URL is r=UNRATED,GOOD_FIT,MAYBE  -> NOT_A_FIT is hidden unless you add it
```

#### Playwright: detect UI variant, then paginate legacy list via ?start= with verification and Page-N click fallback; stop on 'no new ids'

```typescript
import type { Page } from 'playwright';

async function detectVariant(page: Page): Promise<'legacy' | 'hiring_pro'> {
  if (/^\/hiring\/applicants\b/.test(new URL(page.url()).pathname)) return 'hiring_pro';
  if (await page.locator('li.hiring-applicants__list-item').first().isVisible({ timeout: 4000 }).catch(() => false)) return 'legacy';
  if (await page.getByText(/Applied\s*(on)?\s*:/i).first().isVisible({ timeout: 4000 }).catch(() => false)) return 'hiring_pro';
  throw new Error('Unknown applicants UI at ' + page.url());
}

async function readLegacyPageIds(page: Page): Promise<string[]> {
  // ist00dent guard: cards render lazily; wait for 25 (or Next disabled)
  const nextEnabled = await page.locator('.artdeco-pagination__button--next:not([disabled]):not([aria-disabled="true"])').count() > 0;
  const links = page.locator('li.hiring-applicants__list-item a[href*="/detail/"]');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await links.count()) < (nextEnabled ? 25 : 1)) {
    await page.locator('.hiring-applicants__list').evaluate(el => el.scrollTo(0, el.scrollHeight)).catch(() => {});
    await page.waitForTimeout(500);
  }
  const hrefs = await links.evaluateAll(as => as.map(a => (a as HTMLAnchorElement).href));
  return [...new Set(hrefs.map(h => parseApplicantUrl(h).applicationId).filter(Boolean) as string[])];
}

export async function crawlLegacyBucket(page: Page, jobId: string, bucket: Bucket, seen: Set<string>, sleep: (ms: number) => Promise<void>) {
  for (let start = 0, idle = 0; idle < 2; start += PAGE_SIZE) {
    await page.goto(legacyListUrl(jobId, [bucket], start), { waitUntil: 'domcontentloaded' });
    await sleep(2000 + Math.random() * 2000);
    const expectedPage = start / PAGE_SIZE + 1;
    const cur = await page.locator('button[aria-current="true"][aria-label^="Page"]').getAttribute('aria-label').catch(() => null);
    if (cur && Number(cur.match(/Page (\d+)/)?.[1]) !== expectedPage) {
      // start= not honored -> click the numbered page button instead (arielsegura / lucasudar approach)
      await page.locator(`button[aria-label="Page ${expectedPage}"]`).click();
      await sleep(3000 + Math.random() * 2000);
    }
    const ids = await readLegacyPageIds(page);
    const fresh = ids.filter(id => !seen.has(id));
    fresh.forEach(id => seen.add(id));
    idle = fresh.length ? 0 : idle + 1;  // stop when two consecutive pages add nothing (immune to start= being ignored)
  }
}
```

#### Playwright: capture the authoritative total from the list XHR/GraphQL response (paging.total) instead of the DOM

```typescript
export function attachTotalSniffer(page: Page, onTotal: (info: { url: string; total: number }) => void) {
  page.on('response', async res => {
    const url = res.url();
    if (!/linkedin\.com\/voyager\/api\//.test(url)) return;
    if (!/(jobApplication|hiring|applicant)/i.test(url)) return;
    const ct = res.headers()['content-type'] ?? '';
    if (!ct.includes('json')) return;
    try {
      const body = await res.json();
      // Voyager REST: { paging: { start, count, total }, elements|included: [...] }
      // GraphQL:      { data: { ...: { paging: { total } } } }
      const total = findTotal(body);
      if (typeof total === 'number') onTotal({ url, total });
    } catch { /* not JSON / streamed */ }
  });
}
function findTotal(o: any, depth = 0): number | undefined {
  if (!o || typeof o !== 'object' || depth > 6) return;
  if (o.paging && typeof o.paging.total === 'number') return o.paging.total;
  for (const v of Object.values(o)) { const t = findTotal(v, depth + 1); if (t !== undefined) return t; }
}
```

#### Playwright: include the default-hidden 'Not a fit' bucket via the Ratings dropdown (role/label selectors, LinkedIn Help wording), when URL params are not honored

```typescript
export async function includeNotAFit(page: Page) {
  const ratings = page.getByRole('button', { name: /ratings?/i }).first();
  if (!(await ratings.isVisible().catch(() => false))) return false;
  await ratings.click();
  const cb = page.getByRole('checkbox', { name: /not a fit/i }).first()
    .or(page.getByLabel(/not a fit/i).first());
  await cb.waitFor({ timeout: 5000 });
  if (!(await cb.isChecked())) await cb.check();
  // some variants have an explicit apply/show-results button
  const apply = page.getByRole('button', { name: /^(apply|show results|done)$/i }).first();
  if (await apply.isVisible().catch(() => false)) await apply.click();
  await page.waitForTimeout(2500);
  return true;
}
```

#### Hiring Pro (2026 SDUI) list walker, infinite scroll + 'Show more' + idle-stop, adapted from the only Sept-2026 working exporter (Liwin-liwi)

```typescript
const MORE_RE = /^(next|next page|load more|show more|show more results|show more applicants|show more candidates|see more applicants|see more candidates|view more applicants|view more candidates)$/i;

export async function walkHiringProList(page: Page, onRow: (row: import('playwright').Locator) => Promise<string | null>, sleep: (ms: number) => Promise<void>) {
  const seen = new Set<string>();
  for (let idle = 0, clicks = 0; idle < 3 && clicks < 500;) {
    // rows = smallest ancestors containing exactly one 'Applied on:' text (Liwin-liwi heuristic)
    const rows = page.getByText(/Applied\s*(on)?\s*:/i).locator('xpath=ancestor::*[self::li or self::tr or @role="row" or @role="listitem"][1]');
    let fresh = 0;
    for (const row of await rows.all()) {
      const id = await onRow(row);           // your extractor: anchor href ?applicationId= or open row and read location.search
      if (id && !seen.has(id)) { seen.add(id); fresh++; }
    }
    if (fresh) { idle = 0; continue; }
    await page.mouse.wheel(0, 900);          // scroll (list container or window)
    await sleep(1200);
    const more = page.getByRole('button').filter({ hasText: MORE_RE }).last();
    if (await more.isVisible().catch(() => false)) { await more.click(); clicks++; await sleep(2500 + Math.random() * 1000); }
    idle++;
  }
  return seen;
}
```
