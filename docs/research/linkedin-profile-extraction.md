# Research notes (2026-09-25, auto-collected; verify before relying on any single claim)

####################################################################################################
SUMMARY: Bottom line (as of 2026-09-25): LinkedIn's web client is now "flagship-web", React Server Components + Server-Driven UI (SDUI). On accounts that have the SDUI rollout (marker: an `sdui_ver` cookie on .linkedin.com), the profile page has NO `<h1>`, hashed class names (`_27506df7 e3900514`), mostly-UUID `componentkey` attributes, no embedded `<code id="bpr-guid-…">` JSON, and loading a profile issues no Voyager JSON calls at all: the page does GET `/flagship-web/in/<slug>/` and POSTs to `/flagship-web/rsc-action/actions/component?componentId=com.linkedin.sdui.generated.profile.dsl.impl.profileCards…` receiving RSC "flight" payloads (line format `<hexid>:<type>,<json>`, sometimes base64) that describe UI, not domain entities. This has broken every class-name-based DOM scraper (joeyism issue #291 May 2026; eliasbiondo/that third-party project #7 Sept 22 2026). Jobs, posts, search and messaging pages still render the legacy Ember DOM and still call `/voyager/api/…`.

The most robust data source is still the legacy Voyager Rest.li REST surface, callable from inside the logged-in browser (same cookies): `GET /voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=<vanity>&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-101` (verified live 2026-08-26/27/28 by three independent reverse-engineering repos; versions -93, -96, -101 all seen working in 2025-26, -128 used as a fallback) with headers `csrf-token: <JSESSIONID value, quotes stripped>`, `x-restli-protocol-version: 2.0.0`, `accept: application/vnd.linkedin.normalized+json+2.1`. One ~70–120 KB response returns a flat `{data:{"*elements":[urn]}, included:[{entityUrn,$type,…}]}` graph with Profile, PositionGroup→Position, Education, Skill (first 20 only), Certification, Language, Project, Publication, Honor, VolunteerExperience, Course plus referenced Company/School/Geo/EmploymentType entities; `*field` keys are URN pointers into `included`. It truncates long collections (kartik6 measured 10 of 11 positions, 20 of 39 skills), so top up with `GET /voyager/api/identity/dash/profile{Positions|Educations|Skills|Certifications|Languages|Projects|VolunteerExperiences|Honors|Publications|Courses|Patents|Organizations|TestScores}?q=viewee&profileUrn=urn:li:fsd_profile:<id>&start=0&count=100`. The old `/voyager/api/identity/profiles/<id>/profileView` returns HTTP 410 Gone (since ~Nov 2025), and REST `/identity/dash/profileCards|profileComponents` return 404. Contact info: legacy `/voyager/api/identity/profiles/<id>/profileContactInfo` still worked 2026-08-26; the GraphQL `voyagerIdentityDashProfiles.13618f886ce95bf503079f49245fbd6f&queryName=ProfilesByMemberIdentity` variant (StaffSpy) returns emailAddress/phoneNumbers/websites/address/birthDateOn, but LinkedIn only exposes email/phone for 1st-degree connections; applicants' email/phone should come from the application itself in the hiring dashboard.

The section GraphQL queries the legacy Ember profile page used (`voyagerIdentityDashProfileComponents.277ba7d7b9afffb04683953cede751fb&queryName=ProfileComponentsBySectionType&variables=(tabIndex:0,sectionType:experience,profileUrn:…,count:50)`, `voyagerIdentityDashProfileCards.9ad2590cb61a073ad514922fa752f566&queryName=ProfileTabInitialCards`) have carried the same hashes in StaffSpy since Aug 2024 and were still used mid-2025, so passive `page.on('response')` capture of `/voyager/api/graphql?…voyagerIdentityDashProfile…` remains worthwhile on non-SDUI accounts (URL substrings: `/voyager/api/graphql`, `identityDashProfileComponentsBySectionType`, `identityDashProfileCardsByInitialCards`, `/voyager/api/identity/dash/`); these are NOT `included`-style, they are nested `components.pagedListComponent.components.elements[].components.entityComponent{titleV2.text.text, subtitle.text, caption.text, metadata.text}` trees (parser in StaffSpy). On SDUI accounts the captured responses are RSC (`x-li-rsc-stream: true`, `text/x-component`), and the only working open-source RSC parser (reyyanxahmed) pattern-matches pooled text, fragile.

