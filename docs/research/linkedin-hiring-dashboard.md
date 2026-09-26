# Research notes (2026-09-25, auto-collected; verify before relying on any single claim)

SUMMARY: Research on LinkedIn's job-poster hiring dashboard (company-page admin, not Recruiter seat) as of 2026-09-25. VERIFIED URL patterns (from open-source scrapers/extensions): posted-jobs list at https://www.linkedin.com/my-items/posted-jobs/ with ?jobState=CLOSED for the Closed tab; job detail at /hiring/jobs/<jobId>/detail/; applicants list at /hiring/jobs/<jobId>/applicants/ paginated with start=N in steps of 25 (and, in the 2025 UI, numbered buttons button[aria-label="Page N"] + .artdeco-pagination__button--next); applicant detail at /hiring/jobs/<jobId>/applicants/<applicationId>/detail/. Two DOM generations exist and both must be supported: (a) the Ember/artdeco generation (repos dated Feb 2024 and Jul 2025) with stable BEM classes such as .hiring-applicants__list-item, .hiring-people-card__title, .artdeco-entity-lockup__metadata, .hiring-applicant-insights__separator, span.hiring-applicant-header-actions__more-content-dropdown-item-text (email/phone inside the "More" dropdown) and .ui-attachment.ui-attachment--doc (resume attachment with <a href>); (b) the 2026 Server-Driven-UI (SDUI/React-Server-Components) generation with hashed class names where only data-view-name, componentkey, aria-label, role and text survive, e.g. button[data-view-name="hiring-applicant-view-resume"], svg#download-small, button[aria-label*="Download"], [role="list"] [role="listitem"], and a[href*="applicationId"]; presence of an sdui_ver cookie (or absence of <h1>) detects SDUI. Detail page content per LinkedIn Help: rating buttons Good fit / Maybe / Not a fit (Not-a-fit applicants are HIDDEN from the list until the Ratings filter's "Not a fit" checkbox is ticked), screening-question answers (click the applicant's name; a "meets all screening requirements" badge sits on the card), Share/Forward, sort by relevance/location/experience/fit rating, and an explicit statement that bulk download/export is not available. Resume download: a Resume button opens a viewer (iframe/embed/object src or modal) with a Download control; the file URL contains one of ".pdf", "mediaauth", "ambry", "dms/", "media.licdn.com"; a 2026 extension downloads it successfully with fetch(url,{credentials:'include'}) from the page context (cookie auth, no Referer needed). LinkedIn's own partner docs show applicant resume media served from https://www.linkedin.com/ambry/?x-li-ambry-ep=<token> (30-day lifetime) with URN form urn:li:ambryBlob:<id>.pdf, and public documents from https://media.licdn.com/dms/document/<id>/<variant>/0/<ts>?e=<expiry>&v=beta&t=<sig>. Voyager: required headers are csrf-token (= JSESSIONID cookie value with quotes stripped, form ajax:<digits>), x-restli-protocol-version: 2.0.0, accept: application/vnd.linkedin.normalized+json+2.1, x-li-lang: en_US, x-li-track JSON ({"clientVersion":"1.13.x","mpVersion":..,"osName":"web","timezoneOffset":..,"timezone":..,"deviceFormFactor":"DESKTOP","mpName":"voyager-web","displayDensity":..,"displayWidth":..,"displayHeight":..}), x-li-page-instance (urn:li:page:d_flagship3_<page>;<base64>) plus cookies li_at, JSESSIONID, lidc, bcookie. The specific hiring-dashboard Voyager/GraphQL endpoint names and decorationIds are NOT publicly documented anywhere reachable (grep.app 429, Sourcegraph 0 hits, web 0 hits for voyagerHiringDash / voyager/api/hiring); the closest public model of the applicant object is Unipile's Classic-job applicant schema (rating enum UNRATED/GOOD_FIT/MAYBE/NOT_A_FIT, sort_by relevance|alphabetical|newest_first|screening_requirements, ratings filter GOOD_FIT,MAYBE,NOT_A_FIT,UNRATED, applied_at epoch ms, contact_info, screening_questions[{question,answers[],success}], and a per-applicant binary resume route). For full profiles, legacy /voyager/api/identity/profiles/{id}/profileView returns 410 Gone since Aug 2026; the working endpoint is /voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=<slug>&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-<NN> (NN observed 96 and 101; suffix rotates), with flagship-web RSC streams (window.__como_rehydration__) as the UI path. Recommendation: drive the user's own Chrome, intercept the dashboard's own XHR/RSC responses with page.on('response') rather than guessing endpoint names, fall back to a two-generation selector map, download resumes via in-page fetch with cookies, page at 25/page with 5–15 s randomized pauses and per-day caps (community data: ~80–100 profile views/day is the soft limit; 300–400/day triggers warnings), and persist a resumable queue in SQLite keyed by applicationId.

FACTS:
 - [high] Posted-jobs list URL (job poster view): https://www.linkedin.com/my-items/posted-jobs/ ; the Closed tab is https://www.linkedin.com/my-items/posted-jobs/?jobState=CLOSED (exact string used by the manjuq Selenium scraper, Feb 2024, and the path confirmed by ApplicantSync's 2026 guide).  <https://raw.githubusercontent.com/manjuq/LinkedIn-Job-Applicant-Scraper/main/LinkedIn_scraper.ipynb>
 - [low] The open/active tab query value is not verified; by analogy with LinkedIn's Job Posting Status API (statuses LISTED / CLOSED) it is probably ?jobState=LISTED. INFERRED.  <https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/check-job-posting-status?view=li-lts-2025-10>
 - [high] Job detail page for a job you posted: https://www.linkedin.com/hiring/jobs/<jobId>/detail/ (example in scraper: /hiring/jobs/<jobId>/detail/). A 'View applicants' button (span text "View applicants") leads to the applicants list.  <https://raw.githubusercontent.com/manjuq/LinkedIn-Job-Applicant-Scraper/main/LinkedIn_scraper.ipynb>
 - [high] Applicants list URL: https://www.linkedin.com/hiring/jobs/<jobId>/applicants/ . The arielsegura Chrome extension (Jul 2025) detects this exact pattern ('linkedin.com/hiring/jobs/[JOB_ID]/applicants/') and its manifest matches https://www.linkedin.com/hiring/* and https://www.linkedin.com/hiring/jobs/*.  <https://github.com/arielsegura/linkedin-applicant-exporter>
 - [high] Applicant detail URL: https://www.linkedin.com/hiring/jobs/<jobId>/applicants/<applicationId>/detail/ (scraper navigated /hiring/jobs/<jobId>/applicants/[ID]/detail/). The 2025 extension reads the detail link as card.querySelector('a').href from each list item.  <https://raw.githubusercontent.com/manjuq/LinkedIn-Job-Applicant-Scraper/main/LinkedIn_scraper.ipynb>
 - [high] Applicants list pagination is offset-based with 25 per page: the scraper appends `&start={i * 25}` to the current applicants URL (note the '&', implying the URL already carried a query string). The 2025 extension instead clicks numbered buttons `button[aria-label="Page N"]` (regex /Page (\d+)/ to find total pages) with fallbacks `button[aria-label*="Next"]:not([disabled])` and `.artdeco-pagination__button--next:not([disabled])`.  <https://raw.githubusercontent.com/arielsegura/linkedin-applicant-exporter/main/content.js>
 - [medium] The 2026 SDUI applicants list lazy-loads on scroll ('Scroll down to load more applicants first, LinkedIn lazy-loads') per the Feb-2026 bulk-resume-downloader README, so newer builds may use infinite scroll rather than page buttons.  <https://github.com/developer-nf/parse-linkedin-resume>
 - [medium] Job application IDs are URNs of the form urn:li:jobApplication:12345678 (official Apply Connect webhook payload); the numeric <applicationId> in the detail URL is most likely this id. Applicant person URN form: urn:li:person:<id>. INFERRED mapping.  <https://learn.microsoft.com/en-us/linkedin/talent/apply-connect/receive-applications?view=li-lts-2025-10>
 - [high] Legacy (Ember/artdeco) applicant-list DOM (verified in code dated Jul 2025): `.hiring-applicants__list-item` (card), `.hiring-people-card__title` (name), `.artdeco-entity-lockup__metadata:first-of-type` (title), `.artdeco-entity-lockup__metadata:nth-of-type(2)` (location), `.artdeco-entity-lockup__caption ul li` (experience items), `.hiring-applicant-insights__separator` (applied time), `.hiring-applicant-insights__separator + div span` (qualifications met).  <https://raw.githubusercontent.com/arielsegura/linkedin-applicant-exporter/main/content.js>
 - [high] Legacy applicant-detail DOM (verified in code dated Feb 2024): email and phone appear as `span.hiring-applicant-header-actions__more-content-dropdown-item-text` inside the header 'More' dropdown after clicking it; the resume block is `div.ui-attachment.ui-attachment--doc` (also wrapped in `div.display-flex.justify-space-between.align-items-flex-start.pl5.pr5.pt5.pb3`) and the download href was read from its first <a>; the profile link is `a[href*="/in/"]` inside the detail panel.  <https://raw.githubusercontent.com/manjuq/LinkedIn-Job-Applicant-Scraper/main/LinkedIn_scraper.ipynb>
 - [high] 2026 SDUI hiring-dashboard DOM hints (verified in extension code committed 2026-02-13): resume button `button[data-view-name="hiring-applicant-view-resume"]` (fallback `button[data-view-name*="resume" i]`, `svg[id="document-small"]` closest button, or button whose leaf span text is 'Resume'); download control `svg[id="download-small"]` closest button/anchor, `button[aria-label*="Download" i]`, or a leaf span with exact text 'Download'; applicant cards via `[data-view-name*="applicant" i]`, `[componentkey]`, `[role="list"] > [role="listitem"]|li`, `a[href*="applicationId"]`, `a[href*="applicant"]`; card text markers 'Must-have', 'Preferred', '/3', '/5', '1st/2nd/3rd'; modal close `button[aria-label="Dismiss"]`, `button[aria-label="Close"]`, `.artdeco-modal__dismiss`, `button[data-test-modal-close-btn]`.  <https://raw.githubusercontent.com/developer-nf/parse-linkedin-resume/main/content.js>
 - [high] LinkedIn's current web client is a proprietary Server-Driven UI on React Server Components: class names are hashed (e.g. `_27506df7 e3900514 c816e7f7`), <h1> is absent, and only `componentkey`, `data-view-name`/`data-testid`, aria-labels and text survive deploys. SDUI can be detected by the `sdui_ver` cookie or absence of <h1>/`pv-top-card`. Issue dated 2026-09-22.  (source omitted)
 - [medium] Applicant ratings are exactly 'Good fit', 'Maybe', 'Not a fit'. Good fit steers job-post targeting toward similar candidates, Maybe has no effect, Not a fit steers away; automatic ratings and an auto-rejection message (sent 3 days after 'Not a fit') can be configured.  <https://www.linkedin.com/help/linkedin/answer/a521606>
 - [high] By default the applicants list hides 'Not a fit' applicants: LinkedIn Help says 'To view all applicants, go to the Ratings dropdown filter and click the Not a fit checkbox.' Also: 'For online job postings, bulk downloading or exporting applicant profiles is not available.'  <https://www.linkedin.com/help/linkedin/answer/a517574>
 - [high] Screening-question answers: 'Click the applicant's name to view their responses to the answers for all required screening questions'; a 'meets all the screening requirements' indicator is shown on the applicant's summary card. Answers are also in the per-application notification email ('View full application' link).  <https://www.linkedin.com/help/linkedin/answer/a520618>
 - [high] Applicant list can be sorted by relevance, location, experience, or applicant fit rating; Settings tab filters out-of-country applicants and those failing screening qualifications; Job Analytics exist only for jobs posted after July 2021.  <https://www.linkedin.com/help/linkedin/answer/a520582>
 - [high] Closed jobs: 'You'll still be able to view your job post, and will be able to access your applicant list through the old listing if you've chosen to collect applications on LinkedIn.' Jobs cannot be deleted, only closed, and the Closed tab sorts by creation date. Applicants routed to an external ATS URL are never visible on LinkedIn.  <https://www.linkedin.com/help/linkedin/answer/a520455/access-your-closed-job-posts-on-linkedin>
 - [high] Only the job poster has full access to applicants; up to five coworkers (1st-degree, same company) can be added to 'view, rate, and shortlist'; applicants shared via Share/Forward cannot be rated or annotated by the recipient. Hovering an applicant shows 'Share'; the card has a 'Forward' button; mobile 'More' shows 'Share in a message'.  <https://www.linkedin.com/help/linkedin/answer/a11290040>
 - [medium] Contact email/phone are only present 'when shared' by the applicant; the applicant headline count can exceed the accessible list because of spam, duplicates, withdrawn and revoked applications; 'the Applicants tab pagination total is the source of truth'.  <https://www.applicantsync.com/articles/how-to-export-linkedin-job-applicants-to-excel>
 - [high] Resume download in the 2026 UI: click Resume → viewer opens (PDF URL found in iframe.src / embed.src / object.data or an anchor in [role=dialog]) → Download. PDF URLs are recognised by substrings '.pdf', 'mediaauth', 'ambry', 'dms/', 'media.licdn.com', 'resumeViewer'. The extension downloads with `fetch(url, {credentials:'include'})` → blob → <a download>, i.e. cookie auth suffices and no Referer header is set; files then go through chrome.downloads.download({filename:'LinkedIn_Resumes/<Name>_Resume_<YYYY-MM-DD>.pdf', conflictAction:'uniquify'}). Host permissions include https://*.licdn.com/*.  <https://raw.githubusercontent.com/developer-nf/parse-linkedin-resume/main/background.js>
 - [high] Applicant-uploaded resume media on LinkedIn is served from https://www.linkedin.com/ambry/?x-li-ambry-ep=<opaque token> ('short-lived and will be available for 30 days'); response content-type indicates the file type. Stored blobs are URNs like urn:li:ambryBlob:<opaque-id>.pdf. (Partner-API context; the same Ambry host appears in the web UI URL matchers above.)  <https://learn.microsoft.com/en-us/linkedin/talent/apply-connect/receive-applications?view=li-lts-2025-10>
 - [medium] LinkedIn public document download URLs have the shape https://media.licdn.com/dms/document/<assetId>/<variant e.g. ads-document-pdf-analyzed>/0/<timestamp>?e=<unix expiry>&v=beta&t=<signature>; upload URLs use https://www.linkedin.com/dms-uploads/... . Private ('prv') document paths were not found in public sources.  <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api?view=li-lms-2025-04>
 - [high] Resume file constraints (LinkedIn Talent docs): PDF, DOC, DOCX, TXT; max 10 MB per file.  <https://learn.microsoft.com/en-us/linkedin/talent/middleware-platform/upload-sync-documents?view=li-lts-2026-03>
 - [high] Voyager base URL is https://www.linkedin.com/voyager/api. Default headers used by the Python linkedin-api client: `x-li-lang: en_US`, `x-restli-protocol-version: 2.0.0`, plus `csrf-token` set as `session.cookies['JSESSIONID'].strip('"')`.  <https://raw.githubusercontent.com/nsandman/linkedin-api/master/linkedin_api/client.py>
 - [high] Working same-origin Voyager fetch from a logged-in page needs only `csrf-token: ajax:<jsessionid>` (the JSESSIONID cookie value without quotes), `x-restli-protocol-version: 2.0.0`, an accept header, and credentials:'include'; omitting csrf-token yields 403 CSRF check failed.  <https://github.com/siropkin/chrome-bridge/issues/43>
 - [high] Full browser-equivalent Voyager header set (2026 client): `csrf-token: ajax:<JSESSIONID>`, `x-restli-protocol-version: 2.0.0`, `accept: application/vnd.linkedin.normalized+json+2.1`, `x-li-lang: en_US`, `x-li-track: {"clientVersion":"1.13.*","osName":"web",...}`, `referer: https://www.linkedin.com/feed/`, and the Host header when outside a browser. Cookies li_at, JSESSIONID, lidc and bcookie are all required; li_at rotates during normal use and must live in a cookie jar (pinning a cookie header causes 302 redirect loops from lidc affinity).  <https://github.com/reyyanxahmed/linkedin-profile-api>
 - [medium] Observed x-li-track example: {"clientVersion":"1.13.455","mpVersion":"1.13.455","osName":"web","timezoneOffset":5.5,"timezone":"Asia/Calcutta","deviceFormFactor":"DESKTOP","mpName":"voyager-web","displayDensity":1,"displayWidth":1920,"displayHeight":1080}. x-li-page-instance values look like urn:li:page:d_flagship3_<page>;<22-char base64>== (e.g. urn:li:page:d_flagship3_feed;Aq0f+kTwRKuz0RTNYBF2xA== seen as the lipi URL param).  <https://github.com/lakshyachhangani/LinkedinAPI>
 - [high] Voyager query syntax: `{endpoint}?q=<finder>&<finderArg>=<value>&decorationId=<com.linkedin.voyager.dash.deco....-N>`; decorationIds are server-registered projections whose numeric suffix rotates; GraphQL calls use `/voyager/api/graphql?queryId=<name>.<hash>&variables=(start:0,count:10,...)` with queryIds that change per frontend deploy; responses are Rest.li CollectionResponse with `elements`, `paging {count,start,total}` and, with the normalized accept header, a flat `included` entity graph cross-referenced by entityUrn.  <https://github.com/joshuatz/linkedin-to-jsonresume/blob/main/docs/LinkedIn-Dev-Notes-README.md>
 - [high] No public source documents the hiring dashboard's Voyager/GraphQL endpoint names or decorationIds (searches for 'voyager/api/hiring', 'voyagerHiringDash', 'hiringDashJobApplications', 'com.linkedin.voyager.dash.deco.hiring' returned zero hits on the web, Sourcegraph, and grep.app which rate-limited). They must be captured live from the user's browser.  <https://sourcegraph.com/.api/search/stream?q=context:global+%22voyager/api/hiring%22+count:30&display=30>
 - [high] Closest public model of the Classic (non-Recruiter) applicant object is Unipile's LinkedIn API: GET /api/v1/linkedin/jobs/{id}/applicants with limit 1–100, cursor pagination, filters `ratings=GOOD_FIT,MAYBE,NOT_A_FIT,UNRATED` (Classic), `sort_by` ∈ {relevance, alphabetical, newest_first, screening_requirements}, min/max years of experience filters, keywords; items have id, profile_id, public_identifier, public_profile_url, name, headline, location, applied_at (epoch), rating ∈ {UNRATED,GOOD_FIT,MAYBE,NOT_A_FIT}, email_address, phone_number, contact_info{email_addresses[],phone_numbers[]}, work_experience[], education[], screening_questions[{question,answers[],success}].  <https://developer.unipile.com/reference/linkedincontroller_getjobapplicants>
 - [high] Unipile also exposes GET /api/v1/linkedin/jobs (category=active|draft|closed, limit 1–250; job state ∈ active/draft/review/closed/paused; fields id,title,state,location,applicants_counter,company,company_id,created_at,published_at) and GET /api/v1/linkedin/jobs/applicants/{applicant_id}/resume returning the binary resume (service=CLASSIC|RECRUITER), confirming a per-applicant resume fetch exists in LinkedIn's internals for Classic job posts.  <https://developer.unipile.com/reference/linkedincontroller_getjobapplicantresume>
 - [medium] Full-profile export: legacy `/voyager/api/identity/profiles/{id}/profileView` (and profileContactInfo, skillCategory) return HTTP 410 Gone since ~26–28 Aug 2026. The working call is `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=<publicId>&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-<N>` (N observed as 96 and 101 in Aug–Sep 2026; suffix rotates), with section finders `/identity/dash/profilePositions?q=viewee`, `/identity/dash/profileEducations?q=viewee`, `/identity/dash/profileSkills?q=viewee`, and contact info at `/in/<slug>/overlay/contact-info/`.  <https://github.com/kartik6/linkedin-profile-api>
 - [medium] Profile pages are also served as RSC 'Flight' streams: `POST /flagship-web/in/{public_id}/` (NavigateToScreen body), `GET /in/{public_id}/details/experience/`, `POST /flagship-web/rsc-action/actions/pagination?sduiid=com.linkedin.sdui.pagers.profile.details.{section}`; inline data lives in `window.__como_rehydration__`; typed componentKeys like `com.linkedin.sdui.profile.skill(...)`.  <https://github.com/janithashri/Blackbox-profile-snapshot>
 - [medium] Voyager search collections cap `count` at 49 per page (`_MAX_SEARCH_COUNT = 49  # max seems to be 49`) and the reference client sleeps random 2–5 s between calls (`default_evade`); these are search-endpoint observations, not hiring-endpoint ones.  <https://raw.githubusercontent.com/nsandman/linkedin-api/master/linkedin_api/linkedin.py>
 - [high] Pacing used by working tools: bulk-resume downloader (Feb 2026) uses a random 5–15 s gap between downloads, 600–1500 ms after clicking an applicant, 600–1200 ms after opening the resume, 1.5–3 s after Download, 40–120 ms button hold and eased mouse moves, and warns 'LinkedIn may rate-limit you. Wait a few minutes and try again'; the 2025 exporter waits 5 s after a page click and 3 s after opening a detail panel; ApplicantSync paginates 'at a respectful rate' and reports ~30–60 s per first 100 applicants and ~5 min per additional 1,000.  <https://github.com/developer-nf/parse-linkedin-resume>
 - [low] Community thresholds for logged-in automation (marketing/blog sources, not LinkedIn): ~80–100 profile views per 24 h is the soft limit; 300–400 profiles/day triggers account warnings; <15 s between profile views consistently flags; HTTP 999 or 403 indicate account/IP-level flagging rather than transient rate limits; missing Sec-CH-UA/Sec-Fetch headers and navigator.webdriver=true are detection signals. In 2026 restricted accounts often require government-ID verification.  <https://alterlab.io/blog/how-to-scrape-linkedin-profiles-and-company-data-without-getting-blocked-in-2026>
 - [high] LinkedIn Jobs (job poster) has no native CSV/XLSX export or bulk resume download; only LinkedIn Recruiter has 'Export all to XLSX' (help a7459505) and Recruiter profile export caps of 200 PDF / 5,000 CSV per seat per month.  <https://tcommunity.linkedin.com/product-tips-190/bulk-export-job-applicants-into-an-xlsx-file-1458>
 - [low] Free job posts are paused after a small applicant volume (reports vary: ~26–50 applicants or 14–21 days) and auto-close after 30 days unless promoted; irrelevant for promoted jobs with thousands of applicants but explains 'paused' state.  <https://www.linkedin.com/help/linkedin/answer/a517777>
 - [high] The referenced a third-party LinkedIn MCP server uses Patchright (patched Chromium), imports sessions from locally signed-in browsers into ~/.linkedin-mcp/profile/, exposes profile/company/job-search/messaging tools, has no hiring/applicant features, and is Apache-2.0.  (source omitted)
 - [high] Two open-source Chrome extensions cover this exact dashboard and are the best selector references: arielsegura/linkedin-applicant-exporter (MV3, initial release 2025-07-08, permissions activeTab+downloads, host https://www.linkedin.com/*) and developer-nf/parse-linkedin-resume (MV3, committed 2026-02-13, content scripts on https://www.linkedin.com/hiring/*, /talent/*, /jobs/*, /recruiter/*).  <https://raw.githubusercontent.com/arielsegura/linkedin-applicant-exporter/main/manifest.json>

RECOMMENDATIONS:
 - Do not hard-code Voyager hiring endpoint names: none are public. In Playwright, register page.on('response') before navigating to /hiring/jobs/<id>/applicants/ and persist every response whose URL matches /\/voyager\/api\/.*(hiring|jobApplication|applicant)/i, /\/voyager\/api\/graphql\?queryId=voyagerHiring/i or /\/flagship-web\/rsc-action\//; log the exact URL, queryId, decorationId, headers and body once, then build typed parsers from the captured JSON (Unipile's applicant schema tells you which fields to expect: rating enum, applied_at, contact_info, screening_questions[].success).
 - Implement a two-generation selector map and choose at runtime: if document.cookie contains 'sdui_ver' or document.querySelector('.hiring-applicants__list-item') is null, use the SDUI map (data-view-name / componentkey / aria-label / role / text), otherwise the artdeco map (.hiring-applicants__list-item, .hiring-people-card__title, span.hiring-applicant-header-actions__more-content-dropdown-item-text, .ui-attachment--doc). Never rely on hashed class names in the SDUI build.
 - Prefer URL-driven navigation for resumability: enumerate jobs from /my-items/posted-jobs/ (and ?jobState=CLOSED), then walk /hiring/jobs/<jobId>/applicants/?start=0,25,50… and open /hiring/jobs/<jobId>/applicants/<applicationId>/detail/ directly. Store applicationId as the primary key in SQLite so a crash resumes at the last unfinished id; also verify the page-buttons variant (button[aria-label="Page N"]) and infinite-scroll variant because the UI differs by build.
 - Always tick the Ratings filter's 'Not a fit' checkbox (or query all four rating buckets) before counting: Not-a-fit applicants are hidden by default, so a naive crawl silently misses them. Record the pagination total as the authoritative count and expect it to be lower than the public 'applicants' badge.
 - Download resumes inside the page context, not with Node fetch: locate the Resume button (button[data-view-name="hiring-applicant-view-resume"] → viewer iframe/embed/object src, or the legacy .ui-attachment--doc a[href]), then page.evaluate(fetch(url,{credentials:'include'})) → arrayBuffer → base64 back to Node, or use page.waitForEvent('download') when clicking the Download control. Accept URLs containing .pdf, mediaauth, ambry, dms/ or media.licdn.com; treat them as short-lived signed URLs (Ambry media expires in 30 days) and save the bytes immediately, keeping the original filename from content-disposition when present.
 - Human pacing: randomized 5–15 s between applicants and downloads, 1–3 s after each click, eased mouse movement, occasional back-scrolls, work only within a daily window, and hard caps (start at ≤300 applicant detail views/day and ≤80–100 full /in/ profile visits/day, ramp slowly). Detect 999/403/429 or the 'unusual activity' checkpoint and pause the queue for hours rather than retrying.
 - Attach to the user's real Chrome (chrome.exe --remote-debugging-port=9222 with the user's default profile, then chromium.connectOverCDP) so the li_at/JSESSIONID/lidc/bcookie jar, TLS/HTTP2 fingerprint and Sec-CH-UA headers are genuine; never copy cookies into a fresh Playwright context (li_at rotates and lidc affinity redirect loops appear).
 - If you call Voyager directly from the page context (page.evaluate fetch), send csrf-token = JSESSIONID cookie value without quotes (ajax:...), x-restli-protocol-version: 2.0.0, accept: application/vnd.linkedin.normalized+json+2.1, x-li-lang: en_US, and copy x-li-track / x-li-page-instance from a captured request; keep decorationId/queryId strings in one config table because their version suffixes rotate.
 - For full LinkedIn profiles of applicants, use the current /voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=<slug>&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-<N> (capture N live; legacy profileView is 410 Gone) or simply open /in/<slug>/ in the same tab and parse window.__como_rehydration__ / RSC streams; budget these separately because profile views are the most heavily rate-limited action.
 - Capture the applied timestamp, rating, qualifications-met text and screening answers from the detail panel on first visit and store raw HTML/JSON snapshots per applicant alongside parsed fields, so parser fixes after a LinkedIn deploy can be replayed offline without re-crawling.
 - Build the SQLite schema around jobs(jobId, title, state, applicantsTotal), applications(applicationId PK, jobId, memberSlug, name, headline, location, appliedAt, rating, qualificationsMet, email, phone, resumeUrl, resumePath, status, lastError, attempts), screening_answers(applicationId, question, answer, success), and a queue table with idempotent state transitions (queued→listed→detailed→resume_downloaded→profile_exported) so the background worker can resume after restarts.
 - Plan for LinkedIn deploys: gate each parser with cheap invariants (e.g. name non-empty, appliedAt parsable), fail closed into a 'needs_review' state, and expose an MCP tool that re-captures the network trace for one applicant so selectors/endpoints can be refreshed quickly.

OPEN QUESTIONS:
 - Exact Voyager/GraphQL endpoint names, queryIds and decorationIds used by the hiring dashboard (applications list, application detail, resume, ratings), not publicly documented; must be captured from the user's browser.
 - Whether the current (2026 SDUI) applicants list still honours the ?start=N query parameter or only supports infinite scroll / page buttons; and the exact query-parameter names for rating, sort and screening filters (only Unipile's proxied names, ratings=GOOD_FIT,MAYBE,NOT_A_FIT,UNRATED; sort_by, are known).
 - The open-tab value for /my-items/posted-jobs/?jobState=… (CLOSED is verified; LISTED is inferred) and whether DRAFT/PAUSED states have their own values.
 - How long applicant data and resumes remain accessible on closed jobs (no LinkedIn Help retention statement found).
 - Whether the applicant-detail resume URL is an Ambry link (linkedin.com/ambry/?x-li-ambry-ep=…), a dms/prv/document link or a 'mediaauth' link in the current build, its expiry window, and whether it sets content-disposition with the applicant's original filename.
 - Any hard cap on how many applicants the dashboard will page through for very large jobs (thousands), none documented; needs empirical test on a job with >1,000 applicants.
 - Whether 'Not a fit' auto-rating/auto-rejection is enabled on the user's jobs (it changes which applicants are hidden by default).
 - Precise per-account thresholds that trigger LinkedIn's checkpoint for hiring-dashboard page views (community numbers exist only for profile views).

SNIPPETS:
--- Capture the hiring dashboard's real Voyager/RSC calls once (endpoint discovery) while driving the user's own Chrome via CDP (typescript) ---
import { chromium } from 'playwright';
// Launch the user's Chrome yourself with: open -a 'Google Chrome' --args --remote-debugging-port=9222
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
const seen = new Map<string, any>();
page.on('response', async (res) => {
  const url = res.url();
  const isHiring = /\/voyager\/api\/.*(hiring|jobApplication|applicant)/i.test(url)
    || /\/voyager\/api\/graphql\?.*queryId=voyagerHiring/i.test(url)
    || /\/flagship-web\/rsc-action\//.test(url);
  if (!isHiring) return;
  const req = res.request();
  const key = new URL(url).pathname + (new URL(url).searchParams.get('queryId') ?? '');
  if (seen.has(key)) return;
  const ct = res.headers()['content-type'] ?? '';
  seen.set(key, {
    url, method: req.method(),
    reqHeaders: req.headers(), // copy x-li-track, x-li-page-instance, csrf-token verbatim
    status: res.status(), ct,
    body: ct.includes('json') ? await res.text().catch(() => '') : '<binary/rsc>'
  });
});
await page.goto(`https://www.linkedin.com/hiring/jobs/${jobId}/applicants/`, { waitUntil: 'networkidle' });
// -> persist [...seen.values()] to SQLite table `captured_endpoints` and build parsers from it
--- Two-generation selector map (artdeco 2024-25 vs SDUI 2026) with runtime detection (typescript) ---
export const SEL = {
  legacy: {
    card: '.hiring-applicants__list-item',
    name: '.hiring-people-card__title',
    title: '.artdeco-entity-lockup__metadata:first-of-type',
    location: '.artdeco-entity-lockup__metadata:nth-of-type(2)',
    applied: '.hiring-applicant-insights__separator',
    qualifications: '.hiring-applicant-insights__separator + div span',
    detailLink: 'a[href*="/applicants/"][href*="/detail"]',
    pageBtn: (n: number) => `button[aria-label="Page ${n}"]`,
    nextBtn: '.artdeco-pagination__button--next:not([disabled])',
    moreBtn: 'button[aria-label*="More"]',
    contactItems: 'span.hiring-applicant-header-actions__more-content-dropdown-item-text',
    resumeAttachment: '.ui-attachment.ui-attachment--doc a[href]',
    profileLink: 'a[href*="/in/"]',
  },
  sdui: {
    card: '[role="list"] > [role="listitem"], [data-view-name*="applicant" i]',
    detailLink: 'a[href*="applicationId"], a[href*="/applicants/"]',
    resumeBtn: 'button[data-view-name="hiring-applicant-view-resume"], button[data-view-name*="resume" i]',
    downloadBtn: 'button[aria-label*="Download" i]',
    downloadIcon: 'svg[id="download-small"]',
    viewer: '[role="dialog"] iframe, [role="dialog"] embed, [role="dialog"] object, iframe[src*="dms/"], iframe[src*="ambry"]',
    dismiss: 'button[aria-label="Dismiss"], button[aria-label="Close"], .artdeco-modal__dismiss, button[data-test-modal-close-btn]',
    profileLink: 'a[href*="/in/"]',
  },
};
export async function detectGeneration(page: import('playwright').Page) {
  const cookies = await page.context().cookies('https://www.linkedin.com');
  const sdui = cookies.some(c => c.name === 'sdui_ver') || !(await page.$(SEL.legacy.card));
  return sdui ? 'sdui' : 'legacy';
}
export const RESUME_URL_RE = /(\.pdf|mediaauth|ambry|\/dms\/|media\.licdn\.com|resumeViewer)/i;
--- Download a resume PDF from inside the logged-in page (cookie auth, no Referer needed) and hand bytes to Node (typescript) ---
import { writeFile } from 'node:fs/promises';
export async function downloadResume(page: import('playwright').Page, url: string, outPath: string) {
  const { b64, ct, cd } = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    if (!r.ok) throw new Error(`resume fetch ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { b64: btoa(s), ct: r.headers.get('content-type'), cd: r.headers.get('content-disposition') };
  }, url);
  await writeFile(outPath, Buffer.from(b64, 'base64'));
  return { contentType: ct, originalName: /filename\*?="?([^";]+)/i.exec(cd ?? '')?.[1] };
}
// Alternative when the UI forces a browser download:
// const [dl] = await Promise.all([page.waitForEvent('download'), page.click(SEL.sdui.downloadBtn)]);
// await dl.saveAs(outPath); // dl.suggestedFilename() keeps LinkedIn's filename
--- Call a captured Voyager endpoint from the page context with the exact header set LinkedIn's web client uses (typescript) ---
export async function voyagerGet(page: import('playwright').Page, pathAndQuery: string, track: string, pageInstance: string) {
  return page.evaluate(async ({ pathAndQuery, track, pageInstance }) => {
    const jsession = document.cookie.split('; ').find(c => c.startsWith('JSESSIONID='))?.split('=')[1] ?? '';
    const csrf = decodeURIComponent(jsession).replace(/^"|"$/g, ''); // -> ajax:<16 digits>
    const r = await fetch('https://www.linkedin.com/voyager/api' + pathAndQuery, {
      credentials: 'include',
      headers: {
        'csrf-token': csrf,
        'x-restli-protocol-version': '2.0.0',
        'accept': 'application/vnd.linkedin.normalized+json+2.1',
        'x-li-lang': 'en_US',
        'x-li-track': track,                 // copy verbatim from a captured request
        'x-li-page-instance': pageInstance,  // e.g. urn:li:page:d_flagship3_<page>;<base64>
      },
    });
    if (r.status === 999 || r.status === 429 || r.status === 403) throw new Error(`voyager ${r.status}`);
    return r.json(); // { data: {...}, included: [...] } normalized graph keyed by entityUrn
  }, { pathAndQuery, track, pageInstance });
}
// Example (profile, current as of Sep 2026; suffix rotates):
// voyagerGet(page, `/identity/dash/profiles?q=memberIdentity&memberIdentity=${slug}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-96`, track, pi)
--- Resumable applicants crawl with human-like pacing and 25-per-page offsets (typescript) ---
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function crawlApplicants(page, db, jobId: string) {
  let start = db.get('SELECT COALESCE(MAX(page_start),-25)+25 AS s FROM crawl_progress WHERE job_id=?', jobId).s;
  for (;;) {
    const url = `https://www.linkedin.com/hiring/jobs/${jobId}/applicants/?start=${start}`;
    await page.goto(url, { waitForLoadState: 'domcontentloaded' });
    await sleep(rnd(2500, 6000));
    await page.mouse.wheel(0, rnd(300, 900)); await sleep(rnd(800, 2000)); // trigger lazy-load
    const gen = await detectGeneration(page);
    const cards = await page.$$(SEL[gen].card);
    if (cards.length === 0) break;
    for (const card of cards) {
      const href = await card.$eval(SEL[gen].detailLink, a => (a as HTMLAnchorElement).href).catch(() => null);
      const applicationId = href?.match(/\/applicants\/(\d+)\//)?.[1] ?? new URL(href ?? 'https://x').searchParams.get('applicationId');
      if (!applicationId) continue;
      db.run('INSERT OR IGNORE INTO applications(application_id, job_id, detail_url, status) VALUES (?,?,?,\'listed\')', applicationId, jobId, href);
    }
    db.run('INSERT OR REPLACE INTO crawl_progress(job_id, page_start) VALUES (?,?)', jobId, start);
    start += 25;
    await sleep(rnd(5000, 15000)); // 5–15 s between pages, same band the working 2026 extension uses
  }
}
