# Research notes (2026-09-25, auto-collected; verify before relying on any single claim)

## Follow-up: 

### Summary

ANSWER TO THE FOLLOW-UP (how a page admin enumerates all posted jobs and classifies open vs closed):

1) THE PAGE. The management page is https://www.linkedin.com/my-items/posted-jobs/ ("Manage job posts"). LinkedIn's own business site links to it as "Manage Online Job Posts" (https://www.linkedin.com/my-items/posted-jobs/?src=direct%2Fnone&veh=direct%2Fnone) as of 2026-09-25, and every LinkedIn Help article about closing/reposting/editing jobs routes through Jobs icon -> "Manage job posts". Help article a522249 (updated ~5 months ago) explicitly says closed jobs live in a "Closed" tab ("Locate your job in the Closed tab, select the More menu, and choose Repost job").

2) TAB QUERY VALUES. ?jobState=CLOSED is verified by a real scraper (manjuq/LinkedIn-Job-Applicant-Scraper, Feb 2024) that deep-links https://www.linkedin.com/my-items/posted-jobs/?jobState=CLOSED and then clicks a[href="https://www.linkedin.com/hiring/jobs/<id>/detail/"]. The OPEN tab value is still NOT directly observed anywhere public. Best inference remains ?jobState=LISTED: LinkedIn's canonical job-state enum is LISTED/CLOSED (Job Posting API schema error text: "/state ... The value should either be one of LISTED or CLOSED"; Talent glossary updated 2026-09-09: "Job state ... LISTED (active and visible), CLOSED (no longer accepting applications), or UNLISTED (not visible on LinkedIn)"). The bare URL with no query almost certainly renders the open tab. Do NOT hardcode: at runtime read the tab anchors' hrefs (a[href*="posted-jobs"] containing jobState=) and iterate whatever values LinkedIn renders, falling back to CLOSED + LISTED + bare URL. LinkedIn has no user-facing "paused" job state ("Currently, there isn't a feature to pause a job post on demand", Help a7192014); promoted jobs only stop when a total budget is exhausted, and "in review" jobs are offline (Help a520650). Closed jobs cannot be reopened and job posts cannot be deleted (Help a518551); every job auto-closes after 6 months (Help a522130). So the SQLite state enum you need is OPEN | CLOSED (includes expired) | IN_REVIEW | DRAFT | UNKNOWN; there is no PAUSED.

3) PAGINATION. No public code paginates the posted-jobs list itself. The sibling my-items page (saved-jobs) is paginated with artdeco controls: XPath //button[@aria-label='Next'] clicked until not enabled (aechiou/linkedin-saved-jobs, Mar 2025). The hiring applicants page uses ?start=N in steps of 25 plus numbered button[aria-label="Page N"] buttons (manjuq 2024, lucasudar Dec 2024, arielsegura Jul 2025). Treat posted-jobs as: artdeco pagination (Next button / aria-label="Page N", URL likely gains &start=10) in the older DOM, or "Show more"/infinite scroll in the SDUI DOM; implement both and stop when no new jobIds appear.

4) ANCHORS/SELECTORS. The only structural selector verified for the posted-jobs list is the job link itself: a[href*="/hiring/jobs/"] whose href matches /\/hiring\/jobs\/(\d+)\//, pointing at /hiring/jobs/<id>/detail/ (artdeco generation, 2024). Row container on my-items pages in the artdeco generation is li/div .reusable-search__result-container with .entity-result__* children (rows/X saved-posts config; aechiou saved-jobs uses div.mb1, div.t-roman, div.t-14, .entity-result__actions-overflow-menu-dropdown). In the SDUI generation (2025-2026) class names are build-time hashed (e.g. "_36d0853c", "d3d37ba8") and tools anchor on href patterns and data-view-name attributes (div[data-view-name="job-card"], "jobs-home-*") instead (ecooperman/job-application-chrome-extension; beastx-ro/first2apply). For hiring pages, the newest extension (Liwin-liwi, v1.2.0, Sept 2026, "Hiring Pro applicant list") finds rows by the text /Applied\s*(?:on)?\s*:/ and maps columns by header labels ['Name','Title','Company','Location','Qualifications'], handles infinite scroll plus buttons matching /^(next|show more|show more applicants|...)$/i, and takes the job title from document.title. Applicant-count and state text on posted-jobs rows are unverified: parse row.innerText with /(\d[\d,]*)\s+applicants?/i and /\b(Open|Closed|Draft|In review|Expired)\b/.

