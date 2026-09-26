# Research notes (2026-09-25, auto-collected; verify before relying on any single claim)

## Driving the user's own Chrome with patchright

### Summary

Research on driving the user's own Google Chrome with Playwright (Node) in a human-looking, low-flag way, as of 2026-09-25.

Bottom line / recommendation for this project (macOS, Node 26, TypeScript, LinkedIn hiring dashboard, thousands of applicants):

1. Do NOT try to attach to the user's daily Chrome profile. Since Chrome 136 (blog 2025-03-17) `--remote-debugging-port` and `--remote-debugging-pipe` are ignored on the default user-data-dir (Chromium source: `IsRemoteDebuggingAllowed()` returns `kDisabledByDefaultUserDataDir` for Google-branded builds on Win/Mac/Linux), and Playwright's own docs say pointing `launchPersistentContext` at the real Chrome profile "may result in pages not loading or the browser exiting". Copying the profile directory does not carry decryptable cookies (different encryption key).

2. Use `patchright` (npm 1.63.0, published 2026-09-08, tracks Playwright 1.63.0 within days, Node >=20) as a drop-in for `playwright`, with `chromium.launchPersistentContext(dedicatedUserDataDir, { channel: 'chrome', headless: false, viewport: null })`. This launches the user's real installed Google Chrome binary (same machine, same IP, real fingerprint) in a second, dedicated profile that can run alongside their normal Chrome (different user-data-dir avoids the SingletonLock). The user logs into LinkedIn once in that window; the session persists in the profile. This is exactly what the reference project (a third-party LinkedIn MCP server, Python) does: it moved to Patchright with a persistent profile in ~/.linkedin-mcp/profile and a "--no-headless" mode for solving checkpoints manually.

