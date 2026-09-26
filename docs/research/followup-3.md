# Research notes (2026-09-25, auto-collected; verify before relying on any single claim)

## Follow-up: 

### Summary

Answer to the four sub-questions, based on primary sources (Playwright/Chromium source and issues, chromedriver source, LinkedIn Help, and five 2025-2026 open-source LinkedIn hiring-dashboard downloaders). WebSearch budget was exhausted at the start of this task, so everything below comes from directly fetched primary sources (GitHub API/raw, playwright.dev, chromium source mirror, linkedin.com/help).

(a) What the Resume control does. Two LinkedIn hiring UIs are live in 2026. NEW UI (SDUI markup with data-view-name / componentkey attributes; list at linkedin.com/hiring/applicants/?jobId=<id>&rating=..., applicant links contain applicationId=): clicking the applicant loads a detail pane (right panel or [role=dialog]); a "Resume" tab/button (button[data-view-name="hiring-applicant-view-resume"], or an <a>/<button> containing svg#document-small with leaf-span text "Resume") opens a resume PREVIEW MODAL; inside it a "Download" control (button containing svg#download-small, or aria-label*="Download") triggers window.open()/<a target=_blank> to a signed file URL, i.e. a NEW TAB navigation, not a same-tab download (observed independently by a Selenium script from 2026-05 that reads the new tab's URL, and by a MV3 extension from 2026-02 that hooks window.open and target=_blank clicks and, as last resort, watches chrome.tabs.onCreated). The extension also probes iframe/embed/object inside the modal for a src matching .pdf|mediaauth|dms/|media.licdn.com|ambry, the Recruiter-side equivalent (2026-09) states the PDF URL "surfaces three ways: the link's own href, a window.open from a Download control, or an iframe/embed inside the viewer modal". No public source pins the exact host for the hiring dashboard; candidates are linkedin.com/ambry?x-li-ambry-ep=..., linkedin.com/dms/prv/document/..., or media.licdn.com/dms/document/... (the Recruiter regex is /\/ambry\/|\/dms|document\/media|pdf-analyzed|\.pdf/). OLD UI (Ember; linkedin.com/hiring/jobs/<jobId>/applicants/, li.hiring-applicants__list-item, #hiring-detail-root): a direct "Download resume" link (a[aria-label*="Download"][aria-label*="resume"]) or a "More actions" menu item "Download resume"; a Playwright script (2026-01, headful persistent Chromium, no pref hack) captures it with expect_download(), which means that path returns Content-Disposition: attachment.

(b) fetch(url,{credentials:'include'}). Same-origin linkedin.com URLs: cookies are sent automatically and Content-Disposition/Content-Type are readable; the 2026 extension does exactly fetch(url,{credentials:"include"}) -> blob from a content script (an isolated world, same as patchright's evaluate). For media.licdn.com the response is cross-origin, so header/body readability depends on CORS (unverified), use Playwright's context.request.get(url) instead, which uses the same cookie jar and has no CORS restriction. LinkedIn accepts "Microsoft Word or PDF" resumes (<2MB recommended) and stores the ORIGINAL file: a Gmail-based downloader saved .doc/.docx/.pdf from LinkedIn's download_resume links using the Content-Disposition filename. So expect raw PDF, DOC (D0 CF 11 E0), DOCX (PK..) bytes; sniff magic bytes, never assume .pdf (the 2026 extension hardcodes .pdf, a bug). Signed-URL TTL: no public documentation. The 2026 extension's author states re-requesting the URL from chrome.downloads (a "second HTTP request") fails and calls it a "one-time-token problem"; the Selenium author re-fetched with cookies + browser UA + Referer https://www.linkedin.com/ and reports success. Treat the URL as single-use/short-lived: fetch bytes within the same interaction, never persist the URL for later, and reject HTML bodies (authwall) as failures.

(c) Headful Chrome + PDF viewer. Confirmed: headed Chromium renders inline PDFs in the built-in viewer and Playwright emits NO download event (issues #7822, #3509, #20771, #6342; #7822 closed "not planned"). Playwright enables downloads via CDP Browser.setDownloadBehavior{behavior:'allowAndName', eventsEnabled:true} and only reports Browser.downloadWillBegin; for a new-window download it reports on the OPENER page (crBrowser.ts), so page.waitForEvent('download') on the applicant page works for the new-tab case once the response is treated as a download. Pre-writing <userDataDir>/Default/Preferences {"plugins":{"always_open_pdf_externally":true}} before first launch DOES work: (1) it is the real Chrome pref (pref_names.h kPluginsAlwaysOpenPdfExternally), enforced in plugin_utils.cc IsExtensionAllowedInProfile() which refuses the PDF viewer for PDF MIME types so the response becomes a download; the policy definition says it "treats PDF files as a download", dynamic_refresh: true, per_profile: true; (2) chromedriver implements ChromeOptions prefs by writing Default/Preferences (+ Local State + an empty "First Run" sentinel) into the user-data-dir before launch (chrome_launcher.cc PrepareUserDataDir/WritePrefsFile), for temp AND user-supplied dirs; (3) Playwright users confirmed it with launchPersistentContext (waynerobinson 2020-08-18; dgozman 2020-11-24: "the workaround ... solves the issue"; Python variant 2023-02-09); (4) the pref is not in Chromium's kTrackedPrefs (Secure Preferences HMAC) list, so a plain JSON edit is honored. Caveats: write it only while no Chrome is running on that profile (Chrome rewrites Preferences on exit); --initial-preferences-file did NOT work for a Playwright user (#20771) and Playwright passes --no-first-run, so use the Default/Preferences write, not that flag; the pref is independent of patchright (patchright only changes launch flags and Runtime.enable). Even with the pref, a page.goto to a PDF throws net::ERR_ABORTED while the download event fires (#20771), for the hiring flow you click a button, so instead race waitForEvent('download') against context.waitForEvent('page') (popup) and fall back to fetching popup.url() via context.request. Also: you cannot automate the user's real default Chrome profile, Chrome 136+ (blog 2025-03-17) ignores --remote-debugging-pipe/port on the default user data dir and Playwright docs say the same; use a dedicated automation profile (sign in once), which also makes the Preferences pre-write safe.

(d) No-resume / external-ATS applicants. Resume is optional for logged-in Easy Apply applicants (LinkedIn Help a510363), so a profile-only application has NO Resume control at all, no tab/button/"Download resume" menu item; every downloader found treats "control not found after the detail pane rendered" as no_resume (nitdhasmana README: "Some candidates may not have a resume document attached (e.g. Easy Apply with just Profile data)"; Gnanapreetham status "no_resume"; Recruiter extension uses a 2-strike rule because a not-yet-rendered/background tab looks identical to "no resume"). No source shows an explicit "No resume" text node. External ATS: the poster picks one of three collection methods at posting time (email / on LinkedIn / "route candidates to an external website ... your company's applicant tracking system"), it "cannot be changed after posting", and LinkedIn Help states "If you chose to collect applicants through LinkedIn while posting the job, you can review and rate them", external-routed jobs therefore have no applicant records or resumes in the hiring dashboard (only counts/clicks); the MCP should classify such jobs as external_apply with zero exportable applicants. LinkedIn Help also states "For online job postings, bulk downloading or exporting applicant profiles is not available", the product has no export, which is why the DOM/download route is needed (and why ToS risk should be surfaced to the user).

### Facts

- [high] Playwright headed Chromium opens PDFs in the built-in viewer instead of firing the download event; headless (shell) downloads them. Maintainers' suggested workaround is page.route + route.fulfill with headers {...response.headers(), 'Content-Disposition':'attachment'}; issue closed 'not planned' (May 2026). One user (2025-08-07) reported route.fetch produced corrupted PDFs.  <https://github.com/microsoft/playwright/issues/7822>
- [high] Writing {plugins:{always_open_pdf_externally:true}} to <userDataDir>/Default/Preferences before chromium.launchPersistentContext(userDataDir,{acceptDownloads:true}) forces PDFs to download; author confirmed 2020-08-18 and Playwright maintainer dgozman wrote 2020-11-24 'It seems like the workaround ... solves the issue'. Alternative: set the download attribute on the link before clicking.  <https://github.com/microsoft/playwright/issues/3509>
- [high] Python variant (2023-02-09): write Default/Preferences JSON in a temp dir, launch_persistent_context(headless=False, accept_downloads=True); page.goto to a PDF then raises (net::ERR_ABORTED) while expect_download resolves. The same user reported --initial-preferences-file did not work under Playwright's flag set (which includes --no-first-run). Maintainer mxschmitt suggested page.request.get(url) to just fetch the PDF bytes.  <https://github.com/microsoft/playwright/issues/20771>
- [high] Chromium pref name: inline constexpr char kPluginsAlwaysOpenPdfExternally[] = "plugins.always_open_pdf_externally"; comment: 'Whether Chrome should use its internal PDF viewer or not.'  <https://raw.githubusercontent.com/chromium/chromium/main/chrome/common/pref_names.h>
- [high] Enforcement: plugin_utils.cc IsExtensionAllowedInProfile() returns false for any PDF MIME type when prefs::kPluginsAlwaysOpenPdfExternally is true ('The preference promises that PDFs are downloaded rather than opened in Chrome'), which disables the PDF viewer extension for PDF responses so they become downloads.  <https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/plugins/plugin_utils.cc>
- [high] AlwaysOpenPdfExternally policy: 'turns the internal PDF viewer off ..., treats PDF files as a download'; features dynamic_refresh: true, per_profile: true, can_be_recommended: true; supported_on chrome.*:55-.  <https://raw.githubusercontent.com/chromium/chromium/main/components/policy/resources/templates/policy_definitions/Miscellaneous/AlwaysOpenPdfExternally.yaml>
- [medium] plugins.always_open_pdf_externally does not appear in Chromium's kTrackedPrefs array in chrome_pref_service_factory.cc (grep found the array but no match for the pref), so it is not HMAC-protected in 'Secure Preferences' and a plain JSON edit of Default/Preferences is honored.  <https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/prefs/chrome_pref_service_factory.cc>
- [high] chromedriver implements the 'prefs' capability by calling PrepareUserDataDir(user_data_dir, prefs, local_state) for BOTH a temp dir and a user-supplied --user-data-dir; WritePrefsFile merges prefs via SetByDottedPath into Default/Preferences and writes Local State; it also writes an empty 'First Run' file 'otherwise Chrome will wipe the default profile that was written'.  <https://raw.githubusercontent.com/chromium/chromium/main/chrome/test/chromedriver/chrome_launcher.cc>
- [high] Playwright Chromium downloads: CRBrowserContext.initialize sends Browser.setDownloadBehavior {behavior: acceptDownloads==='accept' ? 'allowAndName' : 'deny', downloadPath: options.downloadsPath, eventsEnabled: true}; _onDownloadWillBegin finds the owning page by frameId and 'If it's a new window download, report it on the opener page'; downloadProgress 'completed'/'canceled' finish the download.  <https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/chromium/crBrowser.ts>
- [high] Playwright launchPersistentContext: acceptDownloads 'Defaults to true'; downloadsPath: otherwise a temp dir deleted when the browser closes; channel 'chrome' uses branded Google Chrome; userDataDir note: 'Due to recent Chrome policy changes, automating the default Chrome user profile is not supported ... Create and use a separate directory as your automation profile instead.'  <https://playwright.dev/docs/api/class-browsertype>
- [high] Chrome 136 (blog 2025-03-17): --remote-debugging-port and --remote-debugging-pipe 'will no longer be respected if attempting to debug the default Chrome data directory'; they 'must now be accompanied by the --user-data-dir switch to point to a non-standard directory'.  <https://developer.chrome.com/blog/remote-debugging-port>
- [high] download.suggestedFilename() 'is typically computed by the browser from the Content-Disposition response header or the download attribute'; download.url() returns the downloaded URL; saveAs/path/createReadStream wait for completion; all downloaded files are deleted when the browser context closes.  <https://playwright.dev/docs/api/class-download>
- [high] 'The APIRequestContext returned by browserContext.request and page.request uses the same cookie jar as its BrowserContext', context.request.get(url) fetches with the browser's LinkedIn cookies from Node, with no CORS restriction; options include headers, timeout (30000 default), maxRedirects.  <https://playwright.dev/docs/api/class-apirequestcontext>
- [high] Playwright 1.49 (Nov 2024): channel 'chromium' = new headless where 'PDF documents are now rendered in the page, instead of being downloaded'; default chromium-headless-shell keeps the old (download) behavior.  <https://github.com/microsoft/playwright/issues/33566>
- [high] Patchright: recommends launchPersistentContext(dir,{channel:'chrome', headless:false, viewport:null}); removes --enable-automation, --disable-popup-blocking, --disable-component-update, --disable-default-apps, --disable-extensions; adds --disable-blink-features=AutomationControlled; avoids Runtime.enable by 'executing Javascript in (isolated) ExecutionContexts'; init scripts are injected via Playwright Routes into HTML responses; console API is disabled entirely. Nothing in it touches Chrome prefs or download behavior.  <https://raw.githubusercontent.com/Kaliiiiiiiiii-Vinyzu/patchright/main/README.md>
- [high] 2026-02 MV3 extension for linkedin.com/hiring/... (new UI): per applicant it clicks the card, finds the Resume control via button[data-view-name="hiring-applicant-view-resume"] or svg#document-small or a leaf <span>Resume</span>, waits for a preview popup, finds Download via svg#download-small / leaf span 'Download' / button[aria-label*='Download' i], probes iframe/embed/object src and modal anchors for .pdf|mediaauth|dms/|resume, hooks window.open and <a target=_blank> in the main world to capture the URL, fetches it with fetch(url,{credentials:'include'}) -> blob, and as last resort watches chrome.tabs.onCreated for a new PDF tab; closes the popup via button[aria-label='Dismiss'|'Close']. URL classifier includes .pdf, mediaauth, ambry, dms/, media.licdn.com, resumeViewer. Comment: 'This avoids the one-time-token problem where chrome.downloads makes a second HTTP request that fails.' Hardcodes .pdf filenames.  <https://github.com/hammadqadir-dotcom/linkedin_bulk_resume_downloader_extension>
- [high] 2026-05 Selenium script (real Chrome profile via --user-data-dir/--profile-directory, prefs plugins.always_open_pdf_externally:true, download.prompt_for_download:false): list URL https://www.linkedin.com/hiring/applicants/?rating=HIRER_SHORTLISTED&jobId=..., applicant links matched by href containing applicationId=, 25 per page via &start=; per applicant: click Download (//button[.//*[@id='download-small']]) else click Resume tab (//a[.//*[@id='document-small']] or span text 'Resume') then Download; captures the NEW TAB's URL (driver.window_handles), closes it, and re-downloads with requests using browser cookies, browser User-Agent and Referer https://www.linkedin.com/.  <https://raw.githubusercontent.com/NishthaSharma-22/linkedin-recruiter-bulk-resume-downloader/main/linkedin_resume_downloader.py>
- [high] 2026-01 Playwright(Python) script (old Ember UI, launch_persistent_context headless=False, accept_downloads=True, no pref hack): waits for .hiring-applicants__list-item, clicks candidate, locates a[aria-label*='Download'][aria-label*='resume'], button[...] or 'More actions' -> div[role='menu'] 'Download resume', wraps click in page.expect_download(timeout=10000) and saves with download.suggested_filename; README: 'Some candidates may not have a resume document attached (e.g. Easy Apply with just Profile data)' -> button absent, skip.  <https://github.com/nitdhasmana/LinkedinResumeDownloader>
- [medium] 2026-03 Playwright downloader: RESUME_BUTTON_SELECTORS = a[data-test-resume-action='download'], button/a[aria-label*='Download resume'], a[href*='/resume/'], [class*='resume-download'], a[download], button[class*='resume']; uses expect_download; records status 'no_resume' when no selector matches after retry; list URL https://www.linkedin.com/hiring/jobs/{job_id}/applicants/.  <https://raw.githubusercontent.com/Gnanapreetham2808/Linkedin_Resume_Downloader/main/downloader.py>
- [high] 2025-06 extension (old UI): applicant cards li.hiring-applicants__list-item with a[href*='/detail/'] (25/page), name .artdeco-entity-lockup__title or .hiring-people-card__title, profile link .hiring-profile-highlights__see-full-profile a[href*='/in/']; detail pane #hiring-detail-root (sometimes .artdeco-modal__content), h1 name, .hiring-applicant-header__tidbit = 'Applied <date>', sections Experience/Education, h3 'Must-have qualifications'; close via .artdeco-modal__dismiss / button[aria-label='Dismiss'] / Escape.  <https://raw.githubusercontent.com/ist00dent/linkedin-candidate-scraper/main/src/js/content.js>
- [high] 2026-09-22 exporter extension (new UI, class names hashed): applicant rows are detected by 'Applied on:' text; the detail opens either as [role=dialog]/[aria-modal=true] ('dialog' mode) or by navigation ('page' mode, closed with history.back()); contact info revealed via buttons matching /(show|view|see|reveal) (contact|email|phone)/; README warns profile views are visible to applicants and there is a monthly profile-view limit, so run in batches.  <https://github.com/Liwin-liwi/Linkedin-Filter-ChromeExtension>
- [high] 2026-09-23 LinkedIn Recruiter CV extension: 'The resume PDF surfaces three ways: the link's own href, a window.open from a Download control, or an iframe/embed inside the viewer modal'; PDF_RE = /\/ambry\/|\/dms|document\/media|pdf-analyzed|\.pdf/; 'The download button builds a link and clicks it; we catch that link instead of letting the browser save the file' (hooks HTMLAnchorElement.prototype.click and window.open); fetch(pdfUrl) then retry with credentials:'include'; 'an applicant who attached nothing has no control' and a hidden/background tab 'would look exactly like an applicant with none, a false strike', hence a 2-strike no-resume rule.  <https://raw.githubusercontent.com/juanroldanGG/linkedin-recruiter-cv-downloader/master/background.js>
- [high] LinkedIn Help 'Reviewing job applicants': 'If you chose to collect applicants through LinkedIn while posting the job, you can review and rate them.' Tip: 'To view all applicants, go to the Ratings dropdown filter and click the Not a fit checkbox.' Important: 'For online job postings, bulk downloading or exporting applicant profiles is not available.'  <https://www.linkedin.com/help/linkedin/answer/a517574>
- [high] LinkedIn Help 'Applicant options for your job post': collection method chosen on the 'Receive qualified applicants' page: email updates (counts only), on LinkedIn, or 'route candidates to an external website. Enter the URL of the specific application page or of your company's applicant tracking system'; 'Once you've selected an applicant collection method, it cannot be changed after posting your job'; 'Only the job poster has full access to review and manage applicants' (coworkers must be added from the job management page).  <https://www.linkedin.com/help/linkedin/answer/a517570>
- [high] LinkedIn Help 'Upload your resume to LinkedIn' (Easy Apply): 'the file format must be either Microsoft Word or PDF'; 'We recommend a file size less than 2MB'; resume is '(optional)' for logged-in applicants ('If you aren't logged in to LinkedIn, then uploading a resume is mandatory').  <https://www.linkedin.com/help/linkedin/answer/a510363>
- [medium] LinkedIn stores the applicant's original file type: a Gmail-API downloader for LinkedIn application emails follows the 'download_resume' link, parses filename="..." from Content-Disposition, and its README shows saved John_Doe_Resume.pdf, Jane_Smith_Resume.doc, Another_Resume.docx.  <https://github.com/bISTP/LinkedIn-Auto-Resume-Downloader>
- [high] LinkedIn Help 'Apply for jobs on LinkedIn': 'If you see the Apply button instead of the Easy Apply button, you'll be routed to that company's website or job board to continue the application process.'  <https://www.linkedin.com/help/linkedin/answer/a512388>
- [high] a third-party LinkedIn MCP server is built on FastMCP + Patchright, reuses a signed-in local browser session or opens a login window, stores the profile in ~/.linkedin-mcp/profile/, and exposes no hiring-dashboard/applicant/resume tools (only search_jobs, get_job_details, get_saved_jobs on the jobs side).  (source omitted)
- [medium] Puppeteer users solved the same PDF-viewer problem with puppeteer-extra-plugin-user-preferences writing userPrefs {download:{prompt_for_download:false,...}, plugins:{always_open_pdf_externally:true}} into the profile; a commenter noted it works in headless:false but not headless:true (old headless).  <https://github.com/puppeteer/puppeteer/issues/4736>

### Recommendations

- Do NOT point Playwright/patchright at the user's real default Chrome profile: Chrome 136+ refuses remote debugging on the default user data dir and Playwright documents it as unsupported. Create a dedicated automation profile dir (e.g. ~/.linkedin-applicants-mcp/profile), have the user sign in once in that window, and launch with patchright chromium.launchPersistentContext(dir, { channel: 'chrome', headless: false, viewport: null, acceptDownloads: true, downloadsPath }). This also makes editing that profile's Preferences legitimate and safe.
- Before EVERY launch (while no Chrome runs on that profile), read-modify-write <profile>/Default/Preferences to set plugins.always_open_pdf_externally=true and download.prompt_for_download=false, and touch an empty <profile>/First Run file (what chromedriver does). Do not rely on --initial-preferences-file (reported not to work under Playwright's --no-first-run). Do not write to Preferences while the browser is running (Chrome rewrites it on exit).
- Implement resume capture as a layered routine, in this order: (1) if the Download control is an <a href> pointing off /hiring/ or /jobs/, skip the click and fetch the href in-page with fetch(url,{credentials:'include'}) -> arrayBuffer -> base64 -> Node (same-origin linkedin.com exposes Content-Disposition); (2) otherwise, before clicking, install a main-world hook that captures window.open(url) and <a target=_blank> hrefs (patchright's addInitScript is main-world via route injection; page.evaluate is isolated-world and CANNOT override window.open), click, and if a URL is captured fetch it in-page; (3) always race page.waitForEvent('download') (pref-forced attachment; Playwright reports new-window downloads on the opener page) against context.waitForEvent('page') (popup that rendered the PDF inline) with a short 10-15 s timeout; on popup, take popup.url(), fetch with context.request.get(url, { headers: { referer: 'https://www.linkedin.com/' } }), then close the popup; (4) never wait 30 s on a bare download event.
- Treat the signed resume URL as single-use and short-lived: fetch bytes immediately in the same interaction, never store the URL for later retrieval, and if a fetch returns 401/403/HTML, re-open the Resume modal and re-capture rather than retrying the same URL. Log the URL host (linkedin.com/ambry vs linkedin.com/dms/prv/document vs media.licdn.com/dms) on the first live run via context.on('request') so the artifacts.source_host column and the CORS decision (in-page fetch vs context.request) are based on observation.
- Never trust the extension or the button label for MIME/extension. LinkedIn accepts Word or PDF and returns the original file. Sniff magic bytes: %PDF- => application/pdf; PK\x03\x04 => docx; D0 CF 11 E0 A1 B1 1A E1 => application/msword; leading <!DOCTYPE html / <html => authwall or expired token, mark the attempt failed and do not save. Derive original_filename from Content-Disposition (filename*= then filename=) or download.suggestedFilename(); fall back to resume.<ext-from-sniff>. Store sha256 over the bytes, byte size, mime-from-sniff, original filename, capture method (inpage-fetch | download-event | popup-fetch), and captured_at.
- Selector strategy: support both UIs and detect which one is present. New UI: list at /hiring/applicants/?jobId=<id> (rating filter param), applicant links a[href*="applicationId="], Resume control button[data-view-name="hiring-applicant-view-resume"] | :is(a,button):has(svg#document-small) | leaf span text 'Resume'; Download control button:has(svg#download-small) | button[aria-label*="Download" i] | leaf span 'Download'; dismiss button[aria-label="Dismiss"], button[aria-label="Close"]. Old UI: /hiring/jobs/<id>/applicants/, li.hiring-applicants__list-item a[href*="/detail/"], #hiring-detail-root, a[aria-label*="Download"][aria-label*="resume"] or button[aria-label*="More actions"] -> div[role=menu] text 'Download resume', .hiring-applicant-header h1, .hiring-applicant-header__tidbit (applied date). Prefer structural/data-view-name/aria/SVG-id/text matching over hashed class names, and keep selectors in a config table so they can be hot-patched.
- No-resume detection: only mark an application no_resume after the detail pane has definitively rendered (name h1 or header visible, at least one profile section present, tab in the foreground, background tabs stall rendering) AND no Resume control is found after a bounded wait; record no_resume with a re-check counter and re-verify once on a later pass (Recruiter tool uses a 2-strike rule). Resume is optional for logged-in Easy Apply applicants, so a meaningful fraction will legitimately have none; the profile/answers export must not depend on the resume path.
- External-ATS jobs: for each job, detect the collection method (job page shows 'Apply' instead of 'Easy Apply', or the hiring dashboard shows no applicant list) and classify it as external_apply; skip applicant export for those jobs and report it explicitly instead of failing per applicant. The method cannot be changed after posting, so this is a per-job constant worth caching.
- Pacing: keep the resume step to one applicant at a time with randomized 5-15 s gaps (both 2026 tools use this range), open the applicant detail in the same tab (dialog/right panel) rather than new tabs, and close the preview modal before moving on. Full LinkedIn profile visits count against the monthly profile-view limit and are visible to applicants, so schedule profile exports as a separate, slower queue than resume/application exports.
- Surface the ToS reality to the user in the MCP's docs/first-run notice: LinkedIn Help states bulk downloading/exporting applicant profiles is not available for online job postings, and automated access may violate LinkedIn's terms; the tool should be opt-in, run under the user's own account, and keep volumes low.

### Open questions

- Which host serves the hiring-dashboard resume in the current (Sept 2026) UI: linkedin.com/ambry?x-li-ambry-ep=..., linkedin.com/dms/prv/document/..., or media.licdn.com/dms/document/...? No public source records the exact URL; it determines whether in-page fetch can read Content-Disposition (same-origin) or context.request must be used (cross-origin). Log context.on('request') on the first live run.
- Is the signed resume URL single-use, or just short-lived / Referer-gated? One 2026 author says a second request from chrome.downloads fails ('one-time-token problem'); another re-fetched with cookies + UA + Referer via requests and reports success. Test: capture URL, fetch twice 2 s apart, then once after 10 minutes.
- Does the resume preview modal embed an iframe/embed/object whose src is the file URL (making a no-click capture possible), or does it render page images (LinkedIn's feed-document style 'pdf-analyzed' pipeline)? The 2026 extension probes for it but does not confirm it exists on the hiring UI.
- For Word (.doc/.docx) resumes: does the preview show a server-converted PDF, and does the Download control return the original Word bytes or a converted PDF? Verify with one known DOCX applicant and sniff the bytes.
- Under the Preferences hack, when the Download control opens a new tab that becomes a download, does Chrome auto-close that tab and does Playwright emit both a 'page' (popup) and a 'download' event? The capture routine should tolerate both orders and a popup that closes immediately.
- Is media.licdn.com CORS-readable from a linkedin.com page (Access-Control-Allow-Origin) so that in-page fetch can read headers/body, or will it produce an opaque/blocked response? Affects whether the in-page path can be primary for that host.
- Does the new UI show any explicit text (e.g. 'No resume attached') for profile-only applicants, or is the Resume control simply absent? All sources found only handle absence.
- Whether Chrome's 'First Run' sentinel is needed under Playwright's --no-first-run for the pre-written Preferences to survive (chromedriver writes it defensively; the Playwright 2020 report worked without it). Writing the empty file is harmless, so do it.
- Exact patchright-nodejs version to pin (README shows no version; check the GitHub releases page) and whether its route-based init-script injection interferes with a context.route() you add for URL logging (both use Playwright Routes).

### Snippets

#### Pre-write Chrome prefs into the dedicated automation profile before each launch (only while Chrome is not running on that profile), then launch patchright headful Chrome.

```typescript
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chromium } from 'patchright';

export async function ensureChromePrefs(userDataDir: string) {
  const defaultDir = path.join(userDataDir, 'Default');
  await fs.mkdir(defaultDir, { recursive: true });
  const prefsPath = path.join(defaultDir, 'Preferences');
  let prefs: Record<string, any> = {};
  try { prefs = JSON.parse(await fs.readFile(prefsPath, 'utf8')); } catch { /* first launch */ }
  prefs.plugins = { ...(prefs.plugins ?? {}), always_open_pdf_externally: true }; // pref_names.h kPluginsAlwaysOpenPdfExternally
  prefs.download = { ...(prefs.download ?? {}), prompt_for_download: false };
  await fs.writeFile(prefsPath, JSON.stringify(prefs));
  // chromedriver writes this sentinel so Chrome does not treat the profile as brand new
  await fs.writeFile(path.join(userDataDir, 'First Run'), '').catch(() => {});
}

export async function launch(userDataDir: string, downloadsPath: string) {
  await ensureChromePrefs(userDataDir);
  return chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',      // branded Chrome, per patchright README
    headless: false,
    viewport: null,
    acceptDownloads: true,  // default, explicit for clarity
    downloadsPath,          // files here are deleted when the context closes: copy out immediately
  });
}
```

#### Layered resume capture: in-page fetch when an href exists, otherwise click and race the download event (pref-forced attachment, reported on the opener page) against a popup (inline PDF viewer), fetching the popup URL with the shared cookie jar.

```typescript
import type { Page, Locator, BrowserContext, Download } from 'patchright';

export type Captured = { bytes: Buffer; url: string; filename?: string; contentType?: string; how: 'inpage-fetch' | 'download-event' | 'popup-fetch' };

const FILE_URL = /ambry|\/dms\/|media\.licdn\.com|mediaauth|\.pdf(\?|$)/i;

export async function captureResume(page: Page, downloadControl: Locator, timeoutMs = 15_000): Promise<Captured | null> {
  const ctx: BrowserContext = page.context();

  // 1) Anchor with a real file href: no navigation at all
  const href = await downloadControl.evaluate((el) => (el instanceof HTMLAnchorElement ? el.href : null)).catch(() => null);
  if (href && FILE_URL.test(href) && !/\/hiring\/|\/jobs\//.test(href)) {
    const r = await inPageFetch(page, href);
    if (r) return { ...r, url: href, how: 'inpage-fetch' };
  }

  // 2) Click and race download vs popup (never block 30 s on a bare download wait)
  const downloadP = page.waitForEvent('download', { timeout: timeoutMs }).then((d) => ({ kind: 'download' as const, d }), () => null);
  const popupP = ctx.waitForEvent('page', { timeout: timeoutMs }).then((p) => ({ kind: 'popup' as const, p }), () => null);
  await downloadControl.click();
  const first = await Promise.race([downloadP, popupP]);
  if (!first) return null;

  if (first.kind === 'download') return fromDownload(first.d);

  // Popup appeared: either Chrome rendered the PDF inline (pref not honored) or the tab is about to turn into a download.
  const popup = first.p;
  const late = await Promise.race([downloadP, new Promise<null>((r) => setTimeout(() => r(null), 3_000))]);
  if (late && late.kind === 'download') { await popup.close().catch(() => {}); return fromDownload(late.d); }

  await popup.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
  const url = popup.url();
  await popup.close().catch(() => {});
  if (!FILE_URL.test(url)) return null;
  const resp = await ctx.request.get(url, { headers: { referer: 'https://www.linkedin.com/' }, timeout: 30_000 });
  if (!resp.ok()) return null;
  const h = resp.headers();
  return { bytes: await resp.body(), url, filename: parseFilename(h['content-disposition']), contentType: h['content-type'], how: 'popup-fetch' };
}

async function fromDownload(d: Download): Promise<Captured | null> {
  const failure = await d.failure();
  if (failure) return null;
  const chunks: Buffer[] = [];
  for await (const c of await d.createReadStream()) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return { bytes: Buffer.concat(chunks), url: d.url(), filename: d.suggestedFilename(), how: 'download-event' };
}

export async function inPageFetch(page: Page, url: string) {
  const r = await page.evaluate(async (u: string) => {
    try {
      const res = await fetch(u, { credentials: 'include' });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const buf = new Uint8Array(await res.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { b64: btoa(bin), cd: res.headers.get('content-disposition'), ct: res.headers.get('content-type'), finalUrl: res.url };
    } catch (e: any) { return { error: String(e?.message ?? e) }; } // CORS failure lands here -> caller falls back to context.request
  }, url);
  if ('error' in r) return null;
  return { bytes: Buffer.from(r.b64, 'base64'), filename: parseFilename(r.cd), contentType: r.ct ?? undefined };
}

export function parseFilename(cd?: string | null): string | undefined {
  if (!cd) return undefined;
  const star = /filename\*=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  if (star) { try { return decodeURIComponent(star[1]); } catch { return star[1]; } }
  return /filename="?([^";]+)"?/i.exec(cd)?.[1];
}
```

#### Main-world hook (patchright addInitScript is injected into HTML via routes, so it runs in the page's main world) that captures window.open / target=_blank file URLs before navigation, so the URL can be fetched in-page without spending the token on a tab navigation.

```typescript
await context.addInitScript(() => {
  const FILE_URL = /ambry|\/dms\/|media\.licdn\.com|mediaauth|\.pdf(\?|$)/i;
  (window as any).__resumeUrls = [] as string[];
  const origOpen = window.open;
  window.open = function (u?: string | URL, ...rest: any[]) {
    const s = String(u ?? '');
    if (FILE_URL.test(s)) { (window as any).__resumeUrls.push(s); return null; }
    return (origOpen as any).call(window, u, ...rest);
  } as typeof window.open;
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[target="_blank"]') as HTMLAnchorElement | null;
    if (a && FILE_URL.test(a.href)) { e.preventDefault(); e.stopPropagation(); (window as any).__resumeUrls.push(a.href); }
  }, true);
});
// after clicking the Download control:
const urls: string[] = await page.evaluate(() => (window as any).__resumeUrls?.splice(0) ?? []);
```

#### Sniff real file type from bytes (LinkedIn returns the original Word or PDF upload); reject HTML wrappers (authwall/expired token) so they never reach the artifacts table.

```typescript
export function sniffResume(bytes: Buffer): { ext: 'pdf' | 'docx' | 'doc' | 'bin'; mime: string } | null {
  const head = bytes.subarray(0, 512).toString('latin1');
  if (head.startsWith('%PDF-')) return { ext: 'pdf', mime: 'application/pdf' };
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)
    return { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  if (bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])))
    return { ext: 'doc', mime: 'application/msword' };
  if (/^\s*(<!doctype html|<html)/i.test(head)) return null; // login/authwall page, not a resume
  return { ext: 'bin', mime: 'application/octet-stream' };
}
// artifacts row: sha256(bytes), size, mime (from sniff), original_filename (Content-Disposition / suggestedFilename / `resume.${ext}`), capture_method, source_host = new URL(url).host
```

#### Selector table for both live hiring UIs (new SDUI markup and old Ember markup), collected from 2025-2026 working tools; keep in config so it can be hot-patched.

```typescript
export const SEL = {
  newUI: {
    listUrl: (jobId: string) => `https://www.linkedin.com/hiring/applicants/?jobId=${jobId}`,
    applicantLinks: 'a[href*="applicationId="]',
    detailRoot: '[role="dialog"], [aria-modal="true"], main',
    resumeControl: 'button[data-view-name="hiring-applicant-view-resume"], :is(a,button):has(svg#document-small), :is(a,button):has(span:text-is("Resume"))',
    downloadControl: 'button:has(svg#download-small), button[aria-label*="Download" i], button:has(span:text-is("Download"))',
    dismiss: 'button[aria-label="Dismiss"], button[aria-label="Close"]',
  },
  oldUI: {
    listUrl: (jobId: string) => `https://www.linkedin.com/hiring/jobs/${jobId}/applicants/`,
    cards: 'li.hiring-applicants__list-item',
    applicantLinks: 'li.hiring-applicants__list-item a[href*="/detail/"]',
    detailRoot: '#hiring-detail-root',
    name: '.hiring-applicant-header h1',
    appliedDate: '.hiring-applicant-header__tidbit',
    downloadResume: 'a[aria-label*="Download"][aria-label*="resume"], button[aria-label*="Download"][aria-label*="resume"], a[data-test-resume-action="download"]',
    moreActions: 'button[aria-label*="More actions"]',
    moreMenuDownload: 'div[role="menu"] :text("Download resume")',
    dismiss: '.artdeco-modal__dismiss, button[aria-label="Dismiss"]',
  },
} as const;
```

#### First-run discovery logger to pin down the actual resume URL host, disposition and content-type before committing to a capture path.

```typescript
context.on('response', async (res) => {
  const u = res.url();
  if (!/ambry|\/dms\/|media\.licdn\.com|mediaauth/i.test(u)) return;
  const h = res.headers();
  console.error(JSON.stringify({ url: u.slice(0, 160), status: res.status(), ct: h['content-type'], cd: h['content-disposition'], frame: res.frame().url().slice(0, 80) }));
});
```