5) PER-JOB STATE RE-VERIFICATION. Nothing public documents a status badge on /hiring/jobs/<id>/detail/ or /applicants/ (Help a520582 says the detail page shows "Job Information" with applicant count/views, "Settings", and "View applicants"). Three verifiable markers exist instead: (a) the More menu offers "Close job" for open jobs and "Repost job" for closed ones (Help a518551/a522249); (b) same-origin voyager call GET /voyager/api/jobs/jobPostings/<id>?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65 with headers csrf-token=<JSESSIONID value>, accept: application/vnd.linkedin.normalized+json+2.1, x-restli-protocol-version: 2.0.0 returns data.closedAt, data.expireAt, data.listedAt, data.originalListedAt, data.applies, data.views, data.title (field map from ArshKA/LinkedIn-Job-Scraper json_paths/data_variables.csv; endpoint also used by browser-act/skills and kharitonov-egor/linkedin-apply-count); a possible data.jobState field is unconfirmed; (c) the public page /jobs/view/<id>/ shows the banner "No longer accepting applications" for closed jobs and the poster additionally sees a "View applicants" secondary button (hendrixfreire/linkedin-job-scraper; career-ops docs rule: banner without apply control = closed, apply control without banner = live). Closed jobs remain visible to the poster and their applicants stay accessible if collected on LinkedIn (Help a518551, a516650), so /hiring/jobs/<id>/applicants/ should keep working for closed jobs.

6) HIRING DASHBOARD URL FAMILY (verified): /hiring/jobs/<id>/detail/, /hiring/jobs/<id>/applicants/, /hiring/jobs/<id>/applicants/<applicationId>/detail/?r=UNRATED%2CGOOD_FIT%2CMAYBE&start=<N> (25/page; NOT_A_FIT is the fourth rating per Help a517574). Artdeco applicants-page selectors from 2024-2025 tools: li.hiring-applicants__list-item, .hiring-people-card__title, .artdeco-entity-lockup__metadata/__caption, .hiring-applicant-insights__separator, a[href*="/in/"], a[href*="/detail/"], #hiring-detail-root, .artdeco-modal__content, .hiring-applicant-header h1, span.hiring-applicant-header-actions__more-content-dropdown-item-text (email + phone), resume link div.ui-attachment.ui-attachment--doc a[href], pagination button[aria-label*='Page'], button[aria-current='true'], .artdeco-pagination__button--next:not([disabled]), ul.artdeco-pagination__pages--number.

Caveats: LinkedIn Help a517574 states "bulk downloading or exporting applicant profiles is not available" for online job posts, and the Sept-2026 extension README notes LinkedIn's User Agreement disallows extensions that copy data; pace accordingly. Research constraint: WebSearch budget was exhausted (200/200) before this task; grep.app, web.archive.org, stackoverflow.com were blocked and gh is not installed, so findings come from directly fetched primary sources listed per fact.

### Facts