3. Why patchright rather than stock Playwright: stock Playwright still (a) calls CDP `Runtime.enable`, which anti-bot scripts detect via console/Error serialization side effects (Chromium fixed one path in May 2025; the `Error.prototype.name` getter path still works per Scrapfly 2026-09-11), (b) launches Chrome with `--remote-debugging-pipe`, which by itself sets `navigator.webdriver=true` (Chromium runtime_features.cc enables `AutomationControlled` for `--enable-automation`, `--headless`, `--remote-debugging-pipe` and `--remote-debugging-port=0`). Note: Playwright removed `--enable-automation` from its default switches in v1.60.0 (2026-05-11, commit 4b1b9d68), so `ignoreDefaultArgs: ['--enable-automation']` is now a no-op; the required fix is `args: ['--disable-blink-features=AutomationControlled']`, which patchright adds by default (verified in the patchright-core 1.63.0 bundle). Patchright also removes `--disable-extensions`, `--disable-component-update`, `--disable-default-apps`, `--disable-popup-blocking`, runs `evaluate` in isolated contexts (`isolatedContext: true` default), and disables the Console domain (so `page.on('console')` will not work). Caveats: it keeps `--use-mock-keychain`/`--password-store=basic` (so the dedicated profile's cookies are encrypted with the mock key; always launch it with the same flags, never open that profile in normal Chrome), the `__playwright_utility_world__` name is unchanged, init scripts go through Routes (avoid `addInitScript`, `exposeFunction`, `setBypassCSP`, custom UA/headers). Expect a yellow "unsupported command-line flag" infobar in headful Chrome because `--disable-blink-features` is in Chrome's bad-flags list (cosmetic, not visible to page JS; `--disable-infobars` was removed from Chrome in 2019).

4. Alternatives evaluated and rejected: rebrowser-patches/rebrowser-playwright are stale (1.0.19 / 1.52.0, both 2025-05-09, repo last push 2025-05-09; Playwright is at 1.63); playwright-extra 4.3.6 + puppeteer-extra-plugin-stealth 2.11.2 last published 2023-03-01 (unmaintained; JS-level overrides create inconsistencies); Camoufox (Firefox; camoufox-js 0.12.0, 2026-07-31, peer playwright-core <1.61) is actively developed but is a different browser/fingerprint, which is precisely the "unfamiliar device" signal that triggers LinkedIn's security verification for an existing account.

5. Fallback if the user insists on their daily profile: Chrome >=144 (blog 2025-12-11) lets the user enable remote debugging at chrome://inspect/#remote-debugging in "approval mode": a WebSocket-only server (no /json HTTP discovery), port and UUID path written to `<userDataDir>/DevToolsActivePort` (two lines), an approval dialog on every connection (no persisted approval yet, issue #825), and a persistent "Chrome is being controlled by automated test software" banner. Connect with `chromium.connectOverCDP('ws://127.0.0.1:<port><path>', { noDefaults: true, timeout: 120000 })` (noDefaults since v1.60 preserves the user's download settings and emulation). It is lower fidelity, downloads then go to the normal Downloads folder rather than Playwright's temp dir, and whether patchright's Runtime.enable avoidance applies over CDP is disputed between sources.

6. Human-like input: mouse.move(x,y,{steps}) is linear interpolation only; use ghost-cursor 1.4.2 (2026-01-12) `path(from,to,{useTimestamps:true})` (framework-agnostic Bezier + Fitts's law) and replay via page.mouse.move, or ghost-cursor-playwright 2.2.1 (2026-09-15; Node>=20; depends on playwright-core ^1.63.0; createCursor BEFORE goto; set debug:false; it stores window.mousePos/window.mouseTarget page globals, a small leak). Scroll with mouse.wheel in variable chunks with pauses (wheel does not wait for scrolling). Type char-by-char with per-character random delays (keyboard.type's delay is a fixed per-char value). Use log-normal inter-action delays (Blenn & Van Mieghem 2016 argue human inter-event times are lognormal; keystroke-dynamics literature and the humaninput model use lognormal IKIs), plus occasional 2-5x "distraction" pauses on ~10-20% of actions and avoiding round-number timers.

7. Downloads: `acceptDownloads` defaults to true; every downloaded file is deleted when the context closes, so always `download.saveAs()` (safe while in progress). Register `page.waitForEvent('download')` BEFORE clicking. For links that open a new tab, first capture the tab (`context.waitForEvent('page')` / `page.waitForEvent('popup')` registered before the click) and then `newPage.waitForEvent('download')`. Chrome renders `Content-Disposition: inline` PDFs in its viewer with no download event in headful mode; pre-write `<userDataDir>/Default/Preferences` with `{"plugins":{"always_open_pdf_externally":true}}` (or toggle "Download PDFs" once in chrome://settings/content/pdfDocuments in the dedicated profile). `page.request.get(url)` shares the context cookie jar but sends from Node (different TLS/HTTP2 fingerprint) - use only as a last resort.

8. Checkpoints: detect by URL (`/checkpoint/challenge/` e.g. .../verify, .../funCaptchaInternal; `/checkpoint/lg/login`; `/checkpoint/rp/`; `/uas/login`; `/login`; `/authwall`) on every main-frame navigation, plus title/text "Security Verification". LinkedIn's help page says challenges appear "from an unfamiliar location or device, or if we detect suspicious web activity" and take the form of a mobile "Yes, it's me" prompt, an emailed code, or a CAPTCHA. On detection: pause the queue, `page.bringToFront()`, notify the operator through the MCP, poll until the URL leaves /checkpoint and /login, then resume; persist queue state in SQLite so a restart resumes.

9. Storage: on Node 26, `node:sqlite` (`DatabaseSync`) is Stability 1.2 "Release candidate", needs no flag, and gained `serialize()` (26.1) and persistent statements (26.8); better-sqlite3 13.0.3 (2026-08-05, Node>=22) remains the mature native alternative.

One web search (LinkedIn logged-out/session-validity detection patterns) was blocked by the permission classifier; the checkpoint guidance above relies on the successful searches, the official LinkedIn help page, and the reference project's README only.

### Facts

- [high] Chrome 136+ ignores --remote-debugging-port and --remote-debugging-pipe when Chrome runs on its default user-data-dir; they must be paired with --user-data-dir pointing to a non-standard directory. Stated rationale: attackers used remote debugging to steal cookies after App-Bound Encryption; a non-standard directory uses a different encryption key. Google recommends Chrome for Testing for automation. Blog dated 2025-03-17.  <https://developer.chrome.com/blog/remote-debugging-port>
- [high] Chromium source (chrome/browser/devtools/remote_debugging_server.cc): IsRemoteDebuggingAllowed() first checks the DevToolsRemoteDebuggingAllowed policy pref, then on Win/Mac/Linux with GOOGLE_CHROME_BRANDING returns NotStartedReason::kDisabledByDefaultUserDataDir when chrome::IsUsingDefaultDataDirectory().value_or(true) is true; the check is applied to both the pipe and the port paths. Non-branded Chromium builds only enable this check for testing.  <https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/devtools/remote_debugging_server.cc>
- [high] Playwright docs (BrowserType.launchPersistentContext): 'Chromium/Chrome: Due to recent Chrome policy changes, automating the default Chrome user profile is not supported. Pointing userDataDir to Chrome's main User Data directory may result in pages not loading or the browser exiting.' Also 'browsers do not allow launching multiple instances with the same User Data Directory'. channel accepts chromium, chrome, chrome-beta, chrome-dev, chrome-canary, msedge(-beta/-dev/-canary). acceptDownloads defaults to true; viewport defaults to 1280x720 (use null); headless defaults to true.  <https://playwright.dev/docs/api/class-browsertype>
- [high] Playwright always launches Chromium/Chrome with --remote-debugging-pipe and --user-data-dir=<dir> (chromium.ts defaultArgs), throws if you pass --user-data-dir or --remote-debugging-pipe yourself ('Playwright manages remote debugging connection itself'); the cdpPort launch option was removed in commit 4b1b9d68 (2026-04-14).  <https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/chromium/chromium.ts>
- [high] Chromium sets the AutomationControlled runtime feature (navigator.webdriver === true) when any of --enable-automation, --headless, --remote-debugging-pipe, or --remote-debugging-port=0 is present (content/child/runtime_features.cc). Navigator::webdriver() returns true if AutomationControlledEnabled(), else a DevTools probe override. Therefore removing --enable-automation alone does not make navigator.webdriver false under Playwright; --disable-blink-features=AutomationControlled is required.  <https://raw.githubusercontent.com/chromium/chromium/main/content/child/runtime_features.cc>
- [high] Playwright removed --enable-automation from its default Chromium switches in commit 4b1b9d68 'chore: remove cdp port from launch options (#40190)' (2026-04-14); v1.56.0-v1.59.0 still had `assistantMode ? '' : '--enable-automation'`, v1.60.0 (released 2026-05-11) and v1.63.0 have none. So ignoreDefaultArgs: ['--enable-automation'] is a no-op on Playwright >= 1.60.  <https://github.com/microsoft/playwright/commit/4b1b9d681f8a7b1dffafa973ef705f28661d4607>
- [high] Playwright main (2026-09-24) default Chromium switches include: --disable-field-trial-config, --disable-background-networking, --disable-background-timer-throttling, --disable-backgrounding-occluded-windows, --disable-back-forward-cache, --disable-breakpad, --disable-client-side-phishing-detection, --disable-component-extensions-with-background-pages, --disable-component-update, --no-default-browser-check, --disable-default-apps, --disable-dev-shm-usage, --disable-edgeupdater, --disable-extensions, --disable-features=<AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,NetworkTimeServiceQuerying,AimEnabled,...>, --enable-features=CDPScreenshotNewSurface, --allow-pre-commit-input, --disable-hang-monitor, --disable-ipc-flooding-protection, --disable-popup-blocking, --disable-prompt-on-repost, --disable-renderer-backgrounding, --disable-updater-scheduler, --force-color-profile=srgb, --metrics-recording-only, --no-first-run, --password-store=basic, --use-mock-keychain, --no-service-autorun, --export-tagged-pdf, --disable-search-engine-choice-screen, --unsafely-disable-devtools-self-xss-warnings, --edge-skip-compat-layer-relaunch, --disable-infobars, --disable-sync.  <https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/chromium/chromiumSwitches.ts>
- [medium] --disable-blink-features is in Chrome's kBadFlags list (bad_flags_prompt.cc line ~137, alongside --enable-blink-features), so headful Chrome shows the 'You are using an unsupported command-line flag ... Stability and security will suffer' infobar on startup when --disable-blink-features=AutomationControlled is passed. The desktop loop has no --enable-automation exemption. This infobar is browser UI, not observable by page JavaScript.  <https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/ui/startup/bad_flags_prompt.cc>
- [high] chrome-launcher's flag reference: --enable-automation 'sets window.navigator.webdriver to true within all JS contexts. This is also set when using --headless, --remote-debugging-pipe and --remote-debugging-port=0'; --use-mock-keychain: 'Use mock keychain on Mac to prevent the blocking permissions dialog'; --password-store=basic avoids Gnome Keyring/KDE wallet; --disable-infobars was 'Removed May 2019'; --disable-component-update stops chrome://components updates; --disable-background-networking disables extension updating, safe browsing, translate, UMA.  <https://github.com/GoogleChrome/chrome-launcher/blob/main/docs/chrome-flags-for-tools.md>
- [high] patchright (npm) latest is 1.63.0, published 2026-09-08, depends on patchright-core 1.63.0, engines node >=20; recent releases 1.61.1 (2026-06-23), 1.62.1 (2026-08-17), 1.62.2 (2026-08-29), 1.62.3 (2026-09-02), 1.63.0 (2026-09-08). Upstream playwright 1.63.0 was published 2026-09-04. GitHub Kaliiiiiiiiii-Vinyzu/patchright: 4,679 stars, pushed 2026-09-13; patchright-nodejs: 788 stars, pushed 2026-09-13.  <https://registry.npmjs.org/patchright>
- [high] Patchright README: patches the Runtime.enable leak by executing JS in isolated ExecutionContexts; patches Console.enable by disabling the Console API entirely (console functionality will not work); command-flag changes: adds --disable-blink-features=AutomationControlled, removes --enable-automation, --disable-popup-blocking, --disable-component-update, --disable-default-apps, --disable-extensions; supports closed shadow roots; Chromium only; InitScripts are implemented via Playwright Routes and are vulnerable to timing attacks; extended API adds isolatedContext (default true) to evaluate/evaluateHandle/evaluateAll. Recommended: chromium.launchPersistentContext(dir, { channel: 'chrome', headless: false, viewport: null }) with no custom headers/userAgent; install via `npm i patchright` and `npx patchright install chromium` or `npx patchright install chrome`. Claims to pass Brotector (with CDP-Patches), Cloudflare, Kasada, Akamai, Shape/F5, Bet365, Datadome, Fingerprint.com, CreepJS, Sannysoft, Incolumitas, IPHey, Browserscan, Pixelscan.  <https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs>
- [high] Verified by grepping the actual npm tarballs (patchright-core 1.63.0 vs playwright-core 1.63.0 lib/coreBundle.js): patchright's default switch list contains --disable-blink-features=AutomationControlled and omits --disable-extensions, --disable-component-update, --disable-default-apps and --disable-popup-blocking; both bundles still contain --use-mock-keychain, --password-store=basic and --disable-infobars; both contain UTILITY_WORLD_NAME = '__playwright_utility_world__' (patchright does not rename the utility world); patchright has 7 'Runtime.enable' string occurrences vs 11 upstream and 61 'isolatedContext' occurrences vs 4 upstream; neither bundle contains '__pwInitScripts' or '__playwright_builtins__' literals.  <https://registry.npmjs.org/patchright-core/-/patchright-core-1.63.0.tgz>
- [medium] Upstream playwright-core 1.63.0's bundled MCP browser config automatically pushes --disable-blink-features=AutomationControlled for chromium when no --disable-blink-features arg is present, and sets viewport null when not headless (i.e., Microsoft's own agent tooling applies this flag).  <https://registry.npmjs.org/playwright-core/-/playwright-core-1.63.0.tgz>
- [high] rebrowser-patches latest npm 1.0.19 published 2025-05-09 (supports Puppeteer 24.8.1, Playwright 1.52.0); rebrowser-playwright 1.52.0 published 2025-05-09; GitHub repo last pushed 2025-05-09 (1,433 stars). Modes via REBROWSER_PATCHES_RUNTIME_FIX_MODE=addBinding|alwaysIsolated|enableDisable|0; also REBROWSER_PATCHES_SOURCE_URL, REBROWSER_PATCHES_UTILITY_WORLD_NAME, REBROWSER_PATCHES_DEBUG. page.pause() does not work with the fix enabled. Test page: https://bot-detector.rebrowser.net/.  <https://github.com/rebrowser/rebrowser-patches>
- [high] rebrowser-bot-detector tests: runtimeEnableLeak (Runtime.enable detectable 'with just a few lines of code'), sourceUrlLeak (automation adds a sourceURL to evaluated scripts, visible in error stacks), mainWorldExecution (sites hook document.querySelector etc. to catch main-world scripts), navigatorWebdriver (fix: --disable-blink-features=AutomationControlled), bypassCsp, viewport (Playwright default 1280x720 is a tell; use viewport: null), window.dummyFn (main-world access), useragent (Chrome for Testing UA is a red flag), pwInitScripts (Playwright injects __pwInitScripts global), exposeFunctionLeak.  <https://github.com/rebrowser/rebrowser-bot-detector>
- [medium] Runtime.enable detection mechanism: with Runtime enabled, CDP emits Runtime.consoleAPICalled/exception events whose object serialization triggers page-defined getters (own Error.stack getter and a getter on Error.prototype.name). Chromium changes in May 2025 addressed the classic stack-getter approach but the prototype-name path still works (Scrapfly, 2026-09-11). rebrowser (2024) describes the fix options: disable automatic Runtime.enable and create contexts with unknown IDs (addBinding), use Page.createIsolatedWorld, or call Runtime.enable then immediately Runtime.disable.  <https://scrapfly.io/blog/posts/chrome-cdp-stealth-browser-automation-detection-explained>
- [high] playwright-extra latest 4.3.6 published 2023-03-01; puppeteer-extra-plugin-stealth latest 2.11.2 published 2023-03-01; berstend/puppeteer-extra repo last pushed 2024-07-18 (7,402 stars). Effectively unmaintained for 3.5 years.  <https://registry.npmjs.org/playwright-extra>
- [medium] Camoufox (daijro/camoufox, 12,136 stars) is actively developed again (v152.0.4-beta.30 on 2026-09-01; pushed 2026-09-25) after a maintenance gap; it is a Firefox fork with C++-level fingerprint patches. camoufox-js (Apify port) latest 0.12.0 published 2026-07-31, engines node >=22, peerDependency playwright-core <1.61.0, depends on better-sqlite3 ^13.0.1. Camoufox does not spoof TLS/HTTP2 fingerprints.  <https://registry.npmjs.org/camoufox-js>
- [low] Whether patchright's stealth applies over connectOverCDP is disputed: one PR description says the patched crPage initialization (no Runtime.enable) lives in the shared lib/coreBundle.js so 'the stealth survives connectOverCDP', while the openclaw-patchright-plugin README says connectOverCDP 'bypasses Patchright's patches entirely' and stealth only applies when patchright launches the browser. Command-line flag patches certainly cannot apply to an externally launched Chrome.  <https://github.com/madarco/controlclaw-ansible-test/pull/1>
- [medium] Chrome M144 (blog 2025-12-11) added remote debugging enablement via chrome://inspect/#remote-debugging: every connection request shows a permission dialog; while debugging is active Chrome shows the 'Chrome is being controlled by automated test software' banner; chrome-devtools-mcp --autoConnect uses this. Feature request #825 asks to persist approvals. The server is WebSocket-only with no /json/version HTTP discovery; clients must read the DevToolsActivePort file in the user data dir (line 1 = port, line 2 = websocket path UUID) and connect to ws://127.0.0.1:<port><path>; Playwright connectOverCDP must be given the ws:// URL and a long timeout to wait for the approval dialog.  <https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session>
- [medium] Chromium remote_debugging_server.cc implements this approval mode (StartHttpServerInApprovalModeIfEnabled / kWithApprovalOnly) gated by the DevToolsAcceptDebuggingConnections feature and the DevToolsRemoteDebuggingEnabled + DevToolsRemoteDebuggingAllowed prefs, writing the port to DevToolsActivePort in DIR_USER_DATA; this code path does not consult the default-user-data-dir check, implying it is intended for the user's regular profile.  <https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/devtools/remote_debugging_server.cc>
- [high] Playwright connectOverCDP option noDefaults (added v1.60, default false): when true Playwright does not apply its default overrides to the existing default browser context (leaves acceptDownloads at the browser's setting, disables focus emulation, skips colorScheme/reducedMotion/forcedColors/contrast emulation); useful when connecting to a user's primary browser. Docs also state the CDP connection 'is significantly lower fidelity than the Playwright protocol connection'. Without noDefaults, attaching redirects native downloads into Playwright's temp directory (openclaw issue #157547).  <https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp>
- [high] Playwright Download API: acceptDownloads defaults to true; 'All downloaded files are deleted when the browser context closes'; download.saveAs(path) 'is safe to call while the download is still in progress' and can be called multiple times; path() returns a random-GUID filename and throws for failed/canceled downloads; suggestedFilename() comes from Content-Disposition or the download attribute; failure() waits for completion and returns error string or null; also cancel(), createReadStream(), delete(), url(), page(). Use downloadsPath to control the temp location. Recommended pattern: const downloadPromise = page.waitForEvent('download'); await click; const download = await downloadPromise; await download.saveAs(...).  <https://playwright.dev/docs/api/class-download>
- [high] When a download starts in a newly opened tab, page.waitForEvent('download') on the original page never fires (Playwright issue #3689). Correct pattern: register context.waitForEvent('page') or page.waitForEvent('popup') BEFORE clicking, await the new Page, then await newPage.waitForEvent('download'). Do not click first and then register the waiter.  <https://github.com/microsoft/playwright/issues/3689>
- [medium] Headful Chromium renders PDFs served with Content-Disposition: inline in its built-in PDF viewer and emits no download event (Playwright issues #3365, #3509, #20633, #20771). Known workarounds: write <userDataDir>/Default/Preferences containing {"plugins":{"always_open_pdf_externally":true}} before launchPersistentContext (or toggle 'Download PDFs' in chrome://settings/content/pdfDocuments once in the dedicated profile), or intercept the response with page.route and set Content-Disposition: attachment.  <https://github.com/microsoft/playwright/issues/3365>
- [high] APIRequestContext (page.request / browserContext.request) sends requests from Node.js, 'uses the same cookie jar as its BrowserContext', populates request cookies from the context and updates context cookies from responses; get() supports headers, maxRedirects (default 20), timeout (default 30s); response bodies are kept in memory for body(). Because requests originate from Node, TLS/HTTP2 fingerprints differ from Chrome's.  <https://playwright.dev/docs/api/class-apirequestcontext>
- [high] Playwright Mouse/Keyboard: mouse.move(x, y, { steps }) 'Sends n intermediate mousemove events' (default 1, linear interpolation); mouse.wheel(deltaX, deltaY) dispatches a wheel event and 'does not wait for the scrolling to finish before returning'; mouse.click delay = time between mousedown and mouseup (default 0); keyboard.type(text, { delay }) sends keydown/keypress/input/keyup per character with a fixed 'Time to wait between key presses in milliseconds' (default 0); keyboard.insertText dispatches only an input event; docs recommend locator.pressSequentially when per-key events matter.  <https://playwright.dev/docs/api/class-mouse>
- [high] ghost-cursor (Xetera) latest 1.4.2 published 2026-01-12 (deps bezier-js ^6.1.3; repo pushed 2026-09-13, 1,598 stars). Exports framework-agnostic path(start, end, { useTimestamps }) returning Bezier-curve points (optionally timestamped) usable with any mouse API, plus a Puppeteer-specific GhostCursor class (overshootThreshold default 500px, paddingPercentage, moveDelay/randomizeMoveDelay, hesitate, waitForClick, scroll/scrollTo/scrollIntoView with scrollSpeed 0-100, getRandomPagePoint, installMouseHelper).  <https://raw.githubusercontent.com/Xetera/ghost-cursor/master/README.md>
- [high] ghost-cursor-playwright (reaz1995) latest 2.2.1 published 2026-09-15 (engines node >=20; dependencies bezier-js ^6.1.4, playwright-core ^1.63.0, trusted-types). API: createCursor(page, { overshootSpread: 10, overshootRadius: 120, debug: true }) must be called BEFORE page.goto; cursor.actions.move(target, { paddingPercentage, waitBeforeMove: [min,max] }); cursor.actions.click({ target, waitBeforeClick, waitBetweenClick: [20,50], doubleClick }); cursor.actions.randomMove(); auto-scrolls target into view; overshoot only above 500px; falls back to page.click if the element is covered. Caveats: debug defaults to true (visible overlay), and it stores window.mousePos and window.mouseTarget on the page (detectable globals); it does not change fingerprints.  <https://raw.githubusercontent.com/reaz1995/ghost-cursor-playwright/master/README.md>
- [medium] Human inter-event times are well modeled as lognormal: Blenn & Van Mieghem (2016) 'Are human interactivity times lognormal?' argue inter-activity times 'are likely to follow a lognormal distribution' over the full range; keystroke-dynamics literature and the humaninput timing model (towa0/humaninput, Python) draw inter-key intervals from a log-normal (e.g. mu_ms=128, sigma=0.42 for a 75 WPM touch typist) with digraph-class multipliers, burst/cognitive pauses, an Ornstein-Uhlenbeck pace drift, Fitts's-law mouse durations and minimum-jerk velocity profiles.  <https://arxiv.org/abs/1607.02952>
- [low] A 2026-06-29 write-up on a 'jittered delay engine' for social automation uses heavy-tailed (exponential, capped) delays instead of uniform random, per-action-type means (e.g. 45s reply / 90s follow / 120s DM), injects 2-5x 'distraction' pauses on 10-20% of actions, and de-rounds any delay within 500 ms of round numbers (10/15/20/30/45/60/90/120 s); reports 0/10 accounts flagged vs 3/10 with uniform random over 8 weeks (anecdotal).  <https://dev.to/helperx/a-jittered-delay-engine-that-doesnt-look-like-a-bot-2ck0>
- [medium] LinkedIn security-verification challenges live under https://www.linkedin.com/checkpoint/challenge/... (e.g. /checkpoint/challenge/verify, /checkpoint/challenge/funCaptchaInternal, page title 'Security Verification | LinkedIn'); login/re-auth pages use /checkpoint/lg/login..., /uas/login, /login, and the /authwall interstitial. LinkedIn Help ('Security verification when signing in') says challenges appear 'from an unfamiliar location or device, or if we detect suspicious web activity' and take three forms: a mobile sign-in prompt ('Yes, it's me'), an emailed verification code, or a CAPTCHA (type the characters in an image).  <https://www.linkedin.com/help/linkedin/answer/a1339220/security-verification-when-signing-in>
- [medium] Reference project a third-party LinkedIn MCP server is Python (FastMCP) and drives Chromium via Patchright (not Selenium): persistent profile in ~/.linkedin-mcp/profile/, interactive login window, session import from local browsers, headless by default with --no-headless so users can solve CAPTCHA/checkpoint challenges manually, sequential tool-call queue, --status session check, --slow-mo and timeouts. Issues #216/#977 show that importing only li_at/li_rm cookies loses session state and collides with anonymous cookies.  (source omitted)
- [high] node:sqlite in Node.js v26.10.0 docs: Stability 1.2 'Release candidate'; no flag needed since v22.13.0/v23.4.0; v25.7.0 made it a release candidate; v26.1.0 added database.serialize()/deserialize(); v26.8.0 added the persistent option to prepare(), statement.close() and statement.stat(); DatabaseSync is synchronous like better-sqlite3. better-sqlite3 latest 13.0.3 published 2026-08-05, engines node >=22.  <https://nodejs.org/api/sqlite.html>
- [low] On macOS Chrome stores its cookie-encryption key in the login Keychain as 'Chrome Safe Storage' (AES-CBC 128-bit). Playwright launches Chrome with --use-mock-keychain (mock keychain, no Keychain prompts). Consequence (inferred from flag semantics, not verified in source): a profile created under Playwright encrypts cookies with the mock key, so it stays logged in only while launched with the same flags, and copying cookies from the user's normal Chrome profile into it will not decrypt.  <https://gist.github.com/creachadair/937179894a24571ce9860e2475a2d2ec>

### Recommendations

- Adopt `patchright@1.63.0` (pin to the same minor as playwright; it tracks upstream within days) as the only Playwright import; never mix `playwright` and `patchright` Page objects. Install with `npm i patchright` and rely on the user's installed Google Chrome via `channel: 'chrome'` (or `npx patchright install chrome`). Node >=20 satisfied by Node 26.
- Launch with `chromium.launchPersistentContext(userDataDir, { channel: 'chrome', headless: false, viewport: null, acceptDownloads: true, downloadsPath })` where userDataDir is a dedicated directory such as `~/Library/Application Support/linkedin-applicants-mcp/chrome-profile`. Never point it at `~/Library/Application Support/Google/Chrome` (Chrome 136+ policy; Playwright docs say it may not load or may exit). Because the dir differs from the user's daily profile there is no SingletonLock conflict, so their normal Chrome can stay open.
- Do not rely on `ignoreDefaultArgs: ['--enable-automation']` (no-op since Playwright 1.60). If you ever run stock Playwright instead of patchright, add `args: ['--disable-blink-features=AutomationControlled']` because `--remote-debugging-pipe` alone sets navigator.webdriver=true. Expect and document the yellow 'unsupported command-line flag' infobar; do not try to hide it with --disable-infobars (removed in 2019).
- Keep the launch flags identical across runs (patchright keeps --use-mock-keychain and --password-store=basic). Treat the dedicated profile as owned by the MCP: never open it in regular Chrome and never use `ignoreDefaultArgs: true`, or the stored LinkedIn cookies may become undecryptable and the user gets logged out (and a re-login from a 'new device' invites a checkpoint).
- First-run flow: launch the profile, navigate to https://www.linkedin.com/login, and wait (with a long timeout) until the URL is on /feed/ or /hiring/ while the user logs in by hand, solving any checkpoint themselves. Persist nothing but the profile directory; do not import li_at cookies (the reference project's issues #216/#977 show partial cookie imports break sessions).
- Avoid every Playwright feature that leaves page-visible traces: addInitScript (patchright routes it, timing-detectable), exposeFunction/exposeBinding, setBypassCSP, custom userAgent/extraHTTPHeaders, page.on('console') (disabled in patchright anyway), and page.evaluate in the main world (keep patchright's default isolatedContext: true; prefer locators and innerText/attributes over evaluate).
- Human-like pacing: implement a `humanDelay(kind)` helper sampling a log-normal (e.g. median 900 ms, sigma 0.5 between clicks; median 2.5-6 s for 'reading' a profile/applicant), add a 10-15% chance of a 3-8x 'distraction' pause, de-round values, and apply session-level pacing (e.g. 40-80 applicants per hour with breaks of several minutes every 20-40 items, and no runs outside the user's normal working hours). Store the last-action timestamp in SQLite so restarts do not burst.
- Mouse: generate paths with ghost-cursor's framework-agnostic `path(from, to, { useTimestamps: true })` and replay them with `page.mouse.move(x, y)` honoring the timestamps, then `mouse.down()`, log-normal 40-120 ms, `mouse.up()`. Click a random point inside the element's bounding box (padding 20-30%). If you use ghost-cursor-playwright instead, set `debug: false`, call createCursor before goto, and accept that it adds window.mousePos/window.mouseTarget globals.
- Scrolling: move in variable chunks of 80-450 px with `page.mouse.wheel(0, dy)` and log-normal pauses, occasionally scroll back up 100-200 px, and pause longer when new content (applicant cards) appears; never use `scrollIntoViewIfNeeded` as the primary way to reach list items.
- Typing: use `locator.click()` via the cursor, then loop characters with `page.keyboard.type(ch)` (or `keyboard.press`) and per-character log-normal delays (median ~140 ms, sigma ~0.4; slower for digits/punctuation), with occasional typo + Backspace. Do not use `fill()` for search boxes that LinkedIn may instrument.
- Downloads (resumes): register `const dl = page.waitForEvent('download')` before the click; if the control opens a new tab, first `const [popup] = await Promise.all([page.waitForEvent('popup'), cursor.click(...)])` then `popup.waitForEvent('download')`; always `await download.saveAs(finalPath)` (temp files vanish on context close), record `download.url()` and `suggestedFilename()` in SQLite, close the popup with a human-like delay. Pre-create `<userDataDir>/Default/Preferences` with `{"plugins":{"always_open_pdf_externally":true}}` (only when the file does not yet exist) so inline PDFs download instead of rendering in the viewer. Fall back to in-page `fetch()` of the href (base64 via evaluate) if a resource never emits a download; use `page.request.get()` only as a last resort because it bypasses Chrome's network stack.
- Checkpoint handling: on every main-frame navigation (`page.on('framenavigated')`) and after each tool step, test the URL against /checkpoint/, /uas/login, /login, /authwall and the title 'Security Verification'; also treat HTTP 429/999 responses and LinkedIn's 'We've restricted your account' pages as stop conditions. On detection: set the queue to PAUSED_FOR_HUMAN in SQLite, `page.bringToFront()`, expose the state through an MCP tool/resource and log, then poll every 5-10 s until the URL is back on /hiring/ or /feed/ (or a resume tool is called), and resume only after a cool-down of several minutes.
- Do not use rebrowser-patches/rebrowser-playwright (stale at Playwright 1.52, May 2025), playwright-extra + stealth plugin (last release March 2023), or Camoufox (Firefox: different fingerprint = 'unfamiliar device' signal for an already logged-in LinkedIn account).
- Only if the user insists on their daily Chrome profile: require Chrome >= 144, have them enable chrome://inspect/#remote-debugging, read `<default userDataDir>/DevToolsActivePort` (port line + ws path line), connect with `chromium.connectOverCDP('ws://127.0.0.1:' + port + path, { noDefaults: true, timeout: 120000 })`, and accept the per-connection approval dialog, the permanent 'controlled by automated test software' banner, lower fidelity, downloads landing in ~/Downloads (handle by watching that folder), and unresolved stealth over CDP. This path is not recommended as the default.
- Storage: use built-in `node:sqlite` (`DatabaseSync`, release-candidate stability on Node 26, zero native deps) with WAL mode for the job/applicant/download queue; keep better-sqlite3@13 as a fallback if you need its richer API. Store per-applicant status (queued/in_progress/done/failed/paused), attempt counts, last-seen URLs, download paths, and timestamps so a crash or checkpoint pause resumes idempotently.
- Before going live, run the profile through https://bot-detector.rebrowser.net/ and https://bot.sannysoft.com/ (expect all green except the deliberate useragent line) and check `navigator.webdriver === false` via a locator-free page (e.g. in the DevTools console by hand), since detection tooling changes frequently.

### Open questions

- Do LinkedIn hiring-dashboard resume links respond with Content-Disposition: attachment (a real download event) or inline PDF (Chrome viewer, no event)? This determines whether the Preferences workaround or a popup+download flow is needed; it must be tested against a real job with applicants.
- Does patchright's Runtime.enable avoidance apply when attaching via connectOverCDP (one PR says the patched crPage code is shared and survives CDP attach; the openclaw plugin README says CDP attach bypasses the patches)? Only relevant to the non-recommended 'daily profile via chrome://inspect' fallback.
- Does the Chrome >=144 chrome://inspect approval-mode server actually start on the DEFAULT user-data-dir on macOS with current stable Chrome (the Chromium source suggests the default-dir check is not consulted on that path, and the feature is aimed at the user's regular browser, but this was not verified by testing)?
- Exact cookie-encryption behavior of a profile created under --use-mock-keychain on macOS (which key OSCrypt derives, and whether later launching the same profile without the flag or in normal Chrome loses the session) could not be confirmed from Chromium source in this session; treat 'always launch with identical flags' as a hard rule until tested.
- ghost-cursor-playwright 2.2.1 declares a hard dependency on playwright-core ^1.63.0; whether it works correctly with a patchright Page (duplicate playwright-core installed side by side) is untested; using ghost-cursor's path() with page.mouse.move avoids the question.
- A web search for LinkedIn logged-out/session-validity redirect patterns was blocked by the permission classifier; the checkpoint/login URL list here comes from the other successful searches, LinkedIn's help page and the reference repository, and should be validated against live behavior (for example the exact redirect target when li_at expires).
- Whether the 'unsupported command-line flag' infobar for --disable-blink-features=AutomationControlled appears in the current Chrome stable on macOS was confirmed from the Chromium source list, not visually; verify on the user's machine and decide whether to leave it or dismiss it programmatically (it cannot be suppressed by flags).
- LinkedIn's rate thresholds for recruiter/hiring-dashboard browsing (applicant list paging, profile views per hour/day) are undocumented; the pacing numbers suggested here are conservative heuristics, not measured limits, and the queue should expose them as tunable settings.

### Snippets

#### Recommended launch: patchright + user's real Chrome + dedicated persistent profile (macOS)

```typescript
import { chromium, type BrowserContext } from 'patchright'; // drop-in for 'playwright'
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const USER_DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'linkedin-applicants-mcp', 'chrome-profile');
const DOWNLOADS_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'linkedin-applicants-mcp', 'downloads-tmp');

async function ensurePdfDownloadPref(userDataDir: string) {
  // Chrome renders Content-Disposition: inline PDFs in its viewer (no download event).
  // Seed the profile pref once, only if the profile does not exist yet.
  const prefs = path.join(userDataDir, 'Default', 'Preferences');
  try { await fs.access(prefs); return; } catch {}
  await fs.mkdir(path.dirname(prefs), { recursive: true });
  await fs.writeFile(prefs, JSON.stringify({ plugins: { always_open_pdf_externally: true } }));
}

export async function launchChrome(): Promise<BrowserContext> {
  await ensurePdfDownloadPref(USER_DATA_DIR);
  await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',        // real /Applications/Google Chrome.app, not Chromium/CfT
    headless: false,          // headless (old or new) is a strong signal; keep a visible window
    viewport: null,           // use the real window size (1280x720 default is a tell)
    acceptDownloads: true,    // default, explicit for clarity
    downloadsPath: DOWNLOADS_DIR,
    // Do NOT set userAgent, locale, timezoneId, extraHTTPHeaders, or addInitScript.
    // patchright already adds --disable-blink-features=AutomationControlled and drops
    // --disable-extensions/--disable-component-update/--disable-default-apps/--disable-popup-blocking.
    // NOTE: ignoreDefaultArgs: ['--enable-automation'] is a no-op on Playwright/patchright >= 1.60.
  });
  context.setDefaultTimeout(30_000);
  return context;
}

// Stock-playwright equivalent (if you ever cannot use patchright):
// chromium.launchPersistentContext(USER_DATA_DIR, { channel: 'chrome', headless: false, viewport: null,
//   args: ['--disable-blink-features=AutomationControlled'],   // needed because --remote-debugging-pipe sets webdriver=true
//   ignoreDefaultArgs: ['--disable-extensions', '--disable-component-update', '--disable-default-apps'] });
```

#### Human-like timing utilities: log-normal delays, distraction pauses, de-rounding

```typescript
// Log-normal is the empirically supported shape for human inter-event times
// (Blenn & Van Mieghem 2016; keystroke-dynamics literature).
function randn(): number { // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Sample a log-normal with the given median (ms) and sigma (log-space spread). */
export function lognormalMs(medianMs: number, sigma = 0.45, minMs = 40, maxMs = medianMs * 8): number {
  const x = medianMs * Math.exp(sigma * randn());
  return Math.min(maxMs, Math.max(minMs, x));
}

const PROFILES = {
  key:      { median: 140,  sigma: 0.40 },  // between keystrokes
  micro:    { median: 350,  sigma: 0.50 },  // between mouse move and click, small hesitations
  click:    { median: 900,  sigma: 0.55 },  // between UI actions
  read:     { median: 4500, sigma: 0.60 },  // 'reading' an applicant card / profile section
  navigate: { median: 2500, sigma: 0.50 },  // after page load before acting
} as const;

export function humanDelayMs(kind: keyof typeof PROFILES, distractionProb = 0.12): number {
  const p = PROFILES[kind];
  let ms = lognormalMs(p.median, p.sigma);
  if (Math.random() < distractionProb) ms *= 3 + Math.random() * 5; // 3x-8x 'got distracted'
  // de-round: avoid landing within 50 ms of a multiple of 500 ms (timer-like fingerprint)
  const r = ms % 500; if (r < 50 || r > 450) ms += 60 + Math.random() * 140;
  return Math.round(ms);
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export const pause = (kind: keyof typeof PROFILES) => sleep(humanDelayMs(kind));

// Session pacing example: long break every N items, computed once per batch
export function shouldTakeBreak(itemsDone: number, every = 25 + Math.floor(Math.random() * 15)) {
  return itemsDone > 0 && itemsDone % every === 0; // then sleep(lognormalMs(240_000, 0.5, 120_000, 900_000))
}
```

#### Human mouse movement and clicks using ghost-cursor's framework-agnostic path() with Playwright's mouse

```typescript
import { path as ghostPath } from 'ghost-cursor'; // v1.4.2, works with any 2D plane
import type { Page, Locator } from 'patchright';
import { lognormalMs, pause, sleep } from './timing';

let cursorPos = { x: 200 + Math.random() * 300, y: 200 + Math.random() * 200 }; // track between calls

export async function humanMoveTo(page: Page, to: { x: number; y: number }) {
  const route = ghostPath(cursorPos, to, { useTimestamps: true }) as Array<{ x: number; y: number; timestamp: number }>;
  let prev = route[0]?.timestamp ?? Date.now();
  for (const pt of route) {
    const wait = pt.timestamp - prev; prev = pt.timestamp;
    if (wait > 0) await sleep(wait);
    await page.mouse.move(pt.x, pt.y);
  }
  cursorPos = to;
}

function randomPointIn(box: { x: number; y: number; width: number; height: number }, padPct = 0.25) {
  const px = box.width * padPct, py = box.height * padPct;
  return { x: box.x + px + Math.random() * Math.max(1, box.width - 2 * px),
           y: box.y + py + Math.random() * Math.max(1, box.height - 2 * py) };
}

export async function humanClick(page: Page, target: Locator) {
  await target.waitFor({ state: 'visible' });
  // bring it into view with wheel scrolling (see humanScrollIntoView) rather than scrollIntoViewIfNeeded
  const box = await target.boundingBox();
  if (!box) throw new Error('target has no bounding box');
  await humanMoveTo(page, randomPointIn(box));
  await sleep(lognormalMs(180, 0.5, 60, 900)); // hover hesitation
  await page.mouse.down();
  await sleep(lognormalMs(75, 0.35, 35, 220)); // press duration
  await page.mouse.up();
  await pause('click');
}

// Alternative: ghost-cursor-playwright 2.2.1 (createCursor BEFORE goto; set debug:false)
// import { createCursor } from 'ghost-cursor-playwright';
// const cursor = await createCursor(page, { debug: false });
// await page.goto(url); await cursor.actions.click({ target: 'a.some-link', waitBeforeClick: [200, 900] }, { paddingPercentage: 30 });
```

#### Human-like scrolling (wheel in variable chunks) and typing with per-character log-normal delays

```typescript
import type { Page, Locator } from 'patchright';
import { lognormalMs, sleep, pause } from './timing';

/** Scroll the page by roughly `totalPx` using variable wheel ticks and reading pauses. */
export async function humanScroll(page: Page, totalPx: number) {
  let remaining = Math.abs(totalPx); const dir = Math.sign(totalPx) || 1;
  while (remaining > 0) {
    const chunk = Math.min(remaining, Math.round(lognormalMs(220, 0.5, 80, 450)));
    await page.mouse.wheel(0, dir * chunk);           // does not wait for scroll to finish
    remaining -= chunk;
    await sleep(lognormalMs(140, 0.6, 40, 900));
    if (Math.random() < 0.07) { await page.mouse.wheel(0, -dir * Math.round(60 + Math.random() * 140)); await sleep(lognormalMs(500, 0.5)); } // brief scroll-back
  }
  await pause('read');
}

/** Scroll until the locator is inside the viewport, like a person hunting for it. */
export async function humanScrollIntoView(page: Page, target: Locator, maxSteps = 40) {
  for (let i = 0; i < maxSteps; i++) {
    const box = await target.boundingBox();
    const vh = page.viewportSize()?.height ?? (await page.evaluate(() => window.innerHeight));
    if (box && box.y > 80 && box.y + box.height < vh - 80) return;
    await humanScroll(page, box ? (box.y < 80 ? -300 : 300) : 500);
  }
  throw new Error('could not scroll target into view');
}

/** Type like a human: per-character log-normal delays, slower on digits/punctuation, rare typo+backspace. */
export async function humanType(page: Page, text: string, typoProb = 0.02) {
  for (const ch of text) {
    if (Math.random() < typoProb && /[a-z]/i.test(ch)) {
      const wrong = String.fromCharCode(ch.charCodeAt(0) + (Math.random() < 0.5 ? 1 : -1));
      await page.keyboard.type(wrong); await sleep(lognormalMs(260, 0.4));
      await page.keyboard.press('Backspace'); await sleep(lognormalMs(180, 0.4));
    }
    await page.keyboard.type(ch); // Playwright's own delay option is a fixed value; we randomize per char instead
    const slow = /[0-9@.,_\-]/.test(ch) ? 1.7 : 1;
    await sleep(lognormalMs(140 * slow, 0.4, 45, 1200));
  }
}
```

#### Capturing a resume download, including the case where the link opens a new tab

```typescript
import type { BrowserContext, Page, Locator, Download } from 'patchright';
import path from 'node:path';
import { humanClick } from './mouse';
import { pause } from './timing';

export async function downloadViaClick(context: BrowserContext, page: Page, trigger: Locator, destDir: string, baseName: string) {
  // Register BOTH waiters before clicking: the download may fire on this page or in a popup.
  const popupP = page.waitForEvent('popup', { timeout: 8_000 }).catch(() => null);
  const directP = page.waitForEvent('download', { timeout: 20_000 }).catch(() => null);
  await humanClick(page, trigger);

  let download: Download | null = await Promise.race([
    directP,
    popupP.then(async (popup) => popup ? popup.waitForEvent('download', { timeout: 20_000 }).catch(() => null) : null),
  ]);
  if (!download) download = await directP; // last chance
  if (!download) throw new Error('no download event (inline PDF viewer? check always_open_pdf_externally)');

  const suggested = download.suggestedFilename() || 'resume.pdf';
  const ext = path.extname(suggested) || '.pdf';
  const dest = path.join(destDir, baseName + ext);
  await download.saveAs(dest);                 // MUST save: temp files are deleted when the context closes
  const failure = await download.failure();
  if (failure) throw new Error('download failed: ' + failure);

  const popup = await popupP;
  if (popup && !popup.isClosed()) { await pause('micro'); await popup.close(); }
  return { dest, url: download.url(), suggested };
}

// Last-resort fallback that stays inside Chrome's network stack (same cookies, XHR-like):
export async function fetchInPage(page: Page, href: string): Promise<Buffer> {
  const b64 = await page.evaluate(async (u: string) => {
    const r = await fetch(u, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = new Uint8Array(await r.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, href);
  return Buffer.from(b64, 'base64');
}
// Avoid page.request.get(href) except as a final fallback: it shares cookies but sends from Node (different TLS/HTTP2 fingerprint).
```

#### Checkpoint / logged-out detection with pause-for-human and resume

```typescript
import type { Page, Frame } from 'patchright';

const CHECKPOINT_URL = /linkedin\.com\/(checkpoint\/|uas\/login|login(\?|$)|authwall)/i;
const OK_URL = /linkedin\.com\/(hiring|talent|feed|in\/|jobs)/i;

export type SessionState = 'ok' | 'checkpoint' | 'logged_out' | 'restricted';

export async function classify(page: Page): Promise<SessionState> {
  const url = page.url();
  if (/\/checkpoint\/challenge\//i.test(url)) return 'checkpoint';         // 'Security Verification' (CAPTCHA / email code / app prompt)
  if (/\/checkpoint\/(lg|rp)\//i.test(url) || /\/uas\/login|\/login(\?|$)|\/authwall/i.test(url)) return 'logged_out';
  const title = (await page.title().catch(() => '')).toLowerCase();
  if (title.includes('security verification')) return 'checkpoint';
  if (title.includes('sign in') || title.includes('log in')) return 'logged_out';
  if (/restricted|temporarily restricted/i.test(title)) return 'restricted';
  return 'ok';
}

export class HumanGate {
  paused = false; reason: SessionState = 'ok';
  private waiters: Array<() => void> = [];
  constructor(private page: Page, private notify: (msg: string) => void, private persist: (s: SessionState) => void) {
    page.on('framenavigated', (f: Frame) => { if (f === page.mainFrame() && CHECKPOINT_URL.test(f.url())) void this.trip(); });
    page.on('response', (r) => { if ([429, 999].includes(r.status()) && r.url().includes('linkedin.com')) void this.trip('restricted'); });
  }
  async trip(force?: SessionState) {
    const state = force ?? await classify(this.page);
    if (state === 'ok' || this.paused) return;
    this.paused = true; this.reason = state; this.persist(state);
    await this.page.bringToFront().catch(() => {});
    this.notify(`LinkedIn needs a human: ${state} at ${this.page.url()}. Solve it in the Chrome window; the queue is paused.`);
    // Poll until the user has cleared it (or an MCP 'resume' tool resolves the gate).
    const deadline = Date.now() + 60 * 60_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 7_000));
      if (!CHECKPOINT_URL.test(this.page.url()) && OK_URL.test(this.page.url()) && (await classify(this.page)) === 'ok') break;
    }
    await new Promise(r => setTimeout(r, 120_000 + Math.random() * 180_000)); // cool-down after a challenge
    this.paused = false; this.reason = 'ok'; this.persist('ok');
    this.waiters.splice(0).forEach(w => w());
  }
  /** Call before every queue step. */
  async waitIfPaused() { if (!this.paused) { if ((await classify(this.page)) !== 'ok') await this.trip(); return; } await new Promise<void>(r => this.waiters.push(r)); }
}
```

#### Fallback only: attach to the user's daily Chrome (>=144) enabled via chrome://inspect/#remote-debugging

```typescript
// Requires: user opens chrome://inspect/#remote-debugging and enables it; every connection shows an approval dialog
// and Chrome shows a permanent 'controlled by automated test software' banner. Lower fidelity than launching.
import { chromium } from 'patchright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function attachToDailyChrome() {
  const userDataDir = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  const raw = await fs.readFile(path.join(userDataDir, 'DevToolsActivePort'), 'utf8'); // line1 = port, line2 = ws path
  const [portLine, wsPath] = raw.split('\n').map(s => s.trim()).filter(Boolean);
  const wsUrl = `ws://127.0.0.1:${portLine}${wsPath.startsWith('/') ? wsPath : '/' + wsPath}`;
  // No /json/version HTTP discovery exists in this mode; pass the ws:// URL directly and wait for the user's approval click.
  const browser = await chromium.connectOverCDP(wsUrl, { noDefaults: true, timeout: 120_000 });
  const context = browser.contexts()[0];            // the user's default context
  // With noDefaults, Playwright leaves acceptDownloads etc. alone: downloads land in ~/Downloads, not download events.
  return { browser, context };
}
```

#### Minimal resumable queue schema with built-in node:sqlite (Node 26)

```typescript
import { DatabaseSync } from 'node:sqlite'; // Stability 1.2 (release candidate) in Node 26, no flag needed

export function openDb(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, title TEXT, status TEXT, applicant_count INTEGER, last_synced_at INTEGER);
    CREATE TABLE IF NOT EXISTS applicants (
      applicant_key TEXT PRIMARY KEY, job_id TEXT NOT NULL, name TEXT, profile_url TEXT, application_url TEXT,
      state TEXT NOT NULL DEFAULT 'queued',        -- queued | in_progress | done | failed | paused_for_human
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      resume_path TEXT, profile_json TEXT, application_json TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_applicants_state ON applicants(job_id, state);
    CREATE TABLE IF NOT EXISTS session (k TEXT PRIMARY KEY, v TEXT);  -- last_action_at, gate_state, items_done_today...
  `);
  return db;
}

export function nextApplicant(db: DatabaseSync, jobId: string) {
  return db.prepare(`SELECT * FROM applicants WHERE job_id = ? AND state IN ('queued','failed') AND attempts < 3 ORDER BY updated_at LIMIT 1`).get(jobId) as any;
}
```
