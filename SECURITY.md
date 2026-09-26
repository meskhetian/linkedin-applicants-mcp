# Security Policy

## What this tool stores, and where

linkedin-applicants-mcp runs entirely on your machine. It does not send data anywhere except to
`linkedin.com` through your own Chrome, and it has no telemetry. Everything it collects lands in one
directory, `~/.linkedin-applicants-mcp` by default (`LINKEDIN_MCP_DATA_DIR` overrides it):

| Path | Contents | Sensitivity |
| --- | --- | --- |
| `db.sqlite` | Jobs, applicants (names, headlines, locations, applied dates, application ids, profile URLs, contact email/phone when shared, screening-question answers, your ratings), full text of resumes and profiles (full-text indexed), the task queue, counters, settings | **Personal data of third parties** |
| `files/jobs/<jobId>/<applicationId>_<Name>/` | `resume.pdf` / `.docx` as uploaded, `profile.json`, `profile.png` screenshot, `raw-application.json`, `raw-profile-*.json` | **Personal data of third parties** |
| `files/jobs/<jobId>/raw/` | Raw applicant-list pages and the JSON LinkedIn fetched | Personal data |
| `exports/` | Your CSV / JSON / JSONL exports | Personal data |
| `chrome-profile/` | A dedicated Chrome profile that is **logged in to LinkedIn**: cookies, local storage, history | **Equivalent to your LinkedIn session.** Anyone who copies this folder can act as you on LinkedIn until you log out everywhere. |
| `debug/` | `debug_snapshot` output (screenshots, HTML, page text, captured network payloads) and, with `LINKEDIN_MCP_CAPTURE_RAW=true`, every captured LinkedIn response | Personal data plus your session's page content |
| `logs/` | JSON-lines logs (names and ids can appear at `debug` level) | Personal data at debug level |

On start-up the data directory is created with owner-only permissions (`0700`). The data is **not encrypted
at rest**; it relies on your account and disk encryption (FileVault, BitLocker, LUKS). Treat the directory as
you would treat a folder of printed CVs plus your LinkedIn password:

- Never commit it, sync it to a shared drive, or attach parts of it to a public issue. The default location is
  outside the repository on purpose; `.gitignore` additionally excludes a `data/` folder in the checkout.
- Keep `LINKEDIN_MCP_CAPTURE_RAW` off unless you are actively debugging; turn it off and delete `debug/`
  afterwards.
- Delete applicant data when the hiring process is over. You are the data controller for it under GDPR,
  CCPA and similar laws; the applicants shared it with you for one purpose.
- If you suspect the `chrome-profile/` directory leaked, sign out of all LinkedIn sessions from your LinkedIn
  account settings and delete the directory.

## Threat model

- **Local process, local data.** The MCP server talks to Claude over stdio and to LinkedIn through your own
  visible Chrome window. There is no cloud component and no account with us.
- **The dashboard binds to `127.0.0.1` only** (`npm run dashboard`, port 4173) and has no authentication. It
  is reachable by any process or user logged in to the same machine, so do not run it on a shared host, and do
  not expose it with a reverse proxy or port forward.
- **`cdp` browser mode** attaches to a Chrome with remote debugging enabled on `127.0.0.1:9222`. Any local
  process can drive that Chrome while it runs. Prefer the default `persistent` mode; if you use `cdp`, close
  that Chrome when you are done.
- **Prompt injection from LinkedIn content.** Applicant names, headlines, screening answers, resumes and
  profiles are attacker-controlled text that ends up in tool results Claude reads. Tools return this as data;
  the server never lets page content choose which tool runs next, never navigates outside `linkedin.com`
  (`debug_navigate` is restricted to it) and never writes anything on LinkedIn. If you build on top of this
  server, keep that boundary.
- **Chrome and LinkedIn cookies.** The dedicated profile is separate from your everyday Chrome profile so a bug
  here cannot touch your other sessions, but it *is* a real logged-in LinkedIn session. Guard it as such.
- **Supply chain.** Dependencies are pinned through `package-lock.json`; `npm ci` is used in CI. The server
  never downloads a browser binary: it launches the Chrome already installed on your machine.

Out of scope: LinkedIn's own account-restriction logic (automation is against LinkedIn's User Agreement, and
you use this tool at your own risk, see the README), and vulnerabilities in Chrome, Node.js or LinkedIn itself.

## Supported versions

Only the latest release on the `main` branch receives security fixes.

| Version | Supported |
| --- | --- |
| 0.1.x (latest) | Yes |
| older | No |

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use GitHub's private vulnerability reporting: go to the repository's **Security** tab and click
**Report a vulnerability** (or open `https://github.com/meskhetian/linkedin-applicants-mcp/security/advisories/new`).
This creates a private advisory that only the maintainers can see. Include:

- what the issue is and its impact (for example: data written outside the data directory, a way to reach the
  dashboard from another host, page content that triggers unintended navigation or a write action),
- steps or a minimal proof of concept, with **all real applicant data removed or replaced by fictional data**,
- the version / commit and your OS, Node.js and Chrome versions.

You should get an acknowledgement within a few days. Fixes are released as a patch version with a CHANGELOG
entry and, when relevant, a published advisory that credits the reporter (unless you prefer to stay anonymous).