- [high] The job-poster management page is https://www.linkedin.com/my-items/posted-jobs/ ; LinkedIn's own business site links to it as 'Manage Online Job Posts' with the URL https://www.linkedin.com/my-items/posted-jobs/?src=direct%2Fnone&veh=direct%2Fnone (fetched 2026-09-25).  <https://business.linkedin.com/talent-solutions/post-jobs>
- [high] LinkedIn Help 'Manage your posted jobs on LinkedIn' (a520582, updated ~5 months ago): navigation is Jobs icon -> 'Manage job posts' -> job title; per-job sections are 'Job Information' (posting details, applicant count, posting views, promote), 'Settings' (applicant filtering), and 'View applicants' (sort by Relevance, Location, Years of experience, Applicant fit rating). No status badge is described.  <https://www.linkedin.com/help/linkedin/answer/a520582>
- [high] LinkedIn Help 'Repost a closed or expired job' (a522249): on the Manage job posts page, 'Locate your job in the Closed tab, select the More menu, and choose Repost job'; the repost is a new job ('any prior applicants from the closed job won't be included') and prior applicants remain on the original closed record.  <https://www.linkedin.com/help/linkedin/answer/a522249>
- [high] LinkedIn Help 'Close a job post' (a518551): Jobs -> Manage job posts -> More icon next to title -> 'Close job' -> confirm; 'once a job is closed, it can't be reopened'; 'Job posts cannot be deleted. They can only be closed.'; after closing you retain access to applicants collected on LinkedIn (not those routed to external ATS).  <https://www.linkedin.com/help/linkedin/answer/a518551>
- [high] The deep link https://www.linkedin.com/my-items/posted-jobs/?jobState=CLOSED renders the closed-jobs tab; a Selenium notebook (Feb 2024) loads it and then clicks the job via XPath //a[@href="https://www.linkedin.com/hiring/jobs/<jobId>/detail/"], i.e. posted-jobs rows link to /hiring/jobs/<id>/detail/.  <https://github.com/manjuq/LinkedIn-Job-Applicant-Scraper>
- [low] The open-tab query value is NOT directly observed in any public source; ?jobState=LISTED is an inference from LinkedIn's canonical enum. Talent glossary (ms.date 2026-08-20, updated 2026-09-09): 'Job state ... Values include LISTED (active and visible), CLOSED (no longer accepting applications), or UNLISTED (not visible on LinkedIn).'  <https://learn.microsoft.com/en-us/linkedin/talent/lts-glossary-terms>
- [high] LinkedIn Job Posting API error table: 'ERROR :: /state :: {value} is not an enum symbol ... The value should either be one of LISTED or CLOSED'; jobPostingOperationType is CREATE/UPDATE/RENEW/CLOSE (versioned API adds UPGRADE/DOWNGRADE); 'Cannot close job which is already closed or does not exist' (409). Page updated 2026-05-20.  <https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/create-jobs>
- [high] There is no user-facing paused state for LinkedIn job posts: 'Currently, there isn't a feature to pause a job post on demand'; a promoted job with a total budget stops when the budget is reached; all jobs close after six months.  <https://www.linkedin.com/help/linkedin/answer/a7192014>
- [high] 'Job posts will stay open until you close the job manually or until the job automatically closes after 6 months'; after expiry/repost, 'all previously gathered applicant information will be associated with the closed job post'.  <https://www.linkedin.com/help/linkedin/answer/a522130>
- [high] Jobs 'in review' are offline: 'The job post won't be visible on LinkedIn and can't receive new applicants'; reviews usually finish within one business day; closed-for-policy jobs are appealable for up to six months, after which they are permanently closed.  <https://www.linkedin.com/help/linkedin/answer/a520650>
- [high] 'Once your job expires or is closed, only you and existing applicants can see it. A closed job post will be removed from search results and applicants won't be able to apply to it.' (so the poster can still open closed jobs' pages).  <https://www.linkedin.com/help/linkedin/answer/a516650>
- [high] LinkedIn Help 'Reviewing job applicants' (a517574): applicants are reached via Manage job posts -> More -> Manage job -> View applicants; ratings filter includes 'Not a fit' (with Good fit, Maybe, Unrated); 'For online job postings, bulk downloading or exporting applicant profiles is not available.'  <https://www.linkedin.com/help/linkedin/answer/a517574>
- [high] Hiring dashboard URL family: /hiring/jobs/<id>/detail/, /hiring/jobs/<id>/applicants/, and /hiring/jobs/<id>/applicants/<applicationId>/detail/?r=UNRATED%2CGOOD_FIT%2CMAYBE&start=<N>, paginated with start=0,25,... (25 applicants per page). Rating filter param r= takes comma-separated UNRATED, GOOD_FIT, MAYBE (NOT_A_FIT implied by Help).  <https://github.com/manjuq/LinkedIn-Job-Applicant-Scraper>
- [high] Chrome extension manifests for applicant exporters inject on https://www.linkedin.com/hiring/* and https://www.linkedin.com/hiring/jobs/* (arielsegura, Jul 2025; MV3).  <https://github.com/arielsegura/linkedin-applicant-exporter>
- [high] Artdeco-generation applicants-page selectors (Jul 2025): cards '.hiring-applicants__list-item', name '.hiring-people-card__title', title '.artdeco-entity-lockup__metadata:first-of-type', location '.artdeco-entity-lockup__metadata:nth-of-type(2)', experience '.artdeco-entity-lockup__caption ul li', applied-time/qualifications '.hiring-applicant-insights__separator', profile links 'a[href*="/in/"]'; pagination via "button[aria-label*='Page']", current page "button[aria-current='true'][aria-label*='Page']", fallbacks 'button[aria-label*="Next"]:not([disabled])' and '.artdeco-pagination__button--next:not([disabled])'; 5 s wait between pages.  <https://github.com/arielsegura/linkedin-applicant-exporter/blob/main/content.js>
- [high] Additional artdeco applicants selectors (Jun 2025): '.application-outlet', '.artdeco-entity-lockup', detail link 'a[href*="/detail/"]', detail root '#hiring-detail-root', '.artdeco-modal__content', job title fallback '.artdeco-entity-lockup__title, .hiring-people-card__title, .t-16.t-bold.t-black.mr2'; next page '.artdeco-pagination__button--next:not([disabled]):not([aria-disabled="true"])', active indicator '.artdeco-pagination__indicator.active.selected'; 2-3 s sleeps.  <https://github.com/ist00dent/linkedin-candidate-scraper/blob/main/src/js/content.js>
- [medium] Applicant header selectors: '.hiring-applicant-header h1' (name), '.hiring-applicant-header .t-16:nth-of-type(2)' (location), 'li.hiring-applicants__list-item', numbered pages 'li.artdeco-pagination__indicator.artdeco-pagination__indicator--number.ember-view' (total pages = last button text), next page //button[@aria-label="Page {n}"], contact dropdown trigger //button[contains(@class,'artdeco-dropdown__trigger') and contains(@class,'artdeco-button--secondary')], email //a[contains(@href,"mailto:")], profile //a[contains(@class,"artdeco-button--tertiary")]; 'View applicants' is a secondary button visible to the poster on the job page: //button[contains(@class,"artdeco-button--secondary") and contains(span,"View applicants")].  <https://github.com/lucasudar/linkedin_applicants_scraper/blob/master/src/main.py>
- [medium] Applicant detail page: email and phone are read from span.hiring-applicant-header-actions__more-content-dropdown-item-text inside the header 'More' dropdown; the resume anchor is found via div.ui-attachment.ui-attachment--doc a[href] (fallback div class chain 'display-flex justify-space-between align-items-flex-start pl5 pr5 pt5 pb3').  <https://github.com/manjuq/LinkedIn-Job-Applicant-Scraper>
- [high] Anonymizer extension (Oct 2024) selectors on hiring applicant pages: '.hiring-selectable-entity > img', '.hiring-people-card__title', '.hiring-applicant-header h1'.  <https://github.com/bilalsaci/LinkedIn-Applicant-Anonymizer/blob/main/content.js>
- [high] Newest-generation (SDUI / 'Hiring Pro applicant list') extension v1.2.0 (Sept 2026) does not rely on class names: rows are located by text /Applied\s*(?:on)?\s*:/gi and climbed to a bounded ancestor; columns mapped via header labels ['Name','Title','Company','Location','Qualifications']; handles infinite scroll (scroll + 1200 ms) and buttons matching /^(next|next page|load more|show more|show more results|show more applicants|show more candidates|see more applicants|see more candidates|view more applicants|view more candidates)$/i with jittered 2.5-3.5 s pauses; job title from document.title stripped of '| LinkedIn'; README warns 'LinkedIn's User Agreement does not allow extensions that copy data from the site' and that profile views are visible/rate-limited.  <https://github.com/Liwin-liwi/Linkedin-Filter-ChromeExtension>
- [high] Hiring Pro FAQ (updated ~1 week ago): AI sorts applicants into 'Top fit', 'Maybe', 'Not a fit'; sort by qualification match, date applied, or alphabetical; a 'Table View' allows search/filter/sort by location, experience, qualification match; a 'Hiring Plan' tab is the dashboard. Hiring Pro is desktop-only and rolled out to a subset of members who promote jobs.  <https://www.linkedin.com/help/linkedin/answer/a6898871>
- [medium] my-items pages (artdeco generation) use the reusable-search list DOM: list items '.reusable-search__result-container', title '.entity-result__title-line--2-lines > span > a > span > span:nth-child(1)', content '.entity-result__content-inner-container ... a.app-aware-link' (saved-posts scraper config).  <https://github.com/rows/X/blob/main/src/scrappers/linkedin-saved-posts.yml>
- [high] my-items/saved-jobs scraper (Mar 2025) uses URLs ?cardType=SAVED|APPLIED|IN_PROGRESS|ARCHIVED, rows div.mb1, title div.t-roman (with <a>), subtitles div.t-14, overflow menu '.entity-result__actions-overflow-menu-dropdown' / '.artdeco-dropdown__content-inner', and paginates by clicking //button[@aria-label='Next'] while is_enabled(), 2 s page sleeps; no ?start= param used.  <https://github.com/aechiou/linkedin-saved-jobs/blob/main/linkedin-saved-jobs.py>
- [high] No public source paginates or selects rows on my-items/posted-jobs specifically; Sourcegraph and GitHub repository search returned zero hits for 'my-items/posted-jobs'. Selectors for that list beyond a[href*="/hiring/jobs/"] are therefore unverified.  <https://sourcegraph.com/search?q=context:global+%22my-items/posted-jobs%22>
- [medium] Current (2025-2026) LinkedIn SDUI markup has build-time hashed class names ('_36d0853c', 'd3d37ba8'); maintained scrapers anchor on href patterns (a[href*='/jobs/view/'] with /\/jobs\/view\/(\d+)/) and on data-view-name attributes (div[data-view-name="job-card"], 'jobs-home-infinite-jymbii-jobs-feed-module'); the new saved-jobs tracker lives at linkedin.com/jobs-tracker/. Older jobs list still exposes li.scaffold-layout__list-item[data-occludable-job-id].  <https://github.com/ecooperman/job-application-chrome-extension>
- [high] first2apply's LinkedIn parser uses document.querySelector('div[data-view-name="jobs-home-infinite-jymbii-jobs-feed-module"]'), 'div[data-view-name="jobs-home-top-jymbii-jobs-feed-module"]', 'div[data-view-name="feed-full-update"]', and querySelectorAll('div[data-view-name="job-card"]').  <https://github.com/beastx-ro/first2apply/blob/main/apps/backend/supabase/functions/_shared/parsers/linkedin.ts>
- [high] Voyager per-job endpoint: GET /voyager/api/jobs/jobPostings/{jobId}?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65 called from inside the logged-in page with headers csrf-token (JSESSIONID cookie value), x-restli-protocol-version: 2.0.0, accept: application/vnd.linkedin.normalized+json+2.1; fields read include data.title, listedAt, applies, formattedLocation, workplaceTypes, description.text, companyDetails.company.  <https://github.com/browser-act/skills/blob/main/solutions/lead-generation/linkedin-jobs-search/scripts/job-detail.py>
- [medium] The WebFullJobPosting-65 payload includes ['data']['closedAt'] (mapped to closed_time), ['data']['expireAt'], ['data']['listedAt'], ['data']['originalListedAt'], ['data']['applies'], ['data']['views'], ['data']['jobPostingUrl'], ['data']['applyMethod']['companyApplyUrl'], ['data']['applyMethod']['$type'], ['data']['companyDetails']['company'], ['data']['workRemoteAllowed'], so closedAt/expireAt can classify open vs closed per job. A 'jobState' key is not in this mapping (its presence is unconfirmed).  <https://github.com/ArshKA/LinkedIn-Job-Scraper/blob/master/json_paths/data_variables.csv>
- [high] Extension 'linkedin-apply-count' intercepts voyager/api/jobs calls and reads applies, views, listedAt, expireAt, workplaceTypes, applyMethod.companyApplyUrl from the same jobPostings/{id}?decorationId=...WebFullJobPosting-65&topN=1&topNRequestedFlavors=List(...) endpoint, using csrf-token from JSESSIONID and accept: application/vnd.linkedin.normalized+json+2.1.  <https://github.com/kharitonov-egor/linkedin-apply-count/blob/main/content.js>
- [medium] Closed jobs show the text 'No longer accepting applications' on the public /jobs/view/<id> page; tools detect closure by substring match ('no longer accepting applications' in text.lower()) and a liveness rule 'banner without apply control = expired; apply control without banner = live; both/neither = uncertain'.  <https://github.com/career-ops-hq/career-ops/blob/main/docs/SCRIPTS.md>
- [high] LinkedIn partner Job Posting Status API (ms.date 2026-09-21) uses listingStatus LISTED | NOT_LISTED | IN_PROGRESS and documents LinkedIn auto-closing jobs reported by multiple members (MEMBER_REPORTED); this is a partner OAuth API, not usable from the poster's browser session, but it defines LinkedIn's status vocabulary.  <https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/check-job-posting-status>
- [high] LinkedIn Help 'Manage Jobs' topic (112548 / a113005) lists no article about drafts, reopening, or pausing; relevant articles are a520582 (Manage your posted jobs), a518551 (Close), a522249 (Repost closed/expired), a520650 (In review FAQ), a517574 (Reviewing applicants), a517570 (Applicant options), a11290040 (Add coworkers to review applicants), a516725 (Share applicants).  <https://www.linkedin.com/help/linkedin/topic/112548>
- [high] a third-party LinkedIn MCP server (Patchright-based) exposes search_jobs/get_job_details/get_saved_jobs etc. but has no hiring-dashboard, posted-jobs, or applicant features.  (source omitted)

