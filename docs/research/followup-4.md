# Research notes (2026-09-25, auto-collected; verify before relying on any single claim)

## Follow-up: 

### Summary

VERDICT (medium confidence, no public primary source exists): LinkedIn's /hiring/jobs/<jobId>/applicants/ pages are still served by the legacy Ember "voyager-web" app backed by Voyager (Rest.li normalized JSON / GraphQL), NOT by the SDUI/RSC "flagship-web" app. Evidence: (1) an unauthenticated route probe run 2026-09-25 shows LinkedIn's SDUI app prefix /flagship-web/ has routes for /in/, /feed/, /jobs/, /jobs/view/<id>/, /messaging/, /company/, /mynetwork/ (all return the login page) but returns HTTP 404 for /flagship-web/hiring/, /flagship-web/hiring/jobs/, /flagship-web/hiring/jobs/1/applicants/, /flagship-web/my-items/posted-jobs/, /flagship-web/talent/, /flagship-web/job-posting/ and a nonsense path; (2) a Chrome extension pushed 2026-09-19 still hooks fetch/XHR for /voyager/api/jobs/jobPostings/\d+ JSON on Ember job pages, so Voyager XHR still flows on Ember surfaces this month; (3) every open-source applicant exporter dated 2023 to Jul 2025 uses Ember/artdeco class names (hiring-applicants__list-item, hiring-people-card__title, hiring-applicant-insights__separator, #hiring-detail-root, artdeco-modal, artdeco-dropdown 'More…'), while the only Sept-2026 exporter is class-agnostic (rows found by 'Applied on:' text, headers Name/Title/Company/Location/Qualifications, 'N/M Must-have' / 'N/M Preferred', detail in [role=dialog], contact via mailto:/tel: links and 'contact info' buttons, profile via a[href*="/in/"]) and calls the page the 'Hiring Pro' screen, i.e. the DOM was redesigned but the URL is still /hiring/… and nothing indicates RSC. Consequences: passive page.on('response') Voyager capture IS meaningful on the hiring dashboard, an sdui_ver selector switch is only needed as a safety net, but the exact hiring queryId/decorationId and JSON shape are NOT publicly documented anywhere (confirmed by exhaustive search: no hits for voyagerHiringDash*, hiringDashJobApplications, voyager/api/hiring, com.linkedin.voyager.dash.hiring, fsd_jobApplication) and must be captured once in the user's own session. The applicant → profile linkage is exposed in the UI as an a[href*="/in/<slug>"] link (2023–2025: inside the detail header 'More…' artdeco dropdown next to email/phone; 2026: inside the row/detail dialog). The fsd_profile URN is not visible in the DOM; get it from the Voyager dash profile response (entityUrn urn:li:fsd_profile:ACoAA…) or from the RSC stream ('ACoAA…' string). Profile pages themselves ARE SDUI/RSC in 2026 (GET /flagship-web/in/{slug}/, POST /flagship-web/rsc-action/actions/component?componentId=…&sduiid=…, header x-li-rsc-stream: true, content-type text/x-component), but the Voyager endpoint /voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity={slug}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93 still returns the full profile graph for authenticated sessions (multiple 2026 repos), which is the pragmatic full-profile source once you have the vanity slug. The official Apply Connect webhook schema (MS Learn, updated 2026-09-21) gives LinkedIn's own field names for an application (jobApplicationId urn:li:jobApplication:N, appliedAt epoch-ms, contactInformationQuestionResponses.emailAnswer/cellphoneNumberQuestionAnswer, resumeQuestionAnswer.mediaUrl https://www.linkedin.com/ambry/?x-li-ambry-ep=… with 30-day expiry, customQuestionResponses[].{questionIdentifier, answer.multipleChoiceAnswerValue.symbolicNames[]…}) and is the best available template for the applications / screening_answers tables.

### Facts

- [medium] Route probe on 2026-09-25 (unauthenticated): https://www.linkedin.com/flagship-web/hiring/ , /flagship-web/hiring/jobs/ , /flagship-web/hiring/jobs/1/applicants/ , /flagship-web/my-items/posted-jobs/ , /flagship-web/talent/ , /flagship-web/job-posting/ and /flagship-web/this-route-does-not-exist-xyz/ all return HTTP 404, whereas /flagship-web/in/williamhgates/ , /flagship-web/feed/ , /flagship-web/jobs/ , /flagship-web/jobs/view/1/ , /flagship-web/messaging/ , /flagship-web/company/linkedin/ and /flagship-web/mynetwork/ return the LinkedIn login page (route exists). The SDUI (flagship-web) router therefore has no /hiring/ or /my-items/ routes today.  <https://www.linkedin.com/flagship-web/hiring/jobs/1/applicants/>
- [high] LinkedIn's SDUI/RSC profile transport (2026): GET https://www.linkedin.com/flagship-web/in/{slug}/?skipRedirect=true and POST https://www.linkedin.com/flagship-web/rsc-action/actions/component?componentId={id}&sduiid={id}; required header x-li-rsc-stream: true (otherwise HTML is returned); x-li-application-version must be the SDUI version 0.2.x (e.g. 0.2.7003), not Voyager 1.13.x; other headers x-li-anchor-page-key (d_flagship3_feed / d_flagship3_profile_view_base), x-li-initial-url, x-li-layout-tree (["com.linkedin.sdui.flagshipnav.home.Home#0", …]), x-li-page-instance, x-li-pageforestid, x-li-traceparent, csrf-token, referer. Response content-type text/x-component, line-oriented '<id>:<type>,<json>' with base64 payloads. Component IDs: com.linkedin.sdui.generated.profile.dsl.impl.profileCards{AboveActivity|ExperienceOnly|BelowActivityPart1WithoutExp|BelowActivityPart2..7}; screenId com.linkedin.sdui.flagshipnav.profile.Profile; POST body clientArguments.payload.{isSelfView, vanityName, replaceableSectionArgs.{vanityName, vieweeProfileId}, profileComponentState.profileId}, requestMetadata.$type = proto.sdui.common.RequestMetadata. Profile URN is found as the first 'ACoAA…' string in the stream.  <https://github.com/reyyanxahmed/linkedin-profile-api/blob/main/docs/REVERSE_ENGINEERING.md>
- [high] Voyager still works for profiles in 2026 for authenticated sessions: GET /voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity={slug}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93 (fallbacks seen: -128, -91, -35) returns the flat included[] entity graph (entityUrn urn:li:fsd_profile:…, $type suffixes like Position); GET /voyager/api/identity/profiles/{slug}/positionGroups returns 200; legacy /profileView, /skills, /educations return 410 Gone wrapped as {"data":{"status":410},"included":[]}. Headers: csrf-token = JSESSIONID value (quotes stripped), x-restli-protocol-version: 2.0.0, accept: application/vnd.linkedin.normalized+json+2.1, x-li-lang: en_US, x-li-track {"clientVersion":"1.13.46312","mpVersion":"1.13.46312","osName":"web","deviceFormFactor":"DESKTOP","mpName":"voyager-web",…}. GraphQL queryIds (format voyagerIdentityDashProfiles.<32 hex>) rotate with every frontend deploy; GraphQL variables use Rest.li encoding (colons %3A, parentheses literal), not JSON.  <https://github.com/SlothT/linkedin-profile-scraper>
- [high] iron-mind.ai guide (published 2025-06-13, updated 2026-05-22) confirms the same 2026 Voyager profile endpoint and header set and that the response is a flat included[] array keyed by entityUrn/$type.  <https://iron-mind.ai/blog/linkedin-profile-scraper-python-voyager-api>
- [medium] piyush1457/linkedin-profile-scraper-api (2026) reports LinkedIn's 2026 profile HTML has no H1 (name is H2) and no section ids (#experience, #education do not exist); Experience/Education/Skills are no longer in the server HTML; Voyager API remains the authoritative data source for authenticated sessions; GraphQL voyagerIdentityDashProfiles resolves vanity → member id.  <https://github.com/piyush1457/linkedin-profile-scraper-api>
- [medium] swarmhit (2026): 'Voyager still exists under that name, but LinkedIn's frontend now also talks to a newer server-driven UI layer, with functionality split between the two.' No per-surface breakdown given.  <https://www.swarmhit.com/blog/linkedin-voyager-api>
- [high] Voyager XHR is still live on Ember job pages in Sept 2026: deepu0/linkedin-extension (pushed 2026-09-19, live on Chrome Web Store) patches window.fetch and XMLHttpRequest.open/send, matches /\/voyager\/api\/jobs\/jobPostings\/\d+/, requires content-type application/json, and reads data.data.jobInsightsV2.topApplicantCounts.numOfApplicants, data.data.applies, data.applies and included[].applies where $type matches 'jobs.JobPosting'; fallback direct GET https://www.linkedin.com/voyager/api/jobs/jobPostings/${jobId}?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65; DOM anchor .job-details-fit-level-preferences.  <https://github.com/deepu0/linkedin-extension>
- [high] francescofioredev/linkedin-insights-chrome-extension (pushed 2025-08-27) fetches /voyager/api/jobs/jobPostings/<JOB_ID>?topN=1 from an injected page script with credentials:'include' and csrf-token built from JSESSIONID; reads data.applies, data.views, formattedSalaryDescription, listedAt/expireAt etc.  <https://github.com/francescofioredev/linkedin-insights-chrome-extension>
- [high] Legacy Ember hiring-dashboard DOM as of Jul 2025 (arielsegura/linkedin-applicant-exporter, pushed 2025-07-08, runs on linkedin.com/hiring/jobs/[JOB_ID]/applicants/): list item .hiring-applicants__list-item; name .hiring-people-card__title; title .artdeco-entity-lockup__metadata:first-of-type; location .artdeco-entity-lockup__metadata:nth-of-type(2); experience .artdeco-entity-lockup__caption ul li; applied-time .hiring-applicant-insights__separator; qualifications-met text .hiring-applicant-insights__separator + div span; per-applicant detail link = card's <a href>; after clicking a card it waits 3 s and reads document.querySelector('a[href*="/in/"]') for the profile URL; pagination button[aria-label='Page N'], button[aria-current='true'][aria-label*='Page'], .artdeco-pagination__button--next:not([disabled]); 5 s page-load wait. Applied time is relative text ('2 hours ago').  <https://github.com/arielsegura/linkedin-applicant-exporter>
- [high] Legacy Ember detail panel as of Dec 2024–Jun 2025 (ist00dent/linkedin-candidate-scraper v1.1.0 2024-12-29, pushed 2025-06-30): clicks .hiring-applicants__list-item a[href*="/detail/"], then waitForElement('#hiring-detail-root'); detail root .artdeco-modal__content; opens contact menu via button.artdeco-dropdown__trigger whose text matches /more…/i, then reads .artdeco-dropdown__content-inner ul spans: email = /@/, phone = /\+\d{6,}/, profile URL = dropdown.querySelector('a[href*="/in/"]'); applied date = text with /^Applied\s*/ stripped; screening/must-have answers parsed from 'Ideal answer:' / 'Applicant answer:' text pairs inside <section> elements matching /experience|education|must-have qualifications/i; close via .artdeco-modal__dismiss / button[aria-label='Dismiss']; pagination .artdeco-pagination__button--next.  <https://github.com/ist00dent/linkedin-candidate-scraper>
- [high] bilalsaci/LinkedIn-Applicant-Anonymizer (Oct 2024) manifest content_scripts.matches = ["https://www.linkedin.com/hiring/jobs/*/applicants/*"]; selectors .hiring-selectable-entity > img (photo), .hiring-people-card__title (list name), .hiring-applicant-header h1 (detail header name).  <https://github.com/bilalsaci/LinkedIn-Applicant-Anonymizer>
- [high] manjuq/LinkedIn-Job-Applicant-Scraper (2023, Selenium): navigates https://www.linkedin.com/my-items/posted-jobs/?jobState=CLOSED and https://www.linkedin.com/hiring/jobs/<jobId>/detail/; paginates applicants with `{current_url}&start={i*25}` (25 per page); page numbers ul.artdeco-pagination__pages--number span; email/phone from span.hiring-applicant-header-actions__more-content-dropdown-item-text after clicking 'More'; profile link div.artdeco-dropdown__item.artdeco-dropdown__item--is-dropdown > a[href]; resume container classes 'ui-attachment ui-attachment--doc'.  <https://github.com/manjuq/LinkedIn-Job-Applicant-Scraper>
- [high] Current (Sept 2026) hiring-dashboard exporter Liwin-liwi/Linkedin-Filter-ChromeExtension ('Applicant Exporter for LinkedIn Hiring' v1.2.0, pushed 2026-09-22, MV3, matches https://www.linkedin.com/*) is deliberately class-name agnostic and does NO network interception: launcher shows when URL contains /hiring/, /talent/ or 'applicant'; rows are found via TreeWalker on text matching /Applied\s*(?:on)?\s*:/i then climbing to the smallest ancestor (<420 px) containing exactly one match; columns mapped by header labels HEADER_LABELS = ['Name','Title','Company','Location','Qualifications'] that share one horizontal line; qualifications parsed with /(\d+)\s*\/\s*(\d+)\s*Must-?have/i and /(\d+)\s*\/\s*(\d+)\s*Preferred/i; profile link = row.querySelectorAll('a[href]') where /\/in\//i; detail view detected as visible [role="dialog"], [aria-modal="true"] containing the first name (else new text nodes with the name outside the row); contact reveal clicks buttons whose aria-label/innerText matches /(show|view|see|reveal)\s+(contact|email|phone)|^contact info/i, then reads a[href^="mailto:"], a[href^="tel:"] and text via EMAIL_RE / PHONE_RE; statuses 'Detail view did not open', 'Opened, no contact shown'; no table/tr/role=row usage; no screening-answer or resume extraction; pacing pauseSec>=2 s with 40% jitter, sleeps 1200/2500/1400/900 ms. README calls the surface the 'Hiring Pro' screen and says 'LinkedIn has likely changed its layout' if the Detail view does not open.  <https://github.com/Liwin-liwi/Linkedin-Filter-ChromeExtension>
- [medium] LinkedIn Hiring Pro (business.linkedin.com/hire/hiring-pro) is LinkedIn's SMB hiring product that 'presorts applicants based on your criteria, surfacing best fits', reviews profiles and resumes against specified qualifications, gives 'instant candidate summaries', recommends 25 candidates/day; free and promoted tiers; 'currently available to English-speaking LinkedIn members'. It builds on standard job posts, i.e. the same /hiring/ applicant surface.  <https://business.linkedin.com/hire/hiring-pro>
- [high] LinkedIn Help a517574 'Reviewing job applicants' (updated ~1 year ago): path Jobs icon → Manage job posts → More → Manage job → View applicants; a Ratings dropdown filter exists (e.g. 'Not a fit' checkbox); 'For online job postings, bulk downloading or exporting applicant profiles is not available.'  <https://www.linkedin.com/help/linkedin/answer/a517574/reviewing-job-applicants>
- [high] LinkedIn Help a520618 'View applicant answers to screening questions' (last updated 4 years ago): whether the applicant meets the screening requirements is shown 'next to application on the applicant's profile summary card'; clicking the applicant's name shows full answers to all required screening questions; answers are also in the application-notification email via 'View full application'.  <https://www.linkedin.com/help/linkedin/answer/a520618>
- [medium] LinkedIn Help a517545 'Post a job' (updated ~2 months ago) mentions 'Rejection settings: Filter out and send rejections to applicants who don't provide ideal answers to must-have screening questions' and adding screening questions; related help pages a519651 (Add screening questions) and a522418 (custom screening question best practices; >3 screening questions auto-sorts applicants by answers).  <https://www.linkedin.com/help/linkedin/answer/a517545>
- [medium] ApplicantSync Chrome extension (v3.5.24, updated 2026-08-30) is DOM-based ('reads the data you already see, in your own session'), works on open and closed job posts, and exports per applicant: full name, headline/title, location, LinkedIn profile URL, email and phone (when provided), resume URL + filename (saved as PDF), parsed work experience and education, screening questions and answers, applied date and status, job metadata. Its how-to articles state emails/phones are inside the applicant detail panel (not the list), resumes can be saved one at a time via right-click 'Save link as' on the resume preview, and the list 'paginates and lazy-loads'.  <https://www.applicantsync.com/articles/how-to-export-linkedin-job-applicants-to-excel>
- [medium] Other current commercial exporters: 'Resume Exporter for Recruiters' (Priam Jain) v4.7.0 updated 2026-02-03 (auto-advances pages, exports CSV, emails, phones, resumes; no public source); 'Linkedin Resume Exporter', 'Linkedin Candidates Exporter', none publish code or network details.  <https://chromewebstore.google.com/detail/resume-exporter-for-recru/pgmifkhefggmdhompkbibndokddhkimh>
- [high] Official Apply Connect webhook schema (MS Learn, ms.date 2026-09-21) for a LinkedIn job application: type EXPORT_JOB_APPLICATION; jobApplicationId 'urn:li:jobApplication:12345678'; jobApplicant 'urn:li:person:abc123'; appliedAt epoch ms; questionResponses.contactInformationQuestionResponses.{firstNameAnswer.value, lastNameAnswer.value, emailAnswer.value, cellphoneNumberQuestionAnswer.{countryCode,nationalNumber,extension}, locationAnswer}; resumeQuestionResponses.resumeQuestionAnswer.{mediaUrn 'urn:li:media:…', mediaUrl 'https://www.linkedin.com/ambry/?x-li-ambry-ep=…'} (media available 30 days); coverLetterQuestionResponses; workQuestionResponses; educationQuestionResponses; additionalQuestionResponses.customQuestionSetResponses[].customQuestionResponses[].{questionIdentifier, answer.{multipleChoiceAnswerValue.symbolicNames[] | numericAnswerValue.{integerValue,decimalValue} | textAnswerValue.value | dateAnswerValue | phoneNumberAnswerValue | DocumentAnswerValue}}; applicantSkills[].{skillUrn, skillName, jobMatched, assessmentVerified}.  <https://learn.microsoft.com/en-us/linkedin/talent/apply-connect/receive-applications>
- [high] a third-party LinkedIn MCP server (current) uses Patchright with its own Chromium profile at ~/.linkedin-mcp/profile/ (can import cookies from a signed-in browser), exposes 21 tools (get_person_profile, search_people, get_job_details, search_jobs, messaging, companies, feed…) and has NO hiring/applicant/recruiter tools; its scrapers are DOM-only (e.g. 'main h1', 'a[href*="/in/"]', a[href*="/jobs/view/"], .artdeco-pagination) with no page.on('response') interception and no Ember-vs-SDUI detection.  (source omitted)
- [high] Exhaustive public search (WebSearch, Bing, Brave, Yahoo, Mojeek, DuckDuckGo, Sourcegraph public index incl. archived/forks, GitHub repo search) found ZERO documented occurrences of hiring-dashboard Voyager identifiers such as voyagerHiringDash*, hiringDashJobApplications, /voyager/api/hiring, com.linkedin.voyager.dash.hiring, fsd_jobApplication, or of any text/x-component usage on /hiring/ pages. grep.app and GitHub code search were not reachable (bot challenge / no gh CLI). The exact queryId/decorationId/JSON shape must therefore be captured in-session.  <https://sourcegraph.com/search>
- [high] joshuatz LinkedIn dev notes: Voyager REST pattern {endpoint}?q={qualifier}&{qualifier}={value}&decorationId=com.linkedin.voyager.dash.deco.<domain>.<Name>-<N>; GraphQL endpoints need a server-allow-listed queryId; requires x-restli-protocol-version: 2.0.0; responses contain nested paging {count,start,total} and elements can be nested several layers deep; 'dash' endpoints correspond to LinkedIn's move to lazy-loaded SPA.  <https://github.com/joshuatz/linkedin-to-jsonresume/blob/main/docs/LinkedIn-Dev-Notes-README.md>
- [medium] LinkedIn cookie/session behaviour relevant to in-browser Voyager calls (2026): li_at rotates frequently (three exports minutes apart had different values); Voyager 302s to the same URL setting lidc (datacenter affinity), follow with the cookie jar; a valid web session can still get 999 on /in/{slug} HTML and empty 200 on /flagship-web/in/{slug}/ while /voyager/api/* works; serialize requests per session.  <https://github.com/reyyanxahmed/linkedin-profile-api/blob/main/docs/REVERSE_ENGINEERING.md>

### Recommendations

- Treat the hiring dashboard as Ember+Voyager by default, but make the decision at runtime, per page load, with a two-signal detector: (a) network, any response whose URL includes '/voyager/api/' with content-type 'application/vnd.linkedin.normalized+json' or 'application/json' ⇒ EMBER; any request to '/flagship-web/rsc-action/' or response content-type 'text/x-component' ⇒ SDUI; (b) request header 'x-li-application-version' / x-li-track.clientVersion prefix '1.13.' ⇒ Ember voyager-web, '0.2.' ⇒ SDUI. Persist the detected mode per surface (hiring_list, hiring_detail, profile) in SQLite so the parser strategy is chosen deterministically and logged.
- Because no hiring queryId/decorationId is public, ship a one-time 'discover' MCP tool that opens the applicants list and one applicant detail in the user's Chrome, records every /voyager/api/ response (URL, queryId, decorationId, first 2 KB of body, all distinct $type values in included[]) into a raw_payloads table, and prints a report. Then write the parsers against $type SUFFIXES (e.g. /JobApplication$/, /JobPosting$/, /Profile$/) and field names, never against the exact decorationId version suffix or the queryId, which rotate on every LinkedIn deploy. Store queryIds/decorationIds in a config table with 'last_seen_at' and re-discover automatically when the captured shape stops matching.
- Use passive capture (page.on('response')) from Playwright over CDP on the user's real Chrome rather than issuing your own Voyager calls for the applicant list/detail: the Ember app already fetches the list page (start=N, 25 per page historically) and the detail payload when a card is clicked, so human-like clicking yields the JSON for free and with zero extra request footprint. Only fall back to in-page fetch() (with csrf-token = JSESSIONID, x-restli-protocol-version 2.0.0, accept application/vnd.linkedin.normalized+json+2.1) for the full profile step.
- DOM strategy must be a layered fallback, because the dashboard DOM changed between mid-2025 and Sept 2026 while staying under /hiring/: Strategy A (legacy, ≤2025): .hiring-applicants__list-item, a[href*="/detail/"], #hiring-detail-root, button.artdeco-dropdown__trigger 'More…' → .artdeco-dropdown__content-inner ul (email /@/, phone /\+\d{6,}/, a[href*="/in/"]), .hiring-applicant-insights__separator (applied text) and its '+ div span' (qualifications), 'Ideal answer:' / 'Applicant answer:' pairs for screening; Strategy B (2026 'Hiring Pro' layout): anchor rows on the text /Applied\s*(?:on)?\s*:/i, map columns by header labels Name/Title/Company/Location/Qualifications, parse /(\d+)\s*\/\s*(\d+)\s*Must-?have/i and /Preferred/i, detail = visible [role=dialog]/[aria-modal=true], contacts from a[href^=mailto:], a[href^=tel:] or buttons matching /(show|view|see|reveal)\s+(contact|email|phone)|^contact info/i, profile = a[href*="/in/"] inside the row/dialog. Validate every parsed record against the captured Voyager JSON when both exist, and prefer JSON.
- Applicant → profile linkage: capture the vanity slug from the a[href*="/in/"] link (dropdown in legacy UI, row/dialog in 2026 UI) AND look for 'urn:li:fsd_profile:' / 'ACoAA' strings in the captured detail JSON; store both. For the full-profile export use, in order: (1) in-page fetch of /voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=<slug>&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93 (fallback -128/-91/-35, then /voyager/api/identity/profiles/<slug>/positionGroups) and persist the raw included[] graph; (2) if it 401/410s, navigate to /in/<slug>/ and /in/<slug>/details/experience/ and read DOM text ('main' scoped; the 2026 profile has no #experience id and the name is an H2), or capture the /flagship-web/rsc-action text/x-component stream and flatten it with an RSC line parser. Never call profileView/skills/educations (410).
- Resume PDFs: prefer the in-page resume link (in 2023 the container was .ui-attachment--doc; today locate any <a> whose href contains '/ambry/' or ends with .pdf, or a button/aria-label matching /download|resume|cv/i) and download via Playwright's download event or page.request.get() with the page's cookies; the official Apply Connect schema shows LinkedIn resume media URLs are https://www.linkedin.com/ambry/?x-li-ambry-ep=… and expire (30 days), so download immediately and store the file, the original filename, and sha256; treat the URL itself as ephemeral.
- Model the SQLite schema on LinkedIn's own Apply Connect field names so it stays meaningful whichever transport you end up parsing: applications(id PK, job_id, application_id_from_url, application_urn NULLABLE ('urn:li:jobApplication:N' if seen in JSON), profile_slug, profile_urn NULLABLE, full_name, headline, title, company, location, applied_at_text, applied_at_epoch NULLABLE, rating TEXT NULLABLE ('Good fit'|'Maybe'|'Not a fit'|NULL), must_have_met INT, must_have_total INT, preferred_met INT, preferred_total INT, email, phone_country_code, phone_national, resume_url, resume_filename, resume_local_path, resume_sha256, status, detail_url, raw_payload_id, ui_mode ('ember'|'sdui'), scraped_at); screening_answers(id, application_id FK, position, question_text, ideal_answer, applicant_answer, meets_ideal BOOL, question_identifier NULLABLE, raw_json); raw_payloads(id, url, query_id, decoration_id, content_type, body BLOB, captured_at). Keep raw bodies so columns can be back-filled after the discovery pass without re-scraping.
- Pacing/anti-block: mirror what the surviving 2026 tools do, ≥2–3 s base pause with ~40% jitter between applicants, 1–2.5 s after scroll/page navigation, open the detail view by clicking the name (not by URL), never open more than one profile tab at a time (profile views are visible to applicants and metered), and serialize all requests per session because li_at/lidc rotate under you. Resume the queue from SQLite by (job_id, application_id_from_url).
- Do not build on a third-party LinkedIn MCP server's DOM-only approach for this use case: it has no hiring tools, no response interception and uses its own Chromium profile; your CDP-attach-to-the-user's-Chrome design plus passive Voyager capture is the right fit here.

### Open questions

- Exact Voyager identifiers for the hiring dashboard (list: probably a GraphQL queryId such as voyagerHiringDash…/or a REST collection under /voyager/api/…; detail: the per-application payload including contact info, resume media URL, screening answers, rating) and their JSON $type names, nothing public; must be captured in the user's session with the discovery tool.
- Whether the user's account is in any SDUI ramp for /hiring/: the 404 route probe was unauthenticated and LinkedIn could route logged-in members differently or serve the 'Hiring Pro' list from a different SDUI app prefix (e.g. under /talent/). First run should confirm with the detector.
- In the 2026 'Hiring Pro' layout: is the rating (Good fit / Maybe / Not a fit) rendered as text/aria-label or only as icon state? Are screening answers still rendered as 'Ideal answer:' / 'Applicant answer:' pairs (the Sept-2026 exporter does not extract them at all)? Where exactly is the resume link and is it an /ambry/ URL?
- Does the applicants list URL still accept ?start=N (25/page) or has it moved to infinite scroll only ('paginates and lazy-loads' per ApplicantSync)? Determines the pagination strategy.
- Whether the applicant detail payload/DOM exposes the fsd_profile URN (ACoAA…) or only the vanity slug; if only the slug, the full-profile step needs one extra Voyager call per applicant to resolve the URN.
- Whether in-page Voyager fetches (dash profiles FullProfileWithEntities) from the hiring context trigger LinkedIn's commercial-use / profile-view limits differently from normal browsing; unknown thresholds.

### Snippets

#### Playwright (TypeScript, Node 26), attach to the user's own Chrome over CDP, passively capture Voyager JSON on the hiring dashboard, and detect Ember vs SDUI per page

```typescript
import { chromium, type Page, type Response } from 'playwright';

export type UiMode = 'ember' | 'sdui' | 'unknown';

export async function attachToUsersChrome(cdpUrl = 'http://127.0.0.1:9222') {
  // Start Chrome yourself once with: open -a "Google Chrome" --args --remote-debugging-port=9222
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0]; // the user's real, logged-in profile
  return { browser, context };
}

export interface Captured { url: string; queryId?: string; decorationId?: string; contentType: string; body: string; }

export function installVoyagerCapture(page: Page, onPayload: (c: Captured) => void, onMode: (m: UiMode) => void) {
  let mode: UiMode = 'unknown';
  page.on('request', (req) => {
    const h = req.headers();
    const ver = h['x-li-application-version'] ?? '';
    if (req.url().includes('/flagship-web/rsc-action/') || h['x-li-rsc-stream'] === 'true' || ver.startsWith('0.2.')) {
      if (mode !== 'sdui') { mode = 'sdui'; onMode(mode); }
    } else if (req.url().includes('/voyager/api/') || ver.startsWith('1.13.')) {
      if (mode !== 'ember') { mode = 'ember'; onMode(mode); }
    }
  });
  page.on('response', async (res: Response) => {
    const url = res.url();
    const ct = (res.headers()['content-type'] ?? '').toLowerCase();
    const isVoyagerJson = url.includes('/voyager/api/') && (ct.includes('vnd.linkedin.normalized+json') || ct.includes('application/json'));
    const isRsc = ct.includes('text/x-component');
    if (!isVoyagerJson && !isRsc) return;
    let body = '';
    try { body = await res.text(); } catch { return; } // body may be gone for redirects/aborted
    const u = new URL(url);
    onPayload({ url, queryId: u.searchParams.get('queryId') ?? undefined, decorationId: u.searchParams.get('decorationId') ?? undefined, contentType: ct, body });
  });
}

// Discovery helper: list distinct $type values in a normalized+json payload so you can pick the hiring entities.
export function distinctTypes(body: string): string[] {
  try {
    const j = JSON.parse(body);
    const inc: any[] = Array.isArray(j?.included) ? j.included : [];
    return [...new Set(inc.map((e) => e?.$type).filter(Boolean))].sort();
  } catch { return []; }
}
```

#### Human-paced walk of the applicants list + detail with layered DOM fallback (legacy 2025 selectors first, then the class-agnostic 2026 'Hiring Pro' strategy). Contact info / profile link extraction inside the detail view.

```typescript
import type { Page, Locator } from 'playwright';

const jitter = (ms: number) => ms + Math.floor(Math.random() * ms * 0.4);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function openApplicants(page: Page, jobId: string) {
  await page.goto(`https://www.linkedin.com/hiring/jobs/${jobId}/applicants/`, { waitUntil: 'domcontentloaded' });
  await sleep(jitter(2500));
}

// Strategy A (legacy Ember, seen through Jul 2025). Strategy B (Sept 2026 layout): rows anchored on 'Applied on:' text.
export async function listRows(page: Page): Promise<Locator[]> {
  const legacy = page.locator('.hiring-applicants__list-item');
  if (await legacy.count()) return legacy.all();
  const rows = page.locator('li, div').filter({ hasText: /Applied\s*(?:on)?\s*:/i }).filter({ has: page.locator('a[href*="/in/"], a[href*="/detail/"], button') });
  return rows.all();
}

export async function openDetail(page: Page, row: Locator) {
  const link = row.locator('a[href*="/detail/"]').first();
  if (await link.count()) { await link.click(); }
  else { await row.locator('a, button').first().click(); }
  // legacy: #hiring-detail-root inside .artdeco-modal ; 2026: [role=dialog]/[aria-modal=true]
  await page.locator('#hiring-detail-root, [role="dialog"], [aria-modal="true"]').first().waitFor({ timeout: 10_000 });
  await sleep(jitter(1400));
}

export async function readContactAndProfile(page: Page) {
  const root = page.locator('#hiring-detail-root, [role="dialog"], [aria-modal="true"]').first();
  // legacy 'More…' artdeco dropdown
  const more = root.locator('button.artdeco-dropdown__trigger').filter({ hasText: /more/i }).first();
  if (await more.count()) { await more.click(); await sleep(jitter(900)); }
  else {
    const reveal = root.locator('button, [role="button"]').filter({ hasText: /(show|view|see|reveal)\s+(contact|email|phone)|^contact info/i }).first();
    if (await reveal.count()) { await reveal.click(); await sleep(jitter(900)); }
  }
  const text = await root.innerText();
  const email = (await root.locator('a[href^="mailto:"]').first().getAttribute('href').catch(() => null))?.replace(/^mailto:/, '')
    ?? text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
  const phone = (await root.locator('a[href^="tel:"]').first().getAttribute('href').catch(() => null))?.replace(/^tel:/, '')
    ?? text.match(/\+?\d[\d\s().-]{7,16}\d/)?.[0] ?? null;
  const profileHref = await root.locator('a[href*="/in/"]').first().getAttribute('href').catch(() => null);
  const slug = profileHref?.match(/\/in\/([^/?#]+)/)?.[1] ?? null;
  const applied = text.match(/Applied\s*(?:on)?\s*:?\s*([^\n]+)/i)?.[1]?.trim() ?? null;
  const mustHave = text.match(/(\d+)\s*\/\s*(\d+)\s*Must-?have/i);
  const preferred = text.match(/(\d+)\s*\/\s*(\d+)\s*Preferred/i);
  // legacy screening pairs
  const screening: { question: string; ideal: string | null; answer: string | null }[] = [];
  const re = /([^\n]+)\n\s*Ideal answer:\s*([^\n]+)\n\s*Applicant answer:\s*([^\n]+)/gi;
  for (const m of text.matchAll(re)) screening.push({ question: m[1].trim(), ideal: m[2].trim(), answer: m[3].trim() });
  return { email, phone, profileHref, slug, applied, mustHave: mustHave ? { met: +mustHave[1], total: +mustHave[2] } : null, preferred: preferred ? { met: +preferred[1], total: +preferred[2] } : null, screening, rawText: text };
}

export async function downloadResume(page: Page, dir: string) {
  const root = page.locator('#hiring-detail-root, [role="dialog"], [aria-modal="true"]').first();
  const a = root.locator('a[href*="/ambry/"], a[href$=".pdf"], a[download], .ui-attachment--doc a').first();
  if (!(await a.count())) return null;
  const href = await a.getAttribute('href');
  if (!href) return null;
  // Same-origin, cookies included; ambry URLs are short-lived, so fetch immediately.
  const res = await page.request.get(href);
  if (!res.ok()) return null;
  const buf = await res.body();
  const cd = res.headers()['content-disposition'] ?? '';
  const filename = cd.match(/filename\*?="?(?:UTF-8'')?([^";]+)/i)?.[1] ?? 'resume.pdf';
  return { href, filename, bytes: buf };
}
```

#### Full-profile step: in-page Voyager dash call with the page's own cookies/CSRF (works for authenticated sessions in 2026; decorationId suffix may rotate, try fallbacks), returning the flat included[] graph and the fsd_profile URN

```typescript
import type { Page } from 'playwright';

const DECOS = [
  'com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93',
  'com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-128',
  'com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-91',
  'com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-35',
];

export async function fetchDashProfile(page: Page, slug: string) {
  return page.evaluate(async ({ slug, DECOS }) => {
    const jsession = document.cookie.match(/JSESSIONID="?([^";]+)/)?.[1];
    if (!jsession) throw new Error('no JSESSIONID (not logged in?)');
    const headers = {
      'csrf-token': jsession,
      'x-restli-protocol-version': '2.0.0',
      accept: 'application/vnd.linkedin.normalized+json+2.1',
      'x-li-lang': 'en_US',
    };
    for (const deco of DECOS) {
      const url = `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(slug)}&decorationId=${deco}`;
      const r = await fetch(url, { headers, credentials: 'include' });
      if (r.status === 200) {
        const j = await r.json();
        const inc: any[] = j.included ?? [];
        const profile = inc.find((e) => typeof e?.entityUrn === 'string' && e.entityUrn.startsWith('urn:li:fsd_profile:'));
        return { ok: true, deco, profileUrn: profile?.entityUrn ?? null, json: j };
      }
      if (r.status !== 400 && r.status !== 404) return { ok: false, status: r.status, deco }; // 401/999 => back off, do not hammer
    }
    return { ok: false, status: 400 };
  }, { slug, DECOS });
}
// Fallback when Voyager is refused: navigate to /in/<slug>/details/experience/ etc. and read `main` innerText,
// or capture the /flagship-web/rsc-action text/x-component stream (see rsc parser).
```

#### Minimal RSC/flight (text/x-component) line parser to flatten LinkedIn SDUI payloads into text strings (port of the 2026 Python approach)

```typescript
// Lines look like `<idHex>:<typeChar>,<json>` ; typeChar '[' or '0' (component trees) are parsed, 'I' (imports) and 'T' (text blobs) skipped.
export function rscToStrings(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const NOT_CONTENT = /^(\$|[0-9a-f-]{32,}|#[0-9a-f]{3,8}$|[a-z]+[A-Z][A-Za-z0-9]*$|\d+$)/;
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      const s = v.trim();
      if (s.length >= 2 && !NOT_CONTENT.test(s) && !seen.has(s)) { seen.add(s); out.push(s); }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  for (const line of body.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const rest = line.slice(i + 1);
    const t = rest[0];
    if (t === 'I' || t === 'T') continue;
    const comma = rest.indexOf(',');
    const jsonPart = (t === '[' || t === '{') ? rest : rest.slice(comma + 1);
    try { walk(JSON.parse(jsonPart)); } catch { /* skip malformed */ }
  }
  return out;
}
// Profile URN inside the stream: first string starting with 'ACoAA' => `urn:li:fsd_profile:${id}`.
```

#### SQLite schema modelled on LinkedIn's own Apply Connect application fields; raw payload storage lets you backfill after the in-session discovery pass

```sql
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY, title TEXT, state TEXT CHECK(state IN ('OPEN','CLOSED')), company_page TEXT,
  applicants_url TEXT, total_applicants INTEGER, last_synced_at TEXT
);
CREATE TABLE IF NOT EXISTS raw_payloads (
  id INTEGER PRIMARY KEY, job_id TEXT, url TEXT NOT NULL, query_id TEXT, decoration_id TEXT,
  content_type TEXT, body BLOB NOT NULL, captured_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  application_id TEXT,                 -- numeric id from /hiring/jobs/<job>/applicants/<id>/detail/
  application_urn TEXT,                -- 'urn:li:jobApplication:N' if seen in JSON
  profile_slug TEXT,                   -- from a[href*="/in/"]
  profile_urn TEXT,                    -- 'urn:li:fsd_profile:ACoAA…' from Voyager/RSC
  full_name TEXT, headline TEXT, title TEXT, company TEXT, location TEXT,
  applied_at_text TEXT, applied_at_epoch INTEGER,
  rating TEXT,                         -- 'Good fit' | 'Maybe' | 'Not a fit' | NULL
  must_have_met INTEGER, must_have_total INTEGER, preferred_met INTEGER, preferred_total INTEGER,
  email TEXT, phone_country_code TEXT, phone_national TEXT,
  resume_url TEXT, resume_filename TEXT, resume_local_path TEXT, resume_sha256 TEXT,
  status TEXT, detail_url TEXT, ui_mode TEXT CHECK(ui_mode IN ('ember','sdui','unknown')),
  raw_payload_id INTEGER REFERENCES raw_payloads(id),
  scraped_at TEXT DEFAULT (datetime('now')),
  UNIQUE(job_id, application_id)
);
CREATE TABLE IF NOT EXISTS screening_answers (
  id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  position INTEGER, question_text TEXT, ideal_answer TEXT, applicant_answer TEXT, meets_ideal INTEGER,
  question_identifier TEXT, raw_json TEXT
);
CREATE TABLE IF NOT EXISTS profiles (
  profile_slug TEXT PRIMARY KEY, profile_urn TEXT, source TEXT CHECK(source IN ('voyager_dash','rsc','dom')),
  decoration_id TEXT, raw_json BLOB, fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY, kind TEXT CHECK(kind IN ('list_page','detail','resume','profile')),
  job_id TEXT, application_id TEXT, profile_slug TEXT, attempts INTEGER DEFAULT 0,
  state TEXT DEFAULT 'pending' CHECK(state IN ('pending','running','done','failed')), last_error TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS li_identifiers (  -- rotating queryIds/decorationIds discovered in-session
  surface TEXT, kind TEXT, value TEXT, first_seen_at TEXT, last_seen_at TEXT, PRIMARY KEY(surface, kind, value)
);
```

#### Reference: legacy-Ember selector map (2023–Jul 2025) vs 2026 class-agnostic anchors, as a data table for the selector-switch

```typescript
export const HIRING_SELECTORS = {
  legacy: {
    listItem: '.hiring-applicants__list-item',
    listName: '.hiring-people-card__title, .artdeco-entity-lockup__title',
    listTitle: '.artdeco-entity-lockup__metadata:first-of-type',
    listLocation: '.artdeco-entity-lockup__metadata:nth-of-type(2)',
    listAppliedText: '.hiring-applicant-insights__separator',
    listQualifications: '.hiring-applicant-insights__separator + div span',
    detailLink: 'a[href*="/detail/"]',
    detailRoot: '#hiring-detail-root',
    detailModal: '.artdeco-modal__content',
    detailName: '.hiring-applicant-header h1',
    moreButton: 'button.artdeco-dropdown__trigger', // text /more/i
    moreItems: '.artdeco-dropdown__content-inner ul span.hiring-applicant-header-actions__more-content-dropdown-item-text, .artdeco-dropdown__content-inner ul span',
    moreProfileLink: '.artdeco-dropdown__content-inner a[href*="/in/"], div.artdeco-dropdown__item a[href*="/in/"]',
    resumeContainer: '.ui-attachment.ui-attachment--doc',
    pageButton: (n: number) => `button[aria-label='Page ${n}']`,
    nextButton: ".artdeco-pagination__button--next:not([disabled]):not([aria-disabled='true']), button[aria-label*='Next']:not([disabled])",
    currentPage: "button[aria-current='true'][aria-label*='Page'], .artdeco-pagination__indicator.active.selected",
    dismiss: ".artdeco-modal__dismiss, button[aria-label='Dismiss']",
    urlPageParam: 'start', // &start=25 (25 per page, 2023)
  },
  hiringPro2026: {
    rowAnchorText: /Applied\s*(?:on)?\s*:/i,
    headerLabels: ['Name', 'Title', 'Company', 'Location', 'Qualifications'],
    mustHave: /(\d+)\s*\/\s*(\d+)\s*Must-?have/i,
    preferred: /(\d+)\s*\/\s*(\d+)\s*Preferred/i,
    detail: '[role="dialog"], [aria-modal="true"]',
    contactReveal: /(show|view|see|reveal)\s+(contact|email|phone)|^contact info/i,
    email: 'a[href^="mailto:"]',
    phone: 'a[href^="tel:"]',
    profile: 'a[href*="/in/"]',
    nextButtonText: /^(next|next page|load more|show more|show more results)$/i,
  },
} as const;
```