Maintained DOM scrapers and how they fare: a third-party LinkedIn MCP server (3.6k stars, pushed 2026-09-25, Patchright) deliberately never calls Voyager; it navigates one URL per section (`/`, `/details/experience/`, `/details/education/`, `/details/skills/`, `/details/certifications/`, `/details/languages/`, `/details/projects/`, `/details/honors/`, `/details/interests/`, `/overlay/contact-info/`, `/recent-activity/all/`), waits for `main` (or `dialog[open], .artdeco-modal__content` for the overlay), scrolls, and returns `innerText` + `a[href]` references, with NAV_DELAY 2.0 s and a 5 s rate-limit backoff; known open issues: skills list only loads on viewport-centre wheel events (~10 skills otherwise, #590), contact-info overlay falls back to page text (#1094), top-card `<section>` no longer rendered (#1000). joeyism/linkedin_scraper 3.1.2 (Playwright, 4.5k stars, pushed 2026-04-10) still uses `h1`, `.text-body-small.inline.t-black--light.break-words`, `.pv-top-card-profile-picture img[title*="#OPEN_TO_WORK"]`, `[data-view-name="profile-card"]`, `h2:has-text("Experience")`, `span[aria-hidden="true"]`, `div[data-view-name="profile-component-entity"]`, `.pvs-list__container .pvs-list__paged-list-item`, all legacy-DOM only. tomquirk/linkedin-api's GitHub repo returns 404 today (PyPI last release 2.3.1, 2024-11-07). StaffSpy (Voyager HTTP) last pushed 2025-06-17 and has LinkedIn-side breakage issues (#75 Sept 2025, #76 Nov 2025). josephlimtech Puppeteer scraper last pushed 2024-04.

Save to PDF: official help (a541960), open the member's profile → "More" (or "Resources") → "Save to PDF"; works for other members' profiles; English profiles/UI only; desktop only; official cap "200 PDF downloads per month" (third-party sources say 100/month for others' profiles). The underlying network call is not publicly documented; automate via the button + Playwright's `download` event.

Limits and detection: LinkedIn's official Commercial Use Limit page says counted actions are profile searches, browsing via "People Also Viewed", and viewing profiles on a Page's People tab; NOT counted: searching by name, browsing 1st-degree connections, job search; resets midnight PST on the 1st; LinkedIn will not disclose the remaining count. Practitioner consensus (2026): ~300 searches/month before CUL on free; safe profile views ≈ 80–100/day on a warmed normal account (lobstr ~80, socialnexis 80–100, lilachbullock 80–150; 30–40 for accounts < 6 months), Premium ~150, Sales Navigator/Recruiter 1,000–2,000. What trips the "unusual activity"/checkpoint: bursts (e.g. 30 actions in 10 min then silence), sub-5–10 s dwell per profile, strictly sequential order, sudden volume jumps, datacenter IPs, concurrent sessions from different IPs, new accounts, automation-library fingerprints (`navigator.webdriver`, `__pwInitScripts`, `HeadlessChrome`, Chrome-for-Testing UA); that third-party project's own fingerprint measurements show a real headed Google Chrome with no overrides scores best (CreepJS 0%/44%), exactly the user's setup. Failure signatures to detect and pause on: navigation to `/checkpoint/*`, `/challenge/*`, `/authwall`, `/uas/login`, `/uas/consumer-email-challenge`, `/login`; Voyager HTTP 429 (has `retry-after`), HTTP 999 (edge bot block), reason `INKApi Error` or 302 with `Set-Cookie: li_at="delete me"` (session revoked), and 200 responses with an HTML login page instead of JSON.

FACTS:
 - [high] LinkedIn's flagship web app is now React Server Components with server-driven UI; loading a profile issues no data API calls at all, it POSTs to /flagship-web/rsc-action/… and receives RSC flight payloads wrapping SDUI component trees with hashed class names and no stable field names. Verified against a live authenticated session 2026-08-26.  <https://github.com/rohhann12/linkedin-rev-eng>
 - [high] On accounts receiving the new SDUI profile markup there is no <h1> (name is in an <h2>/<p> with hashed classes like `_27506df7 e3900514 c816e7f7`), legacy classes (pv-top-card, text-body-medium, text-body-small, break-words) are gone, elements carry a `componentkey` attribute that is ~95% random UUIDs, data-testid values are generic (`carousel`, `lazy-column`, `expandable-text-box`), and there are no embedded JSON <code> blocks; job search and post pages still use the legacy DOM. Issue opened 2026-09-22.  (source omitted)
 - [medium] The `sdui_ver` cookie (domain .linkedin.com, ~1 day) marks that LinkedIn is serving the new SDUI rendering to that browser; a logged-in cookie jar looks like: sdui_ver, JSESSIONID, lang, bcookie, bscookie, lidc, __cf_bm, timezone plus `li_at` (li_at exists only after authentication).  <https://github.com/mautrix/linkedin/issues/67>
 - [high] GET /voyager/api/identity/profiles/{id}/profileView returns HTTP 410 Gone (reported in StaffSpy 2025-11-02; kartik6 confirms 'LinkedIn retired it' 2026-08-28). REST /identity/dash/profileCards/... and /identity/dash/profileComponents/... return 404 on every variant tried.  <https://github.com/cullenwatson/StaffSpy/issues/76>
 - [high] GET https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=<vanity>&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-101 works (one call, ~68 KB: profile, positions, position groups, education, projects, skills, featured media, plus referenced companies and schools). Decoration IDs captured from the web app 2026-08-27 also include WebTopCardCore-16 (resolves Geo for a readable location).  <https://github.com/SharmaNityam/linkedin-profile-api>
 - [high] FullProfileWithEntities-96 verified 2026-08-28: 120 KB, 129 entities, but it truncates collections (10 of 11 positions, 20 of 39 skills). Complete lists come from per-section routes: GET /voyager/api/identity/dash/profile{Positions,Educations,Skills,Certifications,Languages,Projects,VolunteerExperiences,Honors,Publications,Courses,Patents,Organizations,TestScores}?q=viewee&profileUrn=urn:li:fsd_profile:<id>&start=0&count=100 (page size 100).  <https://raw.githubusercontent.com/kartik6/linkedin-profile-api/main/app/linkedin/strategies/voyager_dash.py>
 - [high] `q=memberIdentity` accepts the vanity name directly; `q=publicIdentifier` returns 400; passing a full urn:li:fsd_profile URN as memberIdentity returns 403 VoyagerUserVisibleException; `profileUrn` must be the full URN percent-encoded once (`urn%3Ali%3Afsd_profile%3A…`), double-encoding to %253A fails.  <https://raw.githubusercontent.com/kartik6/linkedin-profile-api/main/app/linkedin/strategies/voyager_dash.py>
 - [high] Required headers for Voyager: `csrf-token` = JSESSIONID cookie value with surrounding quotes stripped (e.g. ajax:<digits>), `x-restli-protocol-version: 2.0.0`, `accept: application/vnd.linkedin.normalized+json+2.1` (this accept header 'flips responses into the flat normalised form; without it you get a deeply nested blob'), plus `x-li-lang: en_US`; auth cookies li_at + JSESSIONID. Some clients also send x-li-track {clientVersion:'1.13.x', mpName:'voyager-web', osName:'web', deviceFormFactor:'DESKTOP'}.  <https://raw.githubusercontent.com/SlothT/linkedin-profile-scraper/main/app/linkedin/constants.py>
 - [high] Normalized Voyager response envelope is {data:{'*elements':[urn,…], paging}, included:[{entityUrn, $type, …}]}; `*`-prefixed keys are URN pointers into `included`; collections are referenced as urn:li:collectionResponse:… entities whose `*elements` list member URNs; `included` order does not match page order, so re-order by data['*elements'].  <https://raw.githubusercontent.com/joshuatz/linkedin-to-jsonresume/main/src/main.js>
 - [high] Dash entity $type values: com.linkedin.voyager.dash.identity.profile.Profile / PositionGroup / Position / Education / Skill / Certification / Language / Project / Publication / Honor / VolunteerExperience / Course; organizations are com.linkedin.voyager.dash.organization.Company (and School); URN prefixes: fsd_profile, fsd_profilePosition, fsd_profilePositionGroup, fsd_profileEducation, fsd_skill/fsd_profileSkill, fsd_profileCertification, fsd_profileLanguage, fsd_profileProject, fsd_profileHonor, fsd_profilePublication, fsd_profileCourse, fsd_profilePatent, fsd_profileOrganization, fsd_profileTestScore, fsd_profileVolunteerExperience, fsd_company.  <https://raw.githubusercontent.com/kartik6/linkedin-profile-api/main/app/linkedin/strategies/voyager_dash.py>
 - [high] Field names (from a normalizer verified 2026-08-27): Profile{publicIdentifier, entityUrn, firstName, lastName, headline, summary, pronounUnion{standardizedPronoun|customPronoun}, showPremiumSubscriberBadge, profilePicture.displayImageReference.vectorImage{rootUrl, artifacts[{width,height,fileIdentifyingUrlPathSegment}]}, backgroundPicture, geoLocation.*geo→Geo.defaultLocalizedName, locationName, location.countryCode, *industry→.name, *profilePositionGroups, *profileEducations, *profileSkills, *profileCertifications, *profileLanguages, *profileVolunteerExperiences, *profileProjects, *profileHonors, *profilePublications, *profileCourses}; PositionGroup{companyName, *company, *profilePositionInPositionGroup}; Position{title, companyName, *company, *employmentType→.name, locationName|geoLocationName, description, dateRange{start{year,month},end{year,month}}}; Education{schoolName, *school, degreeName, fieldOfStudy, grade, activities, description, dateRange}; Skill{name}; Certification{name, authority, *company, licenseNumber, url, dateRange}; Language{name, proficiency ∈ ELEMENTARY|LIMITED_WORKING|PROFESSIONAL_WORKING|FULL_PROFESSIONAL|NATIVE_OR_BILINGUAL}; VolunteerExperience{role, companyName, *company, cause, description, dateRange}; Project{title, description, url, dateRange}; Honor{title, issuer, description, issuedOn{year,month}}; Publication{name, publisher, description, url, publishedOn}; Course{name, number}. Photo URL = rootUrl + fileIdentifyingUrlPathSegment (pick largest artifact).  <https://raw.githubusercontent.com/SharmaNityam/linkedin-profile-api/main/src/linkedin/voyager/normalize.ts>
 - [medium] Voyager omits empty fields entirely (no nulls), so parsers must use optional access everywhere; the Profile entity also carries boolean `premium`, `influencer`, `creator` flags; SlothT uses decoration candidates FullProfileWithEntities-93 then -128 as fallback.  <https://github.com/SlothT/linkedin-profile-scraper>
 - [high] Skills beyond the inline cap are paged with GET /voyager/api/identity/dash/profileSkills?q=viewee&profileUrn=<urn>&start=20&count=50 (SharmaNityam caps at 200; kartik6 uses count=100).  <https://raw.githubusercontent.com/SharmaNityam/linkedin-profile-api/main/src/linkedin/voyager/endpoints.ts>
 - [medium] Legacy contact endpoint /voyager/api/identity/profiles/{publicId}/profileContactInfo (equivalent to the /in/<slug>/overlay/contact-info/ page) was still live on 2026-08-26.  <https://github.com/rohhann12/linkedin-rev-eng>
 - [medium] GraphQL contact/top-card query used by StaffSpy: /voyager/api/graphql?queryId=voyagerIdentityDashProfiles.13618f886ce95bf503079f49245fbd6f&queryName=ProfilesByMemberIdentity&variables=(memberIdentity:<id>,count:1) → data.identityDashProfilesByMemberIdentity.elements[0] with emailAddress.emailAddress, phoneNumbers[].phoneNumber.number, websites[].url, address, birthDateOn{month,day}, memberRelationship.memberRelationshipDataResolutionResult.connection.createdAt. StaffSpy only calls it for 1st-degree connections.  <https://raw.githubusercontent.com/cullenwatson/StaffSpy/main/staffspy/linkedin/contact_info.py>
 - [medium] GraphQL section-component queries (what the legacy Ember profile/details pages call): /voyager/api/graphql?queryId=voyagerIdentityDashProfileComponents.277ba7d7b9afffb04683953cede751fb&queryName=ProfileComponentsBySectionType&variables=(tabIndex:0,sectionType:{experience|education|skills|certifications},profileUrn:urn%3Ali%3Afsd_profile%3A<id>,count:50); languages uses queryId voyagerIdentityDashProfileComponents.9117695ef207012719e3e0681c667e14; about/top cards: voyagerIdentityDashProfileCards.9ad2590cb61a073ad514922fa752f566&queryName=ProfileTabInitialCards&variables=(count:50,profileUrn:…). Response path: data.identityDashProfileComponentsBySectionType.elements[0].components.pagedListComponent.components.elements[].components.entityComponent{titleV2.text.text (title), subtitle.text ('Company · Full-time'), caption.text (date range · duration), metadata.text (location or 'Credential ID …'), subComponents.components[…]}, grouped roles nest another pagedListComponent; skills come via components.tabComponent.sections[].subComponent…; certification link at subComponents.components[0].components.actionComponent.action.navigationAction.actionTarget. Requires header x-li-graphql-pegasus-client: true on some queries.  <https://raw.githubusercontent.com/cullenwatson/StaffSpy/main/staffspy/linkedin/experiences.py>
 - [low] Those StaffSpy queryId hashes were last changed in commits dated 2024-07/08 and the repo (last push 2025-06-17) still shipped them, i.e. these hashes stayed valid for ~1 year despite claims that queryIds rotate every frontend deploy; whether the SDUI profile page still issues them in Sept 2026 is unverified.  <https://github.com/cullenwatson/StaffSpy>
 - [medium] Another live queryId seen 2025-07-02: voyagerIdentityDashProfiles.8ca6ef03f32147a4d49324ed99a3d978 (Go client, response key identityDashProfilesByMemberIdentity, entity types …profile.Profile/Position/Education/EndorsedSkill).  <https://pkg.go.dev/github.com/masa-finance/linkedin-scraper>
 - [medium] Posts for a profile: /voyager/api/graphql?includeWebMetadata=true&variables=(count:20,start:0,profileUrn:urn%3Ali%3Afsd_profile%3A<id>)&queryId=voyagerFeedDashProfileUpdates.20c70fe0314184158516a7ec004c0408; activity timestamp = activityId >> 22 (Unix ms).  <https://github.com/SharmaNityam/linkedin-profile-api>
 - [medium] SDUI/RSC transport details: GET https://www.linkedin.com/flagship-web/in/{slug}/ (main stream) and POST /flagship-web/rsc-action/actions/component?componentId=<c>&sduiid=<c> with components com.linkedin.sdui.generated.profile.dsl.impl.profileCardsBelowActivityPart1WithoutExp … Part7 and …profileCardsExperienceOnly; header `x-li-rsc-stream: true` selects the RSC wire format instead of HTML; `x-li-application-version`/x-li-track.clientVersion must be the SDUI app version (0.2.x, e.g. 0.2.7003), not the Voyager 1.13.x version; a navigation without x-li-anchor-page-key/x-li-initial-url/x-li-layout-tree returns 200 with zero bytes; RSC lines are `<id_hex>:<type_char>,<json>` (types I=import, T=text blob, `[`=component tree like ["$","div",null,{children:[…]}]), body may be base64; 'BelowActivityPartN' bucket names are meaningless and unstable so the parser pattern-matches pooled text. Repo last pushed 2026-08-31.  <https://raw.githubusercontent.com/reyyanxahmed/linkedin-profile-api/main/app/linkedin/strategies/flagship_web.py>
 - [medium] The /flagship-web/rsc-action/actions/pagination endpoint returns 500 on replay even with a fresh cursor; scrolling the real page is the only way to get more results.  <https://github.com/PradeepdubeyAI/linkedin-job-outreach-kit>
 - [high] a third-party LinkedIn MCP server (3,623 stars, pushed 2026-09-25) uses Patchright, reads the rendered page (innerText, URL navigation, and JSON/document bodies the page already fetched) and by explicit decision (2026-09-16) never issues /voyager/api/ requests: 'Issuing LinkedIn private API requests is reverse engineering. This repo stays online because we do not do that.'  (source omitted)
 - [high] that third-party project PERSON_SECTIONS map (one navigation per section): main_profile '/', experience '/details/experience/', education '/details/education/', interests '/details/interests/', honors '/details/honors/', languages '/details/languages/', certifications '/details/certifications/', skills '/details/skills/', projects '/details/projects/', contact_info '/overlay/contact-info/' (overlay), posts '/recent-activity/all/'. It waits for `main`, requires main.innerText.length > 100–200, scrolls body (default 10 scrolls, 1 s pause; 5 scrolls/0.5 s on details pages), and for the overlay waits for `dialog[open], .artdeco-modal__content`. NAV_DELAY = 2.0 s between navigations; RATE_LIMIT_RETRY_DELAY = 5.0 s.  (source omitted)
 - [high] that third-party project auth-blocker URL patterns: '/login', '/authwall', '/checkpoint', '/challenge', '/uas/login', '/uas/consumer-email-challenge'; logged-in detection via nav selectors `nav a[href*="/feed"], nav button:has-text("Home"), nav a[href*="/mynetwork"]` and presence of the li_at cookie for https://www.linkedin.com/feed/.  (source omitted)
 - [high] /details/skills/ is an SDUI list that appends more skills only when a viewport-centre mouse-wheel event fires (same mechanism as the home feed); without wheel-scrolling only the top ~10 skills are returned. Proposed fix: wheel-scroll until innerText length stabilises. Issue opened 2026-07-22.  (source omitted)
 - [medium] The /overlay/contact-info/ reader in that third-party project waits for dialog[open] → .artdeco-modal__content → main → body; when the overlay is late or missing it silently returns the profile's main text as contact_info (issue opened 2026-09-25).  (source omitted)
 - [high] that third-party project captures already-fetched payloads with page.on('response'), filtering LinkedIn hosts and media types text/html, application/json, application/vnd.linkedin.normalized+json(+2.1); the initial /feed/ HTML embeds RSC flight data with /-escaped slashes; the feed SDUI pager marker is 'sduiid=com.linkedin.sdui.pagers.feed.mainFeed'. Listener must be installed before navigation.  (source omitted)
 - [high] joeyism/linkedin_scraper v3.1.2 (Playwright async, 4,543 stars, pushed 2026-04-10, 145 open issues) selectors: name `h1`; location `.text-body-small.inline.t-black--light.break-words`; open-to-work `.pv-top-card-profile-picture img` title contains '#OPEN_TO_WORK'; about via `[data-view-name="profile-card"]` whose innerText starts with 'About' then `span[aria-hidden="true"]`; experience via `h2:has-text("Experience")` ancestor list `ul > li` and fallback to /details/experience with `main ul > li`, `.pvs-list__container .pvs-list__paged-list-item`, `div[data-view-name="profile-component-entity"]`, nested `.pvs-list__container` for grouped roles; text de-dup via `span[aria-hidden="true"]`. Issue #291 (2026-05-07) reports many fields returning None.  <https://raw.githubusercontent.com/joeyism/linkedin_scraper/master/linkedin_scraper/scrapers/person.py>
 - [medium] vinzlac's fork published as PyPI `linkedin-playwright-scraper` 4.4.8 (2026-09-16) is the most recently updated Playwright DOM scraper; it parses /details/experience/ and /details/education/ via JS text walking of `main h2` containers, interests via `[role="tab"]`/`[role="tabpanel"]`, other sections via `.pvs-list__container, main ul, main ol` → `.pvs-list__paged-list-item` or `> li`, certification links `a[href*="credential"], a[href*="verify"]`, contact overlay `dialog, [role="dialog"]` with `h3` section headings.  <https://github.com/vinzlac/linkedin_scraper>
 - [high] Scrapfly's Aug 14 2026 review: joeyism/linkedin_scraper (Playwright, 4,415 stars, last commit Apr 2026, fields returning None), a third-party LinkedIn MCP server (Patchright, 3,115 stars, Aug 2026, several tools including get_person_profile flagged with open issues), StaffSpy (Voyager API, 324 stars, last commit June 2025, two LinkedIn-side breakage issues #75/#76), JobSpy (guest jobs API), scrapfly linkedin-scraper (public JSON-LD only).  <https://scrapfly.io/blog/posts/best-linkedin-scrapers-github>
 - [high] tomquirk/linkedin-api: github.com/tomquirk/linkedin-api returns HTTP 404 (GitHub API 'Not Found') as of 2026-09-25; PyPI latest release is 2.3.1 uploaded 2024-11-07 and its documented get_profile used /voyager/api/identity/profiles/<id>/profileView (now 410). Forks (nsandman, alabarga, PipesNBottles/li_scrapi) exist.  <https://pypi.org/project/linkedin-api/>
 - [high] josephlimtech/linkedin-profile-scraper-api (Puppeteer, 780 stars) was last pushed 2024-04-05, effectively unmaintained against the 2026 DOM.  <https://github.com/josephlimtech/linkedin-profile-scraper-api>
 - [medium] Legacy (Ember) LinkedIn pages embed preloaded API responses as hidden <code id="bpr-guid-N"> blocks; descriptor blocks look like {"request":"/voyager/api/identity/profiles/tom-quirk/profileView","status":200,"body":"bpr-guid-3900675"} and point at another code block holding the JSON body (the 'BPR datalet' mechanism, ids `datalet-bpr-guid-…`). SDUI profile pages no longer contain them.  <https://github.com/nsandman/linkedin-api>
 - [high] Official 'Save a profile as a PDF' help: navigate to the member's profile → click More (or Resources) in the introduction section → Save to PDF; works for your own and other members' profiles; 'Profiles must be in English, and the member's language setting must also be English'; 'You're limited to 200 PDF downloads per month when saving LinkedIn profiles, including both your own profile and other members' profiles'; not available in the mobile app.  <https://www.linkedin.com/help/linkedin/answer/a541960>
 - [low] Third-party guides (UPDF; a Selenium repo) state a cap of 100 PDFs of other members' profiles per month and that Save to PDF is unavailable for Simplified/Traditional Chinese, Japanese, Korean, Russian, Arabic or Thai profiles, this conflicts with the official 200/month figure.  <https://updf.com/create-pdf/how-to-save-linkedin-profile-as-pdf/>
 - [high] Official Commercial Use Limit page: counted = 'Searching for LinkedIn profiles on LinkedIn.com and mobile', 'Browsing LinkedIn profiles using the People Also Viewed section', 'Viewing member profiles on the People tab of LinkedIn Pages'; not counted = 'Searching profiles by name using the search box', 'Browsing your 1st-degree connections from the Connections page', 'Searching for jobs on the Jobs page'; 'Your free monthly usage resets at midnight PST on the 1st of each calendar month'; 'We are not able to display the exact number of searches or views you have left and we also cannot lift the limit upon request.'  <https://www.linkedin.com/help/linkedin/answer/a564226>
 - [medium] Practitioner CUL threshold estimates: ~300 searches/month (lobstr, updated 2026-09-22), 250–350/month (PhantomBuster, 2026-07-29), ~1,000 combined searches+views/month (lilachbullock); Premium/Sales Navigator lift the CUL.  <https://www.lobstr.io/blog/linkedin-limits>
 - [medium] Daily profile-view guidance (2026 practitioner sources; LinkedIn publishes no number): lobstr ~80/day free, 150 Premium, 1,000 Sales Navigator; SocialNexis (May 2026) '80 to 100 per day from a warmed account is fine'; lilachbullock 80–150 free, 30–40 for accounts under 6 months, 60–80 'realistic ceiling' with tools; SalesRobot 500/day free and 2,000 Recruiter/Sales Navigator (upper bound, not a safe rate).  <https://socialnexis.com/guides/linkedin-rate-limits-2026>
 - [medium] Restriction triggers cited across 2026 sources: bursting (e.g. 30 actions in 10 minutes then gaps), datacenter/cloud IPs, full-speed automation on accounts < 30 days old, concurrent sessions from different IPs, viewing profiles faster than a human reads them (< 5–10 s per profile), strictly sequential viewing order, sudden jumps (20 → 300 views/day), login from a new device during a spike; LinkedIn uses behavioral models ('The number wasn't the trigger. The rhythm was.'). Earliest signals: 'unusual activity detected' notice, CAPTCHA/identity verification, forced logouts/cookie expiry, temporary invite/message blocks.  <https://www.lilachbullock.com/linkedin-profile-view-daily-limit/>
 - [high] LinkedIn official policy: 'we don't allow the use of third-party software or browser extensions that scrape, modify the appearance of, or automate activity on LinkedIn's website'; restricted accounts 'automatically be re-enabled at the time specified on the suspension notification' once the software is removed.  <https://www.linkedin.com/help/linkedin/answer/a1340567>
 - [medium] Enforcement context: LinkedIn removed Apollo.io's and Seamless.AI's company pages in March 2025 and its lawsuit against Proxycurl (filed Jan 2025) ended with Proxycurl shutting down in July 2025.  <https://connectsafely.ai/articles/is-linkedin-automation-safe-tos-scraping-guide-2026>
 - [medium] HTTP 999 'Request Denied' is LinkedIn's edge-level block for requests that do not look like a legitimate browser session (non-browser UAs, datacenter IPs); Voyager itself returns 429 with a retry-after header for rate limiting. StaffSpy treats response.reason == 'INKApi Error' as 'delete session file and log in again'; SlothT treats a 302 whose Set-Cookie contains li_at="delete me" as session revocation; kartik6 treats 999 as ChallengeRequired and a JSON request answered with HTML as a login wall.  <https://raw.githubusercontent.com/kartik6/linkedin-profile-api/main/app/linkedin/client.py>
 - [high] Fingerprint measurements (macOS 26.6 arm64, Patchright 1.60.1, Google Chrome 150): real Chrome, headed, no UA override scored CreepJS 0% headless / 44% like-headless, the best configuration; bundled headless Chromium with a spoofed UA scored 33%/88%. Checks: no HeadlessChrome token, navigator.webdriver false, no __pwInitScripts/__playwright__/$cdc_* globals, UA major == sec-ch-ua major, outer window not larger than screen. 'Behaviour. Mouse paths, typing rhythm, scroll cadence, the spacing between navigations … for a platform like LinkedIn it is plausibly weighted higher than anything above.'  (source omitted)
 - [high] joshuatz/linkedin-to-jsonresume (bookmarklet, last push 2025-06-22) fetches Voyager from inside the logged-in page with fetch(); it uses /identity/dash/profilePositionGroups?q=viewee&profileUrn=urn:li:fsd_profile:{id}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfilePositionGroup-50, /identity/dash/profiles?q=memberIdentity…FullProfileWithEntities-93, /identity/dash/profileVolunteerExperiences?q=viewee&profileUrn=…, /identity/profiles/{id}/profileContactInfo, /identity/profiles/{id}/skillCategory, /me; and documents multi-locale fields (multiLocaleFirstName{en_US,…}).  <https://raw.githubusercontent.com/joshuatz/linkedin-to-jsonresume/main/src/main.js>
 - [medium] Iron Mind (2025-06-13, updated 2026-05-22) recommends 1–2 Voyager requests per minute per account, notes sessions stay valid 3–7 days and to refresh on 401/403; it uses FullProfileWithEntities-93 and finds the profile in `included` by entityUrn containing 'fsd_profile:' and a firstName field, current position = $type ends with 'Position' and no dateRange.end.  <https://iron-mind.ai/blog/linkedin-profile-scraper-python-voyager-api>
 - [medium] LinkedIn's Easy Apply SDUI migration (July 2025) rendered the modal inside a same-origin iframe with elements behind shadow roots; robust automation must recurse into element.shadowRoot and same-origin iframes and dispatch full event sequences (focus→input→change→blur; pointerdown→pointerup→mousedown→mouseup→click).  <https://dev.to/maazkhanxo/bypassing-shadow-doms-same-origin-iframes-how-i-solved-linkedins-massive-sdui-update-1lmk>

RECOMMENDATIONS:
 - Store raw first, parse later: persist every captured/fetched body (Voyager JSON, RSC flight text, page innerText, HTML) in SQLite with url, content-type, decorationId/queryId, captured_at, and a parser_version; re-run parsers offline when LinkedIn drifts instead of re-visiting thousands of profiles.
 - Detect the account's rendering mode at session start (cookie `sdui_ver` present, or `document.querySelector('h1')===null` on a profile) and branch: SDUI → do not rely on class selectors at all; legacy → passive capture of /voyager/api/graphql voyagerIdentityDashProfileCards/Components responses is a free bonus.
 - Primary structured extraction: after navigating to /in/<vanity>/ like a human (dwell, scroll), run ONE in-page fetch from that tab (page.evaluate, so cookies/referer/UA are the real browser's) to /voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=<vanity>&decorationId=…FullProfileWithEntities-101 with fallbacks [-101,-96,-93,-128]; only top up sections whose paging.total > returned (positions, skills) with /identity/dash/profile<Section>s?q=viewee&profileUrn=…&count=100. This is 1–3 requests per applicant instead of 8–10 page views, and the entity graph gives dates/descriptions the innerText never will. Be explicit with the user that this calls LinkedIn's private API (that third-party project refuses to for policy reasons), make it a config flag with the DOM/innerText path as the default-safe alternative.
 - Implement the `included` graph generically (Map by entityUrn; ref(entity,'field') follows `*field`; collection(entity,'field') → `*elements`) and normalize by $type suffix rather than exact strings so a decorationId bump does not break parsing; expect omitted (not null) fields and localized variants (multiLocaleFirstName).
 - Fallback for SDUI accounts without Voyager: read `main` innerText per section page (/details/experience/, /details/education/, /details/skills/, /details/certifications/, /details/languages/, /details/projects/, /details/honors/, /overlay/contact-info/) using structural, locale-independent cues (aria-label, href patterns like /company/, /school/, 'credential'/'verify' links, ` · ` separators) and store the text; wheel-scroll the skills panel until innerText stabilises. Each details page is another 'profile view' event, only visit the ones you need.
 - Passive network capture: register page.on('response') BEFORE goto; match host linkedin.com and content-type in {application/vnd.linkedin.normalized+json*, application/json, text/x-component, text/html}; index by URL substrings '/voyager/api/identity/dash/', '/voyager/api/graphql', 'identityDashProfileComponentsBySectionType', 'identityDashProfileCardsByInitialCards', '/flagship-web/rsc-action/', '/flagship-web/in/'; read bodies asynchronously with a bounded drain so a stuck body() never blocks navigation.
 - Save to PDF: implement as a UI action (More/Resources → 'Save to PDF' → await page.waitForEvent('download')), only for profiles in English, budget ≤200/month per account with a persistent counter, and treat it as optional, the applicant's uploaded resume in the hiring dashboard is the primary PDF source.
 - Pacing model for a normal (non-Recruiter) account: cap 60–80 profile 'views' per day initially (start at 20–30 for the first week and ramp), 25–90 s randomized dwell per profile with occasional longer pauses, sessions of 30–60 min separated by 15–45 min breaks, only during the user's local working hours, non-sequential order (shuffle within a job), and never more than ~1 Voyager request every 30–60 s. For thousands of applicants plan on weeks, not hours, and let the queue resume across days.
 - Fail-closed checkpoint handling: after every navigation check page.url() against /checkpoint/, /challenge/, /authwall, /uas/login, /uas/consumer-email-challenge, /login; check Voyager status 401/403/410/429/999 and 'text/html' answers to JSON requests; on any of these pause the whole queue, notify the user to resolve the checkpoint in their own Chrome, and back off exponentially (hours, not seconds).
 - Do not spoof: use the user's real headed Google Chrome profile (measured as the cleanest fingerprint), never inject UA overrides, avoid Playwright init scripts that leave globals, and never run headless; add human-like scrolling (wheel events), mouse movement to the elements you click, and vary viewport focus.
 - Contact info: LinkedIn shows email/phone only for 1st-degree connections; for applicants rely on the application record (email/phone submitted with the application) and store the /overlay/contact-info/ result only for websites/social handles.
 - Version-pin your parsers with fixtures: record one HAR/JSON fixture per response type (dash profile, section route, GraphQL component, RSC component) and run parser tests against them; add a schema-drift alarm (no root Profile entity, zero positions on a profile whose innerText mentions 'Experience') that halts the batch instead of writing empty rows.

OPEN QUESTIONS:
 - What exact HTTP request does the 'Save to PDF' button issue (endpoint, response type, whether it counts as a profile view)? Not documented anywhere public; needs a one-off HAR capture in the user's Chrome.
 - Is the user's account already on the SDUI profile rendering (check for the `sdui_ver` cookie / missing h1)? This decides whether passive Voyager GraphQL capture will ever fire for profile pages.
 - Do the hashed GraphQL queryIds (voyagerIdentityDashProfileComponents.277ba7d7…, voyagerIdentityDashProfileCards.9ad2590c…, voyagerIdentityDashProfiles.13618f88…) still resolve in Sept 2026, and does any page the user visits still emit them? StaffSpy evidence ends mid-2025.
 - Which FullProfileWithEntities-NN version does LinkedIn's own client send today from the user's account (only -93/-96/-101 are confirmed from Aug 2026; -128 is a guess used as fallback)? Capture from a HAR of any page that still calls Voyager (e.g., messaging or search).
 - Does viewing applicants from the hiring dashboard (rather than from search) count toward the Commercial Use Limit? LinkedIn lists search, People Also Viewed, and Page People-tab views as counted; the applicant list is not mentioned.
 - Does the hiring-dashboard applicant view expose the applicant's fsd_profile URN or vanity directly (would allow skipping the /in/<vanity>/ resolution step and the extra page view)?
 - Does issuing Voyager fetches from an SDUI-rendered account (whose profile pages never call Voyager) raise the account's risk score? No public evidence either way.
 - Is the 200/month Save-to-PDF cap (official) or 100/month (third-party) the enforced number for other members' profiles, and does the cap apply per account or per profile viewed?
 - How much does a company-page admin / job-poster role change the profile-view tolerance versus a plain free account? All published numbers are for free/Premium/Sales Navigator/Recruiter, none for hiring-dashboard users.

SNIPPETS:
--- Voyager normalized-JSON entity graph (port of SharmaNityam graph.ts): follow `*field` URN pointers and `*elements` collections from the `included` array (typescript) ---
export interface VoyagerEntity { entityUrn?: string; $type?: string; [k: string]: unknown }
export interface VoyagerResponse { data?: VoyagerEntity; included?: VoyagerEntity[] }

export class EntityGraph {
  private byUrn = new Map<string, VoyagerEntity>();
  readonly root: VoyagerEntity | undefined;
  constructor(...responses: VoyagerResponse[]) {
    for (const res of responses) for (const e of res.included ?? []) {
      if (!e.entityUrn) continue;
      const prev = this.byUrn.get(e.entityUrn);
      this.byUrn.set(e.entityUrn, prev ? { ...e, ...prev } : e);
    }
    this.root = responses[0]?.data;
  }
  get(urn?: unknown) { return typeof urn === 'string' ? this.byUrn.get(urn) : undefined; }
  ref(e: VoyagerEntity | undefined, field: string) { return this.get(e?.[`*${field}`]); }
  refs(e: VoyagerEntity | undefined, field: string): VoyagerEntity[] {
    const urns = e?.[`*${field}`];
    return Array.isArray(urns) ? urns.map(u => this.get(u)).filter((x): x is VoyagerEntity => !!x) : [];
  }
  /** `*field` -> CollectionResponse -> `*elements` (also returns paging.total for truncation checks) */
  collection(e: VoyagerEntity | undefined, field: string) {
    const coll = this.ref(e, field) as (VoyagerEntity & { paging?: { total?: number } }) | undefined;
    return { elements: this.refs(coll, 'elements'), total: coll?.paging?.total };
  }
  rootElements() { return this.refs(this.root, 'elements'); }
  ofTypeSuffix(suffix: string) { return [...this.byUrn.values()].filter(e => (e.$type ?? '').endsWith(suffix)); }
}

const date = (d: any) => (d && typeof d.year === 'number') ? { year: d.year, month: d.month ?? null } : null;
const img = (pic: any) => { const v = pic?.displayImageReference?.vectorImage; if (!v?.rootUrl || !Array.isArray(v.artifacts)) return null;
  const a = [...v.artifacts].filter(x => x.fileIdentifyingUrlPathSegment).sort((x, y) => (y.width ?? 0) - (x.width ?? 0))[0];
  return a ? v.rootUrl + a.fileIdentifyingUrlPathSegment : null; };

export function normalizeProfile(full: VoyagerResponse, extra: VoyagerResponse[] = []) {
  const g = new EntityGraph(full, ...extra);
  const p = g.rootElements().find(e => (e.$type ?? '').endsWith('.identity.profile.Profile')) ?? g.ofTypeSuffix('.identity.profile.Profile')[0];
  if (!p) throw new Error('schema drift: no Profile entity in included[]');
  const geo = g.ref(p.geoLocation as VoyagerEntity, 'geo');
  const positions = g.collection(p, 'profilePositionGroups').elements.flatMap(grp => {
    const grpCo = g.ref(grp, 'company');
    return g.collection(grp, 'profilePositionInPositionGroup').elements.map(pos => ({
      title: pos.title, companyName: pos.companyName ?? grp.companyName,
      companyUrl: (g.ref(pos, 'company') ?? grpCo)?.url, employmentType: g.ref(pos, 'employmentType')?.name,
      location: pos.locationName ?? pos.geoLocationName, description: pos.description,
      start: date((pos.dateRange as any)?.start), end: date((pos.dateRange as any)?.end),
    }));
  });
  return {
    urn: p.entityUrn, publicIdentifier: p.publicIdentifier, firstName: p.firstName, lastName: p.lastName,
    headline: p.headline, about: p.summary, location: geo?.defaultLocalizedName ?? p.locationName,
    countryCode: (p.location as any)?.countryCode, industry: g.ref(p, 'industry')?.name,
    premium: p.premium ?? p.showPremiumSubscriberBadge, photoUrl: img(p.profilePicture), backgroundUrl: img(p.backgroundPicture),
    positions, positionsTotal: g.collection(p, 'profilePositionGroups').total,
    education: g.collection(p, 'profileEducations').elements.map(e => ({ school: e.schoolName ?? g.ref(e, 'school')?.name, degree: e.degreeName, field: e.fieldOfStudy, grade: e.grade, activities: e.activities, description: e.description, start: date((e.dateRange as any)?.start), end: date((e.dateRange as any)?.end) })),
    skills: g.collection(p, 'profileSkills').elements.map(s => s.name), skillsTotal: g.collection(p, 'profileSkills').total,
    certifications: g.collection(p, 'profileCertifications').elements.map(c => ({ name: c.name, authority: c.authority ?? g.ref(c, 'company')?.name, licenseNumber: c.licenseNumber, url: c.url, issued: date((c.dateRange as any)?.start), expires: date((c.dateRange as any)?.end) })),
    languages: g.collection(p, 'profileLanguages').elements.map(l => ({ name: l.name, proficiency: l.proficiency })),
    projects: g.collection(p, 'profileProjects').elements.map(x => ({ title: x.title, description: x.description, url: x.url, start: date((x.dateRange as any)?.start), end: date((x.dateRange as any)?.end) })),
    publications: g.collection(p, 'profilePublications').elements.map(x => ({ title: x.name, publisher: x.publisher, url: x.url, description: x.description, publishedOn: date(x.publishedOn) })),
    honors: g.collection(p, 'profileHonors').elements.map(x => ({ title: x.title, issuer: x.issuer, description: x.description, issuedOn: date(x.issuedOn) })),
    volunteering: g.collection(p, 'profileVolunteerExperiences').elements.map(x => ({ role: x.role, organization: x.companyName ?? g.ref(x, 'company')?.name, cause: x.cause, description: x.description, start: date((x.dateRange as any)?.start), end: date((x.dateRange as any)?.end) })),
    courses: g.collection(p, 'profileCourses').elements.map(x => ({ name: x.name, number: x.number })),
  };
}
--- In-browser Voyager fetch from the profile tab (real cookies/UA/referer), with decorationId fallbacks and per-section top-up for truncated collections (typescript) ---
import type { Page } from 'playwright';

const DECORATIONS = [101, 96, 93, 128].map(n => `com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-${n}`);
const SECTION_ROUTES = ['profilePositions','profileEducations','profileSkills','profileCertifications','profileLanguages','profileProjects','profileVolunteerExperiences','profileHonors','profilePublications','profileCourses','profilePatents','profileOrganizations','profileTestScores'];

async function csrfToken(page: Page) {
  const c = (await page.context().cookies('https://www.linkedin.com')).find(c => c.name === 'JSESSIONID');
  if (!c) throw new Error('not logged in: no JSESSIONID');
  return c.value.replace(/^"|"$/g, ''); // e.g. ajax:<digits>
}

/** Runs fetch() inside the page so the browser adds cookies, UA, sec-ch-ua, referer. */
async function voyagerGet(page: Page, path: string) {
  const csrf = await csrfToken(page);
  return page.evaluate(async ({ path, csrf }) => {
    const r = await fetch('https://www.linkedin.com/voyager/api' + path, {
      credentials: 'include',
      headers: { 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0',
                 accept: 'application/vnd.linkedin.normalized+json+2.1', 'x-li-lang': 'en_US' },
    });
    const ct = r.headers.get('content-type') ?? '';
    const text = await r.text();
    return { status: r.status, ct, text };
  }, { path, csrf });
}

export async function fetchFullProfile(page: Page, vanity: string) {
  let full: any = null, usedDecoration = '';
  for (const deco of DECORATIONS) {
    const res = await voyagerGet(page, `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(vanity)}&decorationId=${deco}`);
    if (res.status === 429 || res.status === 999) throw new Error(`rate-limited ${res.status}`);
    if (res.status === 401 || res.status === 403 || (res.status === 200 && res.ct.includes('text/html'))) throw new Error('session/checkpoint problem');
    if (res.status === 200 && res.ct.includes('json')) { full = JSON.parse(res.text); usedDecoration = deco; break; }
    // 400/404/410 => decoration retired, try next
  }
  if (!full) throw new Error('no working FullProfileWithEntities decoration');
  const profile = (full.included ?? []).find((e: any) => typeof e.entityUrn === 'string' && e.entityUrn.startsWith('urn:li:fsd_profile:') && e.firstName);
  const urn = profile?.entityUrn as string;
  const extra: any[] = [];
  // Top up only what the decoration truncated (compare paging.total vs returned)
  for (const route of SECTION_ROUTES) {
    const coll = full.included.find((e: any) => e.entityUrn === profile?.[`*${route}`]);
    const total = coll?.paging?.total ?? 0, got = (coll?.['*elements'] ?? []).length;
    if (total > got) {
      await page.waitForTimeout(3000 + Math.random() * 7000); // human-ish spacing between API calls
      const r = await voyagerGet(page, `/identity/dash/${route}?q=viewee&profileUrn=${encodeURIComponent(urn)}&start=0&count=100`);
      if (r.status === 200 && r.ct.includes('json')) extra.push(JSON.parse(r.text));
    }
  }
  return { full, extra, usedDecoration, urn };
}
--- Passive capture of LinkedIn payloads the page fetches itself (Voyager JSON on legacy pages, RSC flight on SDUI pages), install before goto, drain bounded (typescript) ---
import type { Page, Response } from 'playwright';

const INTERESTING = [
  '/voyager/api/identity/dash/', '/voyager/api/graphql', 'identityDashProfileComponentsBySectionType',
  'identityDashProfileCardsByInitialCards', 'identityDashProfilesByMemberIdentity',
  '/flagship-web/rsc-action/', '/flagship-web/in/', '/voyager/api/identity/profiles/',
];
const TYPES = ['application/vnd.linkedin.normalized+json', 'application/json', 'text/x-component', 'text/html'];

export function installCapture(page: Page, onBody: (rec: { url: string; status: number; ct: string; body: string; kind: 'voyager-rest'|'voyager-graphql'|'rsc'|'document'|'other' }) => void) {
  const pending = new Set<Promise<void>>();
  const handler = (res: Response) => {
    const url = res.url();
    if (!/https:\/\/(www\.)?linkedin\.com\//.test(url)) return;
    const ct = (res.headers()['content-type'] ?? '').toLowerCase();
    if (!TYPES.some(t => ct.startsWith(t)) || !INTERESTING.some(s => url.includes(s))) return;
    const kind = url.includes('/voyager/api/graphql') ? 'voyager-graphql'
      : url.includes('/voyager/api/') ? 'voyager-rest'
      : url.includes('/flagship-web/rsc-action/') || ct.startsWith('text/x-component') ? 'rsc'
      : ct.startsWith('text/html') ? 'document' : 'other';
    const p = res.body().then(b => onBody({ url, status: res.status(), ct, body: b.toString('utf8'), kind })).catch(() => {}).finally(() => pending.delete(p));
    pending.add(p);
  };
  page.on('response', handler);
  return {
    async drain(ms = 2000) { await Promise.race([Promise.allSettled([...pending]), new Promise(r => setTimeout(r, ms))]); },
    remove() { page.off('response', handler); },
  };
}
// Legacy-page GraphQL bodies are NOT `included`-style; parse them with parseComponentSection() below.
// Voyager REST bodies (`/identity/dash/…`) are {data, included} -> EntityGraph.
--- Parse the legacy profile page's GraphQL section-component response (queryName=ProfileComponentsBySectionType), shape from StaffSpy experiences/certifications/skills parsers (typescript) ---
// Response: data.identityDashProfileComponentsBySectionType.elements[0].components.pagedListComponent.components.elements[]
// Each element: components.entityComponent { titleV2.text.text, subtitle.text, caption.text, metadata.text, subComponents.components[] }
export function parseComponentSection(json: any) {
  const root = json?.data?.identityDashProfileComponentsBySectionType?.elements?.[0]?.components;
  const out: any[] = [];
  const walkList = (list: any, groupTitle?: string) => {
    for (const el of list?.elements ?? []) {
      const ent = el?.components?.entityComponent; if (!ent) continue;
      const title = ent.titleV2?.text?.text ?? null;
      const subtitle = ent.subtitle?.text ?? null;   // 'Company · Full-time' | issuer | school
      const caption = ent.caption?.text ?? null;     // 'Jan 2020 - Present · 6 yrs' | 'Issued Mar 2024'
      const metadata = ent.metadata?.text ?? null;   // location | 'Credential ID …'
      const nested = ent.subComponents?.components?.[0]?.components?.pagedListComponent?.components;
      if (nested) { walkList(nested, title); continue; } // grouped roles at one company
      const link = ent.subComponents?.components?.map((c: any) => c?.components?.actionComponent?.action?.navigationAction?.actionTarget).find(Boolean) ?? null;
      const insight = ent.subComponents?.components?.map((c: any) => c?.components?.insightComponent?.text?.text?.text).find(Boolean) ?? null; // '12 endorsements'
      const [company, empType] = groupTitle ? [groupTitle, subtitle] : (subtitle ?? '').split(' · ');
      out.push({ title, company: company || null, employmentType: empType ?? null, dates: caption, location: metadata, link, insight });
    }
  };
  if (root?.pagedListComponent) walkList(root.pagedListComponent.components);
  for (const sec of root?.tabComponent?.sections ?? []) walkList(sec?.subComponent?.components?.pagedListComponent?.components); // skills tabs
  return out;
}
--- RSC flight payload text extraction for SDUI accounts (port of reyyanxahmed rsc_parser): lines `<hexid>:<type>,<json>`; component trees are ["$",tag,key,{children:[…]}] (typescript) ---
export function parseRscLines(body: string): unknown[] {
  let text = body;
  if (/^[A-Za-z0-9+/=\s]+$/.test(body.slice(0, 200))) { try { text = Buffer.from(body, 'base64').toString('utf8'); } catch {} }
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    const i = line.indexOf(':'); if (i < 0) continue;
    let rest = line.slice(i + 1); if (!rest) continue;
    let type = ' ';
    if (rest.length >= 2 && rest[1] === ',') { type = rest[0]; rest = rest.slice(2); }
    if (!['[', '0', ' '].includes(type)) continue; // skip I (imports) and T (text blobs)
    try { out.push(JSON.parse(rest)); } catch {}
  }
  return out;
}
const SKIP = new Set(['className','style','viewTrackingSpecs','trackingScope','componentKey','componentId','sduiid','key','$case','$type','action','actions','modelStates','cssVarName']);
const NOISE = /^(_{1,2}|--|\$|com\.|proto\.|urn:li:|var\(|#[0-9A-Fa-f]{6}|[a-f0-9-]{20,}$|[0-9]+$|[a-z][a-zA-Z0-9]*$)/;
export function rscTexts(node: unknown, acc: string[] = []): string[] {
  if (typeof node === 'string') { if (node.length > 1 && !NOISE.test(node)) acc.push(node); }
  else if (Array.isArray(node)) node.forEach(n => rscTexts(n, acc));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) if (!SKIP.has(k)) rscTexts(v, acc);
  return acc;
}
// Usage: rscTexts(parseRscLines(capturedBody)) -> ordered strings: name, headline, 'Experience', role, 'Company · Full-time', 'Jan 2020 - Present · 6 yrs', …
// Bucket names (profileCardsBelowActivityPartN) are unstable; pattern-match the text list, and store raw for re-parsing.
--- Save to PDF via the real UI + Playwright download event (official cap 200/month; English profiles only) (typescript) ---
import type { Page } from 'playwright';
import { rename } from 'node:fs/promises';

export async function saveProfileToPdf(page: Page, vanity: string, outPath: string) {
  await page.goto(`https://www.linkedin.com/in/${vanity}/`, { waitUntil: 'domcontentloaded' });
  if (/\/(checkpoint|challenge|authwall|uas\/login|login)/.test(page.url())) throw new Error('checkpoint: ' + page.url());
  await page.waitForSelector('main', { timeout: 15000 });
  await page.mouse.wheel(0, 300 + Math.random() * 400); await page.waitForTimeout(1500 + Math.random() * 2500);
  // Top-card overflow menu: labelled 'More' (or 'Resources' on some layouts). Locale: English UI required for the feature anyway.
  const more = page.locator('main').getByRole('button', { name: /^(More|More actions|Resources)/i }).first();
  await more.hover(); await page.waitForTimeout(400 + Math.random() * 600); await more.click();
  const item = page.getByRole('menuitem', { name: /Save to PDF/i }).or(page.getByText(/^Save to PDF$/i)).first();
  await item.waitFor({ timeout: 8000 });
  const [download] = await Promise.all([ page.waitForEvent('download', { timeout: 60000 }), item.click() ]);
  const tmp = await download.path(); if (!tmp) throw new Error('download failed: ' + (await download.failure()));
  await rename(tmp, outPath);
  return { suggested: download.suggestedFilename(), outPath };
}
// Keep a per-account monthly counter in SQLite (limit 200/month, resets on the 1st); skip non-English profiles.
--- Fail-closed health checks and human pacing helpers for the queue worker (typescript) ---
import type { Page } from 'playwright';

export const BLOCKER_URL = /https:\/\/(www\.)?linkedin\.com\/(checkpoint\/|challenge\/|authwall|uas\/login|uas\/consumer-email-challenge|login)/i;

export function classifyVoyagerStatus(status: number, contentType: string, setCookie = '') {
  if (status === 999) return 'edge-bot-block';              // LinkedIn 999 Request Denied
  if (status === 429) return 'rate-limited';                 // honour retry-after; stop for hours
  if (status === 401 || status === 403) return 'session-or-permission';
  if (status === 410) return 'endpoint-retired';             // e.g. /profileView
  if ((status === 301 || status === 302) && /li_at="?delete me/i.test(setCookie)) return 'session-revoked';
  if (status === 200 && contentType.includes('text/html')) return 'login-wall';  // HTML where JSON was expected
  return 'ok';
}

export async function assertHealthy(page: Page) {
  if (BLOCKER_URL.test(page.url())) throw new Error('CHECKPOINT ' + page.url()); // pause queue, ask user to resolve in Chrome
  const sdui = (await page.context().cookies('https://www.linkedin.com')).some(c => c.name === 'sdui_ver');
  return { sdui };
}

/** Log-normal-ish dwell: median ~35 s, long tail to a few minutes, never < 12 s. */
export function humanDwellMs(medianSec = 35) {
  const z = (Math.random() + Math.random() + Math.random() - 1.5) * 1.2; // approx normal
  return Math.max(12000, Math.round(medianSec * Math.exp(0.55 * z) * 1000));
}

/** Daily budget: ramp new automation slowly; keep well under practitioner ~80–100/day for a warmed normal account. */
export function dailyViewBudget(daysSinceStart: number) {
  return Math.min(70, 20 + daysSinceStart * 8);
}

/** Realistic scrolling: several wheel ticks with pauses, occasionally scroll back up. */
export async function humanScroll(page: Page, steps = 4 + Math.floor(Math.random() * 4)) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.move(300 + Math.random() * 600, 300 + Math.random() * 300, { steps: 5 });
    await page.mouse.wheel(0, 250 + Math.random() * 500);
    await page.waitForTimeout(500 + Math.random() * 1500);
    if (Math.random() < 0.15) await page.mouse.wheel(0, -(100 + Math.random() * 200));
  }
}