### Recommendations

- Implement list_hiring_jobs as a tab-discovery loop: open https://www.linkedin.com/my-items/posted-jobs/, collect every anchor whose href contains 'posted-jobs' and a jobState= param, and iterate the discovered values; always add fallbacks '?jobState=CLOSED' (verified), '?jobState=LISTED' (inferred) and the bare URL (default tab). Record which tab each jobId came from (state_source='tab:<VALUE>') so a wrong LISTED guess is detectable (a tab that renders zero rows while the bare URL renders rows).
- Never select posted-jobs rows by class name. Anchor on a[href*="/hiring/jobs/"] and extract the id with /\/hiring\/jobs\/(\d+)\//; climb to the row (first <li> ancestor in the artdeco DOM, or a bounded-height ancestor in the hashed-class SDUI DOM) and regex row.innerText for applicants count and any Open/Closed/Draft/In review/Expired word. This is the same technique the only actively maintained (Sept 2026) hiring-page extension uses.
- Paginate defensively on the posted-jobs list: try button[aria-label="Next"]:not([disabled]) / .artdeco-pagination__button--next / button[aria-label="Page N"] (artdeco), then a 'Show more'/'See more' role=button, then scroll-to-bottom and compare document.body.scrollHeight (SDUI infinite scroll); stop when a pass yields no new jobIds. Persist the URL after each step so you learn whether LinkedIn appends &start=N for this page.
- Classify state from three independent signals and store all of them: (1) tab of origin; (2) voyager closedAt/expireAt from GET /voyager/api/jobs/jobPostings/<id>?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65 executed via page.evaluate(fetch) in the logged-in tab (csrf-token = JSESSIONID value, accept: application/vnd.linkedin.normalized+json+2.1, x-restli-protocol-version: 2.0.0), also log the raw JSON once to confirm whether a jobState key exists; (3) on the job's own pages, presence of 'Close job' (open) vs 'Repost job' (closed) in the More menu, or the 'No longer accepting applications' banner on /jobs/view/<id>/. Mark UNKNOWN when signals disagree instead of guessing.
- Model the SQLite state column as OPEN | CLOSED | IN_REVIEW | DRAFT | UNKNOWN (no PAUSED, LinkedIn has no on-demand pause; budget-exhausted promoted jobs and 6-month expiries both surface as closed). Keep closed_at, expire_at, listed_at, applies, views, state_source, last_verified_at and raw_json columns; re-verify OPEN jobs periodically because LinkedIn auto-closes after 6 months and on member reports.
- Build applicant URLs deterministically: https://www.linkedin.com/hiring/jobs/<id>/applicants/?r=UNRATED,GOOD_FIT,MAYBE,NOT_A_FIT&start=<0,25,50,...> (25/page observed) and detail pages /hiring/jobs/<id>/applicants/<applicationId>/detail/?r=...&start=N. Include NOT_A_FIT explicitly or rejected/'Not a fit' applicants will be silently skipped. Expect closed jobs' applicant pages to still work (Help confirms poster retains access).
- Support both DOM generations on the applicants page from day one: artdeco (li.hiring-applicants__list-item, .hiring-people-card__title, .hiring-applicant-header h1, span.hiring-applicant-header-actions__more-content-dropdown-item-text, div.ui-attachment--doc a[href], button[aria-label*='Page']) and SDUI/Hiring Pro (rows found by 'Applied on:' text, header-label column mapping, 'Show more'/infinite scroll, possibly a 'Table View'). Detect generation per page load (presence of .artdeco-pagination or .hiring-applicants__list-item) and log it into SQLite for later debugging.
- Pace like the existing tools that survived: 2.5-5 s jittered waits between page navigations, ~1 s before clicking controls, one job/applicant at a time, and capture 429/999/authwall/checkpoint redirects (regex /\/(authwall|checkpoint|login|uas|signup)\b/) to pause the queue rather than retry. Note LinkedIn Help states bulk export of applicant profiles is not offered and its User Agreement restricts data-copying extensions; surface this risk to the user.
- Add a one-time 'discover' MCP tool that dumps, for the posted-jobs page and one applicants page, the tab hrefs, pagination controls found, first 3 row innerTexts, and every voyager XHR URL observed via page.on('response') containing '/voyager/api/'. Run it on the user's account before hardening selectors, it will settle the LISTED-vs-default question and reveal the hiring-side voyager collection endpoint (not found in any public source) in minutes.

