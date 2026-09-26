#!/usr/bin/env -S npx tsx
/**
 * One-time (or whenever LinkedIn logs you out) interactive login:
 *   npm run login
 * Opens your installed Google Chrome with the dedicated profile, navigates to LinkedIn's login page and
 * waits for YOU to sign in. Nothing is typed on your behalf. Cookies persist in the profile directory,
 * so the MCP server and worker reuse the session afterwards.
 */
import readline from 'node:readline';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { BrowserSession } from '../src/browser/session.js';

const cfg = loadConfig();
const log = createLogger({ level: 'info' });
const session = new BrowserSession({ cfg, log, getPacing: () => cfg.pacingDefaults });

let closing = false;
async function closeAndExit(code: number): Promise<void> {
  if (closing) return;
  closing = true;
  process.stderr.write('\nClosing the browser (this flushes the saved session to disk)...\n');
  await session.close().catch(() => {});
  process.exit(code);
}
process.on('SIGINT', () => void closeAndExit(130));
process.on('SIGTERM', () => void closeAndExit(143));

process.stderr.write(
  `\nOpening ${cfg.chromeChannel} (${cfg.browserMode} mode)\n  profile: ${cfg.profileDir}\n  data:    ${cfg.dataDir}\nSign in to LinkedIn in the window that opens. Waiting up to 10 minutes...\n\n`,
);

const status = await session.openLogin(10 * 60_000);
process.stderr.write(`\nStatus: ${JSON.stringify(status, null, 2)}\n`);
if (status.loggedIn) {
  process.stderr.write('\nLogged in. The session is saved in the profile directory.\n');
} else if (!status.connected || !status.currentUrl) {
  process.stderr.write('\nThe browser window was closed before the login completed. Run `npm run login` again and keep the window open until you see your LinkedIn feed.\n');
  await closeAndExit(1);
} else {
  process.stderr.write('\nNot logged in yet. You can keep signing in; press Enter here when done (or Ctrl+C to abort).\n');
}

const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
await new Promise<void>((resolve) => rl.question('Press Enter to close the browser... ', () => resolve()));
rl.close();
await closeAndExit(0);
