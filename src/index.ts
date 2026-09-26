#!/usr/bin/env node
/**
 * MCP stdio entrypoint. stdout is the JSON-RPC transport, so everything else goes to stderr.
 */
for (const m of ['log', 'info', 'debug', 'trace'] as const) {
  (console as unknown as Record<string, (...a: unknown[]) => void>)[m] = (...args: unknown[]) => console.error(...args);
}

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { bootstrap } from './bootstrap.js';
import { createServer } from './server.js';
import { errorMessage } from './errors.js';

const deps = bootstrap({ ownerKind: 'mcp' });
const { log, worker, session, db } = deps;
const server = createServer(deps);
const transport = new StdioServerTransport();

let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { reason });
  const timer = setTimeout(() => process.exit(0), 15_000);
  timer.unref?.();
  try {
    await worker.stop();
    await session.close();
    await server.close().catch(() => {});
    db.close();
  } catch (e) {
    log.error('shutdown error', { error: errorMessage(e) });
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.stdin.on('end', () => void shutdown('stdin end'));
process.stdin.on('close', () => void shutdown('stdin close'));
process.on('unhandledRejection', (e) => log.error('unhandled rejection', { error: errorMessage(e) }));
process.on('uncaughtException', (e) => log.error('uncaught exception', { error: errorMessage(e) }));
transport.onclose = () => void shutdown('transport closed');

await server.connect(transport);
log.info('mcp server ready', { dataDir: deps.cfg.dataDir, browserMode: deps.cfg.browserMode });
if (process.env.LINKEDIN_MCP_AUTOSTART_WORKER !== 'false') worker.start();