### Open questions

- Exact open-tab query value: is it ?jobState=LISTED, the bare URL only, or something else (e.g. OPEN)? No public source observes it; verify on the user's account via tab anchor hrefs.
- Do Draft and In-review jobs appear on my-items/posted-jobs at all, and under which tab/param (e.g. jobState=DRAFT / IN_REVIEW)? LinkedIn Help never names a Drafts tab.
- Is the posted-jobs list paginated with artdeco Next/Page-N buttons and &start=10 like other search-framework pages, or with SDUI 'Show more'/infinite scroll in 2026? Only the sibling saved-jobs page (Next button, 2025) is documented.
- Does /hiring/jobs/<id>/detail/ or /applicants/ render a textual status badge (Open/Closed) or only the 'Close job' vs 'Repost job' menu difference? No source documents either page's header DOM.
- Does the WebFullJobPosting-65 voyager payload include a 'jobState' key (LISTED/CLOSED) in addition to closedAt/expireAt? One README summary mentions it; the field map does not.
- Which voyager collection endpoint backs the poster's job list and the applicants list (likely a hiring-dash collection)? Not found in any public code; capture via page.on('response').
- Does LinkedIn still serve the artdeco hiring dashboard to non-Hiring-Pro posters in Sept 2026, or has the SDUI 'Hiring Pro applicant list' (hashed classes, header-mapped columns, Table View) fully replaced it? The newest extension (Sept 2026) targets the new UI; 2024-2025 tools target artdeco.
- Research constraints: WebSearch budget was exhausted (200/200) before this task, grep.app returned 429, web.archive.org and stackoverflow.com were blocked, and gh CLI is not installed; a GitHub code search (authenticated) for 'jobState=LISTED' and 'my-items/posted-jobs' would likely settle the open-tab value quickly.

