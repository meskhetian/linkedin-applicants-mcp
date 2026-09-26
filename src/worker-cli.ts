#!/usr/bin/env node
/**
 * Standalone worker (no MCP). Keeps draining the queue while Claude Desktop is closed:
 *   LINKEDIN_MCP_DATA_DIR=~/.linkedin-applicants-mcp npm run worker
 * Enqueue work from Claude (the MCP tools write to the same SQLite DB); only one process drives the browser
 * at a time (owner lock), so stop this when you want the MCP server to run the queue itself.
 */
for (const m of ['log', 'info', 'debug', 'trace'] as const) {
  // Nothing but our logger should write to stdout/stderr unexpectedly; keep console output on stderr.
  (console as unknown as Record<string, (...a: unknown[]) => void>)[m] = (...args: unknown[]) => console.error(...args);
}

import { bootstrap } from './bootstrap.js';
import { errorMessage } from './errors.js';

const deps = bootstrap({ ownerKind: 'cli' });
const { worker, session, db, log } = deps;

worker.start();
if (!worker.isRunning()) {
  log.error('worker did not start (another process owns the queue?)', { status: worker.status() });
  process.exit(2);
}

const ticker = setInterval(() => {
  const s = worker.status();
  const t = db.taskCounts();
  process.stderr.write(
    `[worker] ${new Date().toISOString()} pending=${t.pending} running=${t.running} done=${t.done} failed=${t.failed} today(applicants=${s.todayCounts.applicants} profiles=${s.todayCounts.profiles}) paused=${s.paused} needsHuman=${s.needsHuman}${s.nextEligibleAt ? ` nextEligibleAt=${s.nextEligibleAt}` : ''}${s.currentTask ? ` current=${s.currentTask.type}#${s.currentTask.id}` : ''}\n`,
  );
}, 60_000);
ticker.unref?.();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });
  clearInterval(ticker);
  try {
    await worker.stop();
    await session.close();
    db.close();
  } catch (e) {
    log.error('shutdown error', { error: errorMessage(e) });
  }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log.error('unhandled rejection', { error: errorMessage(e) }));
process.on('uncaughtException', (e) => log.error('uncaught exception', { error: errorMessage(e) }));
