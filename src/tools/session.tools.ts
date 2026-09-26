import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { guard, ok } from './result.js';

export function registerSessionTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    'browser_status',
    {
      title: 'Browser status',
      description:
        'Report whether the Chrome session is connected, whether LinkedIn is logged in, the current URL and any checkpoint (verification / login wall). Never launches a browser. Call this first, and whenever the queue reports needsHuman.',
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    guard(async () => ok({ ...(await deps.session.status()) })),
  );

  server.registerTool(
    'browser_open_login',
    {
      title: 'Open LinkedIn login in your Chrome',
      description:
        'Launches (or connects to) your own Google Chrome with the dedicated profile and opens LinkedIn so YOU can sign in manually in the visible window. Nothing is typed on your behalf. Waits up to timeoutSeconds for the login to complete, then returns the status. Use before the first sync and whenever browser_status shows loggedIn=false or a checkpoint. After solving a checkpoint call queue_resume.',
      inputSchema: {
        timeoutSeconds: z.number().int().min(10).max(900).default(180).describe('How long to wait for you to finish signing in'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
    },
    guard(async ({ timeoutSeconds }) => {
      const status = await deps.session.openLogin(timeoutSeconds * 1000);
      return ok({
        ...status,
        instruction: status.loggedIn
          ? 'Logged in. The session is stored in the Chrome profile directory; you will not need to sign in again unless LinkedIn logs you out.'
          : 'A Chrome window is open on LinkedIn. Sign in there (and complete any verification LinkedIn asks for). Then call browser_status, and queue_resume if the queue was paused.',
      });
    }),
  );

  server.registerTool(
    'browser_close',
    {
      title: 'Close the browser session',
      description:
        'Stops the background worker and closes the Chrome window this server launched (in cdp mode it only disconnects; your Chrome keeps running). Queued tasks stay in the database; queue_start relaunches when needed.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    guard(async () => {
      await deps.worker.stop();
      await deps.session.close();
      return ok({ closed: true, workerRunning: deps.worker.isRunning(), note: 'Call queue_start to resume processing; the browser is relaunched on demand.' });
    }),
  );
}