### Snippets

#### list_hiring_jobs core: discover posted-jobs tabs at runtime, enumerate jobIds via href anchors (works for artdeco and hashed-class SDUI), paginate defensively

```typescript
import type { Page } from 'playwright';

export type JobState = 'OPEN' | 'CLOSED' | 'IN_REVIEW' | 'DRAFT' | 'UNKNOWN';
export interface PostedJobRow {
  jobId: string; href: string; title: string; rowText: string;
  applicantsText?: string; stateWord?: string; tabParam: string; state: JobState;
}

const POSTED_JOBS = 'https://www.linkedin.com/my-items/posted-jobs/';
const jitter = (ms: number) => ms + Math.floor(Math.random() * ms * 0.6);

async function discoverTabUrls(page: Page): Promise<Record<string, string>> {
  await page.goto(POSTED_JOBS, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(jitter(2000));
  const hrefs = await page.$$eval('a[href*="posted-jobs"]', as => as.map(a => (a as HTMLAnchorElement).href));
  const tabs: Record<string, string> = {};
  for (const h of hrefs) { const m = /[?&]jobState=([A-Z_]+)/.exec(h); if (m) tabs[m[1]] = h; }
  // Fallbacks: CLOSED is verified (2024 scraper); LISTED is inferred from LinkedIn's LISTED/CLOSED enum; DEFAULT = bare URL
  tabs.CLOSED ??= `${POSTED_JOBS}?jobState=CLOSED`;
  tabs.LISTED ??= `${POSTED_JOBS}?jobState=LISTED`;
  tabs.DEFAULT ??= POSTED_JOBS;
  return tabs;
}

async function scrapeRows(page: Page, tabParam: string): Promise<PostedJobRow[]> {
  return page.$$eval('a[href*="/hiring/jobs/"]', (anchors, tabParam) => {
    const seen = new Set<string>(); const out: any[] = [];
    for (const a of anchors as HTMLAnchorElement[]) {
      const m = /\/hiring\/jobs\/(\d+)\//.exec(a.href); if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      // climb to the row: <li> in artdeco (li.reusable-search__result-container) or a bounded ancestor in hashed-class SDUI
      let row: HTMLElement = a;
      for (let i = 0; i < 8 && row.parentElement; i++) {
        row = row.parentElement;
        if (row.tagName === 'LI' || row.getBoundingClientRect().height > 70) break;
      }
      const text = (row.innerText || '').replace(/\s+/g, ' ').trim();
      out.push({
        jobId: m[1], href: a.href, title: (a.innerText || '').trim(), rowText: text, tabParam,
        applicantsText: /(\d[\d,]*)\s+applicants?/i.exec(text)?.[1],
        stateWord: /\b(Open|Closed|Draft|In review|Expired|Paused)\b/i.exec(text)?.[1],
      });
    }
    return out;
  }, tabParam);
}

async function advance(page: Page): Promise<boolean> {
  const next = page.locator('button[aria-label="Next"]:not([disabled]), .artdeco-pagination__button--next:not([disabled])').first();
  if (await next.count()) { await next.click(); return true; }                 // artdeco pagination (verified on my-items/saved-jobs)
  const more = page.getByRole('button', { name: /^(show|see|load) more( results| jobs)?$/i }).first();
  if (await more.count()) { await more.click(); return true; }                 // SDUI 'Show more'
  const before = await page.evaluate(() => document.body.scrollHeight);        // SDUI infinite scroll
  await page.mouse.wheel(0, 2500); await page.waitForTimeout(jitter(1500));
  return (await page.evaluate(() => document.body.scrollHeight)) > before;
}

function stateFromTab(param: string, stateWord?: string): JobState {
  if (param === 'CLOSED') return 'CLOSED';
  if (param === 'LISTED') return 'OPEN';
  if (/closed|expired/i.test(stateWord ?? '')) return 'CLOSED';
  if (/in review/i.test(stateWord ?? '')) return 'IN_REVIEW';
  if (/draft/i.test(stateWord ?? '')) return 'DRAFT';
  if (/open/i.test(stateWord ?? '')) return 'OPEN';
  return 'UNKNOWN';
}

export async function listHiringJobs(page: Page): Promise<PostedJobRow[]> {
  const tabs = await discoverTabUrls(page);
  const byId = new Map<string, PostedJobRow>();
  for (const [param, url] of Object.entries(tabs)) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(jitter(2500));
    for (let guard = 0, stale = 0; guard < 300 && stale < 2; guard++) {
      const rows = await scrapeRows(page, param);
      let added = 0;
      for (const r of rows) {
        const state = stateFromTab(param, r.stateWord);
        const prev = byId.get(r.jobId);
        if (!prev || (prev.state === 'UNKNOWN' && state !== 'UNKNOWN')) { byId.set(r.jobId, { ...r, state }); added++; }
      }
      stale = added === 0 ? stale + 1 : 0;
      if (!(await advance(page))) break;
      await page.waitForTimeout(jitter(3000));
    }
  }
  return [...byId.values()];
}
```

