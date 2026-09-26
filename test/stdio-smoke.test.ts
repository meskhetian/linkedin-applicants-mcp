import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Spawns the BUILT server (dist/index.js) over stdio exactly like Claude Desktop does and exercises
 * the tools that must work without a browser. Requires `npm run build` (the `pretest` script does it).
 */
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'index.js');
const EXPECTED_TOOLS = [
  'browser_status',
  'browser_open_login',
  'browser_close',
  'jobs_sync',
  'jobs_list',
  'applicants_sync',
  'applicants_fetch_details',
  'applicants_fetch_profiles',
  'applicants_list',
  'applicant_get',
  'resume_text',
  'applicants_export',
  'queue_status',
  'queue_start',
  'queue_pause',
  'queue_resume',
  'queue_cancel',
  'queue_retry_failed',
  'queue_tasks',
  'pacing_get',
  'pacing_set',
  'debug_snapshot',
  'debug_navigate',
  'debug_page_text',
  'debug_find',
  'debug_captures',
];

describe.skipIf(!fs.existsSync(DIST))('stdio server smoke', () => {
  let client: Client;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'li-mcp-smoke-'));
    client = new Client({ name: 'smoke', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST],
      env: { ...process.env, LINKEDIN_MCP_DATA_DIR: dataDir, LINKEDIN_MCP_AUTOSTART_WORKER: 'false', LINKEDIN_MCP_LOG_LEVEL: 'warn' },
      stderr: 'pipe',
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
  });

  it('lists every tool', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const n of EXPECTED_TOOLS) expect(names).toContain(n);
    for (const t of tools) expect(t.description && t.description.length > 20).toBe(true);
  });

  it('answers local-only tools without launching a browser', async () => {
    const status = (await client.callTool({ name: 'browser_status', arguments: {} })) as { structuredContent: { connected: boolean; loggedIn: boolean | null } };
    expect(status.structuredContent.connected).toBe(false);
    expect(status.structuredContent.loggedIn).toBeNull();

    const jobs = (await client.callTool({ name: 'jobs_list', arguments: {} })) as { structuredContent: { count: number } };
    expect(jobs.structuredContent.count).toBe(0);

    const q = (await client.callTool({ name: 'queue_status', arguments: {} })) as { structuredContent: { tasks: { pending: number }; worker: { running: boolean } } };
    expect(q.structuredContent.tasks.pending).toBe(0);
    expect(q.structuredContent.worker.running).toBe(false);

    const bad = (await client.callTool({ name: 'pacing_set', arguments: { workHoursStart: '19:00', workHoursEnd: '09:00' } })) as { isError?: boolean };
    expect(bad.isError).toBe(true);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toContain('review_applicants');
  });
});