#### Per-job open/closed re-verification via LinkedIn's own voyager endpoint from inside the logged-in tab (same-origin fetch, cookies + csrf-token); classify on closedAt/expireAt and keep raw JSON

```typescript
export async function fetchJobPostingState(page: Page, jobId: string) {
  return page.evaluate(async (id) => {
    const jsession = document.cookie.match(/JSESSIONID="?([^";]+)"?/)?.[1] ?? '';
    const url = `/voyager/api/jobs/jobPostings/${id}?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65`;
    const res = await fetch(url, {
      credentials: 'include',
      headers: {
        'csrf-token': jsession,
        'accept': 'application/vnd.linkedin.normalized+json+2.1',
        'x-restli-protocol-version': '2.0.0',
      },
    });
    if (!res.ok) return { ok: false as const, status: res.status };
    const j = await res.json(); const d = j.data ?? {};
    return {
      ok: true as const,
      jobState: d.jobState as string | undefined,      // unconfirmed key, log it once to check
      closedAt: d.closedAt as number | undefined,      // verified field (epoch ms) when the job is closed
      expireAt: d.expireAt, listedAt: d.listedAt, originalListedAt: d.originalListedAt,
      applies: d.applies, views: d.views, title: d.title, raw: JSON.stringify(j).slice(0, 200_000),
    };
  }, jobId);
}

export function classifyFromVoyager(v: Awaited<ReturnType<typeof fetchJobPostingState>>): JobState {
  if (!v.ok) return 'UNKNOWN';
  if (v.jobState === 'CLOSED' || v.closedAt) return 'CLOSED';
  if (typeof v.expireAt === 'number' && v.expireAt < Date.now()) return 'CLOSED';
  if (v.jobState === 'LISTED' || v.listedAt) return 'OPEN';
  return 'UNKNOWN';
}
```

#### Third, DOM-independent state check: public job page banner + poster-only 'View applicants' control (rule used by liveness checkers: banner without apply control = closed)

```typescript
export async function stateFromPublicJobPage(page: Page, jobId: string) {
  await page.goto(`https://www.linkedin.com/jobs/view/${jobId}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(jitter(2000));
  const text = await page.evaluate(() => document.body.innerText);
  const banner = /no longer accepting applications/i.test(text);
  const applyCtl = await page.getByRole('button', { name: /^(easy apply|apply)$/i }).count();
  const closeJobMenu = /\bClose job\b/.test(text);   // present for open jobs the viewer owns
  const repostMenu = /\bRepost job\b/.test(text);    // present for closed jobs the viewer owns
  const verdict: JobState =
    (banner && !applyCtl) || repostMenu ? 'CLOSED' :
    (!banner && (applyCtl || closeJobMenu)) ? 'OPEN' : 'UNKNOWN';
  return { banner, applyCtl, closeJobMenu, repostMenu, verdict };
}
```

#### Applicants URL builder (verified URL shape; 25 per page; include NOT_A_FIT so rejected applicants are not skipped)

```typescript
export const RATINGS = ['UNRATED', 'GOOD_FIT', 'MAYBE', 'NOT_A_FIT'] as const;
export const applicantsListUrl = (jobId: string, start = 0, r: readonly string[] = RATINGS) =>
  `https://www.linkedin.com/hiring/jobs/${jobId}/applicants/?r=${encodeURIComponent(r.join(','))}&start=${start}`;
export const applicantDetailUrl = (jobId: string, applicationId: string, start = 0, r: readonly string[] = RATINGS) =>
  `https://www.linkedin.com/hiring/jobs/${jobId}/applicants/${applicationId}/detail/?r=${encodeURIComponent(r.join(','))}&start=${start}`;
export const PAGE_SIZE = 25; // observed start=0,25 in 2024 scraper; confirm via button[aria-label="Page N"] count
```

#### SQLite jobs table capturing every state signal so mislabels are auditable

```sql
CREATE TABLE IF NOT EXISTS jobs (
  job_id           TEXT PRIMARY KEY,
  title            TEXT,
  state            TEXT NOT NULL CHECK (state IN ('OPEN','CLOSED','IN_REVIEW','DRAFT','UNKNOWN')),
  state_source     TEXT,              -- 'tab:CLOSED' | 'tab:LISTED' | 'tab:DEFAULT' | 'voyager:closedAt' | 'public:banner' | 'menu:repost'
  tab_param        TEXT,              -- jobState value the row was seen under
  applicants_text  TEXT,              -- raw '123 applicants' from the list row
  closed_at        INTEGER,           -- voyager data.closedAt (epoch ms)
  expire_at        INTEGER,           -- voyager data.expireAt
  listed_at        INTEGER,           -- voyager data.listedAt
  applies          INTEGER,           -- voyager data.applies
  views            INTEGER,           -- voyager data.views
  detail_url       TEXT,              -- https://www.linkedin.com/hiring/jobs/<id>/detail/
  first_seen_at    INTEGER NOT NULL,
  last_verified_at INTEGER,
  raw_json         TEXT               -- last voyager payload for audit
);
CREATE INDEX IF NOT EXISTS jobs_state_idx ON jobs(state, last_verified_at);
```
