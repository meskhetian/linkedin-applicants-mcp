# Research notes (2026-09-25, auto-collected; verify before relying on any single claim)

## MCP TypeScript SDK (v1 vs v2)

### Summary

As of 2026-09-25 the MCP TypeScript SDK has TWO live lines. (1) The monolithic v1 package `@modelcontextprotocol/sdk` is at 1.30.1 (published 2026-09-23; Node >=18; zod peer `^3.25 || ^4.0`; imports `@modelcontextprotocol/sdk/server/mcp.js` + `.../server/stdio.js`; `registerTool` takes a RAW zod shape `{ city: z.string() }`; `server.tool()` is the older variadic form). It is in maintenance (bug/security fixes for >=6 months after the v2 launch of 2026-07-28). (2) The v2 line, "the stable release line implementing the 2026-07-28 spec", is split into packages: `@modelcontextprotocol/server` 2.1.0, `@modelcontextprotocol/client` 2.1.0, `@modelcontextprotocol/core` 2.1.0, `@modelcontextprotocol/node` 2.1.0 (all published 2026-09-23), plus express/hono/fastify adapters, `server-legacy`, and a `codemod`. v2 requires Node >=20 and zod `^4.2.0` (declared as a regular dependency, not a peer; zod 3.x is not supported; zod 4.0-4.1 silently drops `.describe()` descriptions; latest zod is 4.6.5). v2 is ESM-first but ships CJS too. For a NEW stdio server on Node 26 the answer is v2: `npm i @modelcontextprotocol/server zod`.

v2 high-level API (verified in packages/server/src/server/mcp.ts): `server.registerTool(name, { title?, description?, inputSchema?, outputSchema?, annotations?, icons?, scopeChallenge?, _meta? }, handler)` where `inputSchema`/`outputSchema` are full `z.object({...})` schemas (any Standard-Schema-with-JSON library works; the raw-shape form still compiles via a `@deprecated` overload that auto-wraps with `z.object()`). Import zod as `import * as z from 'zod/v4'`. Handler signature is `(args, ctx: ServerContext)` when an inputSchema is present, else `(ctx)`. Return `{ content: [{type:'text', text}], structuredContent }`; if `outputSchema` is declared and `structuredContent` is `undefined` the SDK throws a ProtocolError -32602 "Output validation error", and structuredContent is validated against the schema; validation is skipped on `isError` results. Return `{ content:[...], isError: true }` for model-recoverable errors; any Error thrown from a tool handler is converted to an `isError: true` result; argument validation failures also come back as `isError: true` without running the handler. `ctx.mcpReq` (from core-internal BaseContext) exposes `id`, `method`, `_meta` (`_meta?.progressToken`), `signal: AbortSignal`, `send(...)`, `notify(...)`, `requestState`, `inputResponses`; ServerContext adds `ctx.mcpReq.log(level, data, logger?)` (deprecated per SEP-2577, needs `capabilities: { logging: {} }`), `elicitInput`, `requestSampling`, and `ctx.http?`. `registerTool` returns a `RegisteredTool` handle with `enable()/disable()/update({...})/remove()` that auto-emit `notifications/tools/list_changed`; `server.sendToolListChanged()` exists for manual pushes; `McpServer` auto-advertises capabilities/listChanged. Resources: `server.registerResource(name, uriOrTemplate, { title?, description?, mimeType? }, cb)` with `new ResourceTemplate('x://{id}', { list: undefined })` and `{ contents: [{ uri: uri.href, mimeType, text|blob }] }`. Prompts: `server.registerPrompt(name, { title?, description?, argsSchema: z.object(...) }, cb)` returning `{ messages: [{ role, content }] }`; prompt validation failures are protocol errors (-32602), unlike tools.

Stdio: preferred entry is `serveStdio(factory, { legacy?: 'serve'|'reject', transport?, onerror? })` from `@modelcontextprotocol/server/stdio`, returning `{ close() }`. It serves both the new 2026-07-28 `server/discover` opening AND the legacy `initialize` handshake by default, so Claude Desktop/Claude Code (2025-11-25 clients) connect unchanged. `new StdioServerTransport()` + `server.connect()` still works but is 2025-era only. Important: serveStdio may build a throw-away probe instance from the factory, so keep job state at module level, not inside the factory. Logging: stdout is the JSON-RPC channel; one `console.log` and the host drops the connection; use `console.error` (Claude Desktop writes it to `~/Library/Logs/Claude/mcp-server-<name>.log`). MCP-level logging (`sendLoggingMessage`/`ctx.mcpReq.log`) is formally deprecated in 2026-07-28 (spec says: log to stderr or OpenTelemetry).

Long-running work: there is no usable server-side Tasks API. The 2026-07-28 spec moved Tasks out of core into the `io.modelcontextprotocol/tasks` extension (SEP-2663); the v2 TS SDK removed experimental tasks; `@modelcontextprotocol/ext-tasks` 0.1.0 (2026-09-17) is client/requester side only (plus a 2025-11-25 receiver for sampling/elicitation), and Claude Code/Claude Desktop have only open feature requests for Tasks. Meanwhile Claude Desktop (consumer app) and the Claude Code desktop app cancel tool calls at ~60s (SDK DEFAULT_REQUEST_TIMEOUT_MSEC=60000; GitHub issues #22542, #63379 closed "not planned"), and progress notifications do not extend that timer. Claude Code CLI is far more lenient: wall-clock default ~28h (MCP_TOOL_TIMEOUT), idle timeout 30 min for stdio (progress notifications DO reset the idle window; CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT), and since v2.1.212 main-conversation MCP calls still running after 2 minutes are auto-moved to a background task. Therefore: every tool must return in well under 60s; `start_export` enqueues into an in-process worker backed by SQLite and returns a job id immediately; `get_job_status`/`list_jobs`/`cancel_job` poll; an optional `wait_for_job(jobId, maxWaitSeconds<=45)` long-polls and emits `notifications/progress` via `ctx.mcpReq.notify` when the client supplied a progressToken, checking `ctx.mcpReq.signal.aborted`. Progress/log notifications are only valid while the originating request is in flight; after the tool returns, the job can only be observed by polling. Claude Code truncates MCP results above 25,000 tokens by default (MAX_MCP_OUTPUT_TOKENS; per-tool `_meta['anthropic/maxResultSizeChars']` up to 500,000), so paginate applicant lists and write PDFs/profiles to disk, returning paths/counts.

Registration: Claude Desktop uses `~/Library/Application Support/Claude/claude_desktop_config.json` with `mcpServers.<name>.{command,args,env}` (use absolute paths to node and the built JS; restart the app). Claude Code: `claude mcp add --scope user --transport stdio <name> --env K=V -- node /abs/dist/index.js` (the `--` is required; put another flag between `--env` and the name), or `claude mcp add-json <name> '{"type":"stdio","command":"...","args":[...],"env":{...}}'`; project scope writes `.mcp.json` (supports `${VAR}`/`${VAR:-default}` and a per-server `"timeout"` ms field). Manage with `claude mcp list|get|remove` and `/mcp`.

Toolchain for Node 26 (26.10.0 current, released 2026-05-05, LTS 2026-10-28): native TypeScript type stripping is default and stable (the transform flag was removed in 26.0.0), so `node --watch src/index.ts` works in dev if you use `.ts` import specifiers and erasable-only syntax (no enums/namespaces/parameter properties); tsx 4.23.15 remains a fine alternative and is what the SDK tutorial uses. Build with `tsc` from TypeScript 7.0.2 (the Go-native compiler now ships as the `typescript` package; TS 6.0/7.0 defaults: strict on, `types: []`, `esModuleInterop` forced on, `baseUrl`/node10 resolution removed). Recommended tsconfig: `module: "nodenext"`, `target: "es2025"`, `lib: ["es2025","ESNext.Collection","ESNext.Temporal"]`, `types: ["node"]`, `rootDir/outDir`, `strict`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `rewriteRelativeImportExtensions`, `isolatedModules` (or `extends: "@tsconfig/node26"` 26.0.1). `node:sqlite` (`DatabaseSync`) is unflagged at Stability 1.2 "release candidate" in Node 26.10 and avoids native-addon ABI issues; better-sqlite3 13.0.3 (Node >=22) is the alternative. Test in-process with `InMemoryTransport.createLinkedPair()` + `Client` from `@modelcontextprotocol/client`, or interactively with `npx @modelcontextprotocol/inspector node dist/index.js` (inspector 2.8.0 needs Node >=22.19).

### Facts

- [high] @modelcontextprotocol/sdk (v1 line) latest is 1.30.1, published 2026-09-23; engines node >=18; peerDependencies zod "^3.25 || ^4.0" (required) and @cfworker/json-schema (optional); exports include ./server, ./client, ./experimental/tasks.  <https://registry.npmjs.org/@modelcontextprotocol/sdk/latest>
- [high] @modelcontextprotocol/server latest is 2.1.0, published 2026-09-23T15:45Z; engines node >=20; type: module; dependencies zod ^4.2.0 and @modelcontextprotocol/core 2.1.0; exports ".", "./stdio", "./_shims", "./validators/ajv", "./validators/cf-worker".  <https://registry.npmjs.org/@modelcontextprotocol/server/latest>
- [high] @modelcontextprotocol/client 2.1.0, @modelcontextprotocol/core 2.1.0, @modelcontextprotocol/node 2.1.0, @modelcontextprotocol/codemod 2.1.0, @modelcontextprotocol/server-legacy 2.1.0 were all published 2026-09-23; @modelcontextprotocol/express 2.0.1 and hono 2.0.1 same day; fastify 2.0.0 on 2026-07-27.  <https://github.com/modelcontextprotocol/typescript-sdk/releases>
- [high] v2 'is the stable release line implementing the 2026-07-28 spec'; it retires the monolithic @modelcontextprotocol/sdk in favor of @modelcontextprotocol/server, /client, /core plus thin adapters for Node, Express, Hono, Fastify. Stable release date was 2026-07-28; v1.x gets bug fixes and security updates for at least six months after.  <https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/>
- [high] v2 requires Node.js 20+ and zod >=4.2.0 (v1 supported ^3.25 || ^4.0). Projects pinning zod@3 cannot use v2 at runtime even if they typecheck. Zod 4.0–4.1 falls back to bundled conversion and drops descriptions; zod >=4.2 uses ~standard.jsonSchema and preserves descriptions. v2 is ESM-first but ships CommonJS alongside.  <https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html>
- [high] Migration codemod: `npx @modelcontextprotocol/codemod@latest v1-to-v2 .`; StdioServerTransport moved to subpath `@modelcontextprotocol/server/stdio`; SSEServerTransport and WebSocketClientTransport removed; McpError renamed ProtocolError (ProtocolErrorCode), local errors are SdkError/SdkHttpError; handler `extra` renamed `ctx` (extra.signal -> ctx.mcpReq.signal, extra.sendNotification -> ctx.mcpReq.notify, extra.sendRequest -> ctx.mcpReq.send, extra.requestId -> ctx.mcpReq.id).  <https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html>
- [high] v2 registerTool exact config type (mcp.ts): `{ title?: string; description?: string; inputSchema?: InputArgs; outputSchema?: OutputArgs; annotations?: ToolAnnotations; icons?: Icon[]; scopeChallenge?: ScopeChallengeHandler; _meta?: Record<string, unknown> }` where schemas are StandardSchemaWithJSON (e.g. z.object). A second overload marked `@deprecated Wrap with z.object({...}) instead` accepts raw ZodRawShape and auto-wraps it.  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/src/server/mcp.ts>
- [high] v2 tool handler type: `ToolCallback<Args>` = (args, ctx: ServerContext) => CallToolResult | InputRequiredResult | Promise<...>; when inputSchema is undefined the handler is called with just (ctx). Docs: 'Tools/prompts without input schema: the first parameter is now ctx (context), not extra'.  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/src/server/mcp.ts>
- [high] RegisteredTool handle (returned by registerTool) has `enabled: boolean`, `enable(): void`, `disable(): void`, `update({ name?, title?, description?, paramsSchema?, outputSchema?, annotations?, icons?, scopeChallenge?, _meta?, callback?, enabled? })`, `remove(): void`. 'Registering, updating, disabling, enabling, or removing through a registration handle sends the matching list-changed for you.' McpServer also exposes sendToolListChanged(), sendResourceListChanged(), sendPromptListChanged(), connect(transport), close(), isConnected(), sendLoggingMessage().  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/notifications.md>
- [high] SDK output validation (mcp.ts): if a tool has an outputSchema and `result.structuredContent === undefined`, it throws ProtocolError(InvalidParams, 'Output validation error: Tool X has an output schema but no structured content was provided'); when present it is validated via validateStandardSchema and a failure throws ProtocolError InvalidParams. 'The SDK skips outputSchema validation on any isError result.'  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/errors.md>
- [high] Tool errors: return `isError: true` for recoverable failures the model should see; the SDK catches any exception thrown from a tool handler and converts it to `{ content: [{type:'text', text: message}], isError: true }`. Non-tool callbacks (resources/prompts) should throw ProtocolError; other exceptions surface as -32603. Arguments failing the schema come back as isError: true and the handler never runs.  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/errors.md>
- [high] ProtocolErrorCode values: -32700 ParseError, -32600 InvalidRequest, -32601 MethodNotFound, -32602 InvalidParams (also resource-not-found in 2026-07-28), -32603 InternalError, -32021 MissingRequiredClientCapability, -32022 UnsupportedProtocolVersion, -32042 UrlElicitationRequired.  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/errors.md>
- [high] Spec 2026-07-28 tools: 'For backwards compatibility, a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block.' If outputSchema is provided, servers MUST provide conforming structuredContent and clients SHOULD validate. structuredContent may be any JSON value (SEP-2106). Tools without parameters should use inputSchema `{ "type": "object", "additionalProperties": false }`. Tool names SHOULD be 1-128 chars of [A-Za-z0-9_.-].  <https://modelcontextprotocol.io/specification/2026-07-28/server/tools>
- [high] ToolAnnotations schema (core-internal buildSchemas.ts): `title?: string, readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean` (destructiveHint/idempotentHint meaningful only when readOnlyHint == false). Spec: clients MUST treat annotations as untrusted unless from trusted servers.  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/core-internal/src/wire/rev2025-11-25/buildSchemas.ts>
- [high] BaseContext.mcpReq (core-internal/src/shared/protocol.ts) fields: `id: RequestId`, `method: string`, `_meta?: RequestMeta`, `envelope?`, `inputResponses?`, `droppedInputResponseKeys?`, `requestState: RequestStateAccessor`, `signal: AbortSignal`, `send(request, options?)` (schema arg only for custom methods), `notify(notification): Promise<void>`; plus `ctx.sessionId?`. ServerContext adds `mcpReq.log(level, data, logger?)` (@deprecated SEP-2577), `mcpReq.elicitInput(...)` and `mcpReq.requestSampling(...)` (both deprecated / throw on 2026-07-28 connections), and `ctx.http?.{req, closeSSE, closeStandaloneSSE}`.  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/core-internal/src/shared/protocol.ts>
- [high] Progress notifications in v2: `const progressToken = ctx.mcpReq._meta?.progressToken; if (progressToken !== undefined) await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress, total, message } })`. 'progress must increase on every notification for the same token; total and message are optional.' Cancellation is observed via `ctx.mcpReq.signal` (AbortSignal); forward it to fetch/Playwright calls.  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/logging-progress-cancellation.md>
- [high] MCP logging: `await ctx.mcpReq.log('info', data)` requires the server to be constructed with `{ capabilities: { logging: {} } }`; docs state 'Log to stderr (stdio servers) or use OpenTelemetry instead. MCP logging is deprecated as of protocol version 2026-07-28 (SEP-2577).' The official streaming example instead sends `ctx.mcpReq.notify({ method: 'notifications/message', params: { level: 'info', logger, data } })` so the log rides the same request stream as progress.  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/streaming/server.ts>
- [high] stdio: 'stdout is the JSON-RPC channel: the host parses every line of it as a protocol message'; use console.error for logging. Troubleshooting: 'SyntaxError: Unexpected token ... is not valid JSON' is caused by any console.log (yours or a dependency's) on stdout. Real-host guide: 'One console.log and the host drops the connection, log with console.error.'  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md>
- [high] serveStdio signature (serveStdio.ts): `serveStdio(factory: McpServerFactory, options: { legacy?: 'serve' | 'reject'; transport?: Transport; onerror?: (error: Error) => void } = {}): StdioServerHandle` where handle has `close(): Promise<void>`. legacy defaults to 'serve' (a 2025-era `initialize` opening is served by a pinned instance from the same factory). The entry may create and discard an optimistic probe instance, so the factory is called more than once.  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/src/server/serveStdio.ts>
- [high] Direct `server.connect(new StdioServerTransport())` continues to work but serves only the 2025-era protocol; to support 2026-07-28 on stdio use `serveStdio(() => buildServer())`. `getClientCapabilities()` returns undefined on modern connections. 'Claude Desktop and other 2025 clients connect normally to upgraded servers.' StdioServerTransport constructor: `(stdin = process.stdin, stdout = process.stdout, { maxBufferSize? })` default 10 MB.  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md>
- [high] Official first-server tutorial (v2): `npm init -y && npm pkg set type=module && npm install @modelcontextprotocol/server zod tsx`; imports `McpServer` from '@modelcontextprotocol/server', `serveStdio` from '@modelcontextprotocol/server/stdio', `import * as z from 'zod/v4'`; runs with `npx tsx src/index.ts`; tests with `npx @modelcontextprotocol/inspector npx tsx src/index.ts`.  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/first-server.md>
- [high] Resources v2: `server.registerResource(name, uriOrTemplate: string | ResourceTemplate, config: ResourceMetadata & { cacheHint?, scopeChallenge? }, readCallback)`; `new ResourceTemplate('users://{userId}/profile', { list: undefined | async () => ({ resources: [...] }) })`; read callback returns `{ contents: [{ uri: uri.href, mimeType?, text | blob }] }`. Migration note: registerResource now requires the metadata argument.  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/resources.md>
- [high] Prompts v2: `server.registerPrompt(name, { title?, description?, argsSchema?: z.object(...), icons?, scopeChallenge?, _meta? }, cb)`; cb returns `{ messages: [{ role: 'user'|'assistant', content: { type: 'text', text } }] }`; argument completion via `completable(z.string(), cb).optional()`; failed prompt arg validation rejects prompts/get with -32602 (unlike tools which return isError).  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/prompts.md>
- [high] Low-level `Server` (import { Server } from '@modelcontextprotocol/server') requires explicit capabilities and `setRequestHandler('tools/list' | 'tools/call', handler)` with method strings (schemas dropped for spec methods); it never infers capabilities and unhandled exceptions become protocol errors, not isError results. ServerOptions = ProtocolOptions & { capabilities?, instructions?, ... }.  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/advanced/low-level-server.md>
- [high] 2026-07-28 spec changelog: removes initialize handshake and sessions (stateless, per-request _meta), adds server/discover, replaces GET/subscribe with subscriptions/listen, removes ping/logging/setLevel, moves experimental Tasks into extension io.modelcontextprotocol/tasks (SEP-2663: tasks/get polling + tasks/update, no tasks/result or tasks/list), adds Multi Round-Trip Requests (InputRequiredResult), requires resultType on results, deprecates Roots/Sampling/Logging (SEP-2577: 'log to stderr (stdio) or use OpenTelemetry'), and says servers SHOULD return tools in deterministic order.  <https://modelcontextprotocol.io/specification/2026-07-28/changelog>
- [high] Tasks in the TS SDK: v1 @modelcontextprotocol/sdk has `./experimental/tasks` (pre-ratification 2025-11-25 shape); 'v2 removed experimental tasks per SEP-2663'. @modelcontextprotocol/ext-tasks 0.1.0 (published 2026-09-17, peer @modelcontextprotocol/client ^2.0.0) provides requester (client) APIs and a 2025-11-25 receiver only for sampling/elicitation, it has no API for a @modelcontextprotocol/server tool to return a task handle.  <https://github.com/modelcontextprotocol/ext-tasks/blob/main/typescript/index.md>
- [medium] Claude Code and Claude Desktop do not implement MCP Tasks client support; there are open feature requests (anthropics/claude-code #52137, #76571).  <https://github.com/anthropics/claude-code/issues/52137>
- [medium] Claude Desktop (consumer app) times out MCP tool calls at ~60 seconds (SDK DEFAULT_REQUEST_TIMEOUT_MSEC = 60000), calls >60s fail with 'No result received from client-side tool execution', and there is no supported timeout config; issue #22542 (opened 2026-02-02) closed as not planned; earlier #5221 closed 'external'.  <https://github.com/anthropics/claude-code/issues/22542>
- [medium] The Claude Code DESKTOP app cancels stdio MCP tool calls at ~60s with 'MCP error -32001: Request timed out' and ignores MCP_TOOL_TIMEOUT / per-server timeout, while the Claude Code CLI honors them; progress notifications do not reset that timeout (absolute, not sliding). Issue #63379 opened 2026-05-28, closed as not planned.  <https://github.com/anthropics/claude-code/issues/63379>
- [high] Claude Code CLI timeouts: 'A tool call to an MCP server that sends no response and no progress notification for the idle window aborts with an error', idle window defaults to 30 minutes for stdio (5 min for HTTP/SSE); set CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT (ms, 0 disables). Per-server `timeout` (>=1000 ms) in .mcp.json is a hard wall-clock limit that 'progress notifications from the server don't extend'; values below 1000 fall through to MCP_TOOL_TIMEOUT 'or to its default of about 28 hours when that variable is unset'. MCP_TIMEOUT controls server startup timeout.  <https://code.claude.com/docs/en/mcp>
- [high] Claude Code auto-backgrounding: 'An MCP tool call in the main conversation that is still running after two minutes moves to a background task instead of blocking the session. Claude receives the task ID immediately and keeps working, and the result arrives as a task notification when the call settles.' Requires v2.1.212+; threshold via CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS (0 disables); not applied to subagent calls.  <https://code.claude.com/docs/en/mcp>
- [high] Claude Code MCP output limits: warning at 10,000 tokens, default max 25,000 tokens (MAX_MCP_OUTPUT_TOKENS env), oversized results are saved to ~/.claude/projects/tool-results/; per-tool override via `_meta: { 'anthropic/maxResultSizeChars': N }` in the tools/list entry, hard ceiling 500,000 chars.  <https://code.claude.com/docs/en/mcp>
- [high] Claude Code registration: `claude mcp add [options] <name> -- <command> [args...]` with `--transport stdio`, `--scope local|project|user` (default local), `--env KEY=value` (repeatable; put another flag between --env and the name); `--` is required. `claude mcp add-json <name> '{"type":"stdio","command":"...","args":[...],"env":{...}}'`; `claude mcp list|get|remove`; `/mcp` in-session. User scope stored in ~/.claude.json; project scope writes .mcp.json with `${VAR}` / `${VAR:-default}` expansion and optional per-server `timeout`; CLAUDE_PROJECT_DIR is set in the spawned server env.  <https://code.claude.com/docs/en/mcp>
- [high] Claude Code MCP client runtimes: v1 runtime is the default in most sessions; the v2 runtime (built on TS SDK 2.0, supports 2026-07-28) is enabled with `MCP_SDK_GENERATION=v2` and is default on v2.1.274+ only in sessions that don't fetch feature flags; `MCP_PROTOCOL_NEGOTIATION=auto` makes it probe stdio servers for the newer revision. Stdio servers are local processes and are not auto-reconnected.  <https://code.claude.com/docs/en/mcp>
- [high] Claude Desktop config file on macOS: `~/Library/Application Support/Claude/claude_desktop_config.json` (Settings > Developer > Edit Config), structure `{ "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...} } } }`; paths must be absolute; fully quit and restart the app; logs at ~/Library/Logs/Claude/mcp.log and mcp-server-<NAME>.log (the latter is the server's stderr); `tail -n 20 -f ~/Library/Logs/Claude/mcp*.log`.  <https://modelcontextprotocol.io/docs/develop/connect-local-servers>
- [high] Node.js 26 started 2026-05-05 (LTS on 2026-10-28, maintenance 2027-10-20, EOL 2029-04-30); latest is v26.10.0 (2026-09-21, npm 11.19.1). Node 24 'Krypton' is the current LTS (v24.21.0, 2026-09-07).  <https://raw.githubusercontent.com/nodejs/Release/main/schedule.json>
- [high] Node 26 runs .ts files natively via type stripping (stable since v25.2.0/v24.12.0; default); `--experimental-transform-types` was removed in v26.0.0, so enum, namespace with runtime code, parameter properties, import aliases and decorators need a real build step; import specifiers must include the file extension (`import './file.ts'`). Node recommends TypeScript 5.8+ with tsconfig `{ "noEmit": true, "target": "esnext", "module": "nodenext", "rewriteRelativeImportExtensions": true, "erasableSyntaxOnly": true, "verbatimModuleSyntax": true }`.  <https://nodejs.org/api/typescript.html>
- [high] node:sqlite in Node v26.10.0 is 'Stability: 1.2 - Release candidate', unflagged (`import { DatabaseSync } from 'node:sqlite'`), with prepare/run/get/all, exec, options such as enableForeignKeyConstraints/timeout/readBigInts; PRAGMAs (e.g. journal_mode=WAL) via exec().  <https://nodejs.org/api/sqlite.html>
- [high] TypeScript latest is 7.0.2 (published 2026-07-08); the `typescript` npm package now ships the native Go-based `tsc` (bin/tsc); `typescript@next` replaces @typescript/native-preview for nightlies; TS 7.0 has no programmatic API (7.1 will), only relevant to tooling that imports the TS API, not to running `tsc`. Defaults inherited from 6.0: strict true, module esnext, target es2025, types [], noUncheckedSideEffectImports true; removed: target es5, moduleResolution node10/classic, module amd/umd/system, baseUrl, outFile, esModuleInterop=false.  <https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/>
- [high] TypeScript 6.0 released 2026-03-23 (last JS-based version); deprecates moduleResolution node (node10), 'migrate to --moduleResolution nodenext if they plan on targeting Node.js directly'; nodenext remains the recommended Node setting.  <https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/>
- [high] @tsconfig/node26 26.0.1 base: `{ "lib": ["es2025", "ESNext.Collection", "ESNext.Temporal"], "module": "nodenext", "target": "es2025", "types": ["node"], "esModuleInterop": true, "skipLibCheck": true }`.  <https://unpkg.com/@tsconfig/node26/tsconfig.json>
- [high] Other current versions (npm registry, 2026-09-25): zod 4.6.5 (2026-09-13; exports ./v4, ./v3, ./mini), tsx 4.23.15 (2026-09-20, node >=18, esbuild ~0.28), @types/node 26.6.2, @modelcontextprotocol/inspector 2.8.0 (node >=22.19.0), better-sqlite3 13.0.3 (node >=22), playwright 1.63.0 (node >=20).  <https://registry.npmjs.org/zod/latest>
- [high] Troubleshooting: duplicate zod copies cause 'TS2589: Type instantiation is excessively deep'; fix with `npm ls zod` and `"overrides": { "zod": "^4.2.0" }`. 'SdkError: METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION' means calling a method the negotiated era lacks.  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/troubleshooting.md>
- [high] In-process testing: `const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport); const client = new Client({ name, version }); await client.connect(clientTransport); await client.callTool({ name, arguments })` with imports from '@modelcontextprotocol/client'; spawn-based testing uses `new StdioClientTransport({ command: 'node', args: ['dist/server.js'] })` from '@modelcontextprotocol/client/stdio'.  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/testing.md>
- [high] v1 (1.x) API for reference: `npm install @modelcontextprotocol/sdk zod`; 'The SDK internally imports from zod/v4, but maintains backwards compatibility with projects using Zod v3.25 or later'; `server.registerTool('calculate-bmi', { title, description, inputSchema: { weightKg: z.number(), heightM: z.number() }, outputSchema: { bmi: z.number() } }, async ({ weightKg, heightM }) => ({ content: [...], structuredContent: output }))`; list-changed is auto-sent on registerTool/remove/enable/disable/update or manually via server.sendToolListChanged().  <https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md>
- [high] Official v2 examples relevant to this build: `examples/tools` (registerTool with z.object input/output, structuredContent, annotations, icons), `examples/streaming` (progress + logging + cancellation over stdio via serveStdio), `examples/todos-server` (reference server with CRUD tools, subscriptions, progress; stdio and HTTP), `examples/server-quickstart` (tsconfig with rootDir ./src, outDir ./build, types ["node"]; scripts build: tsc).  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/README.md>

### Recommendations

- Use the v2 packages for this new server: `npm i @modelcontextprotocol/server@^2.1.0 zod@^4.6.5` (+ `@modelcontextprotocol/client` as a devDependency for in-process tests). Do not install `@modelcontextprotocol/sdk` (v1) unless you have a hard reason; if you must, remember its registerTool takes a raw zod shape and its import paths are `@modelcontextprotocol/sdk/server/mcp.js` / `server/stdio.js`.
- Pin a single zod >=4.2 (use `"overrides": {"zod": "^4.6.5"}` in package.json) and import `import * as z from 'zod/v4'` everywhere; a second zod copy causes TS2589 and zod 4.0/4.1 silently drops `.describe()` text from advertised schemas.
- Author `inputSchema`/`outputSchema` as full `z.object({...})` with `.describe()` on every field (that text is what the model sees); avoid the deprecated raw-shape overload so the codemod/next major does not break you.
- Always return BOTH `content: [{type:'text', text: JSON.stringify(structuredContent)}]` and `structuredContent` when an outputSchema is declared (spec SHOULD, and the SDK throws -32602 if structuredContent is undefined). For failures return `{ content:[{type:'text', text}], isError: true }` with actionable text; do not throw ProtocolError from tool handlers.
- Never write to stdout. Use `console.error` or a pino/winston logger bound to fd 2 (stderr). Also silence noisy dependencies that might console.log (Playwright debug output goes to stderr by default, but verify). Do not rely on MCP logging (`ctx.mcpReq.log` / sendLoggingMessage), it is deprecated by SEP-2577 and Claude Desktop already surfaces stderr in ~/Library/Logs/Claude/mcp-server-<name>.log.
- Serve stdio with `serveStdio(createServer, { onerror })` from `@modelcontextprotocol/server/stdio` (dual-era, works with today's Claude Desktop/Code and tomorrow's 2026-07-28 hosts). Keep the factory cheap and side-effect free (serveStdio may build and discard a probe instance) and hold all mutable state (job queue, SQLite handle, Playwright browser) at module scope, opened lazily on first tool call. Close the handle and the browser on SIGINT/SIGTERM and on `server.server.onclose`.
- Design every tool to return in < 30 s: Claude Desktop and the Claude Code desktop app hard-cancel at ~60 s and ignore progress notifications. Use the job-handle pattern the 2026-07-28 spec itself recommends for cross-call state: `start_export(jobPostingId, options) -> {jobId}`, `get_job_status(jobId)`, `list_jobs()`, `cancel_job(jobId)`, `get_job_results(jobId, cursor, limit)`. Job ids must be opaque (randomUUID) and documented lifetime should be in the tool description.
- Run the actual scraping in an in-process single-worker queue (one Playwright page at a time, human-like randomized delays) that persists every step (job, applicant, status, file paths, last cursor) to SQLite so it is resumable after a crash or host restart; Claude Code does not auto-restart stdio servers, and Claude Desktop restarts them only on app restart. Store data under `~/Library/Application Support/<app>/` (path via env var), not in the repo.
- Optionally add `wait_for_job(jobId, maxWaitSeconds)` capped at 45 s that emits `notifications/progress` via `ctx.mcpReq.notify` when `ctx.mcpReq._meta?.progressToken` is present, checks `ctx.mcpReq.signal.aborted`, and returns the latest status. This gives a good experience in Claude Code (progress resets its 30-min idle window; calls >2 min are auto-backgrounded) while staying under Claude Desktop's 60 s.
- Keep tool results small: paginate applicant lists (cursor + limit), write resumes/PDF/profile JSON to disk and return paths + counts, and set `_meta: { 'anthropic/maxResultSizeChars': 200000 }` on the few tools that legitimately return large text (Claude Code default cap is 25k tokens). Return tools from a fixed, deterministic registration order (spec SHOULD; improves prompt caching).
- Mark annotations honestly: read-only status/list tools `{ readOnlyHint: true, idempotentHint: true }`; `start_export` `{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }`; `cancel_job` idempotent. Add a short `instructions` string in `new McpServer(info, { instructions })` describing the start->poll workflow.
- Toolchain for Node 26: `"type": "module"`, TypeScript 7.0.2 (`tsc` for build), tsconfig `module: nodenext`, `target: es2025`, `lib: [es2025, ESNext.Collection, ESNext.Temporal]`, `types: ["node"]`, `strict`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `rewriteRelativeImportExtensions`, `rootDir: src`, `outDir: dist` (or `extends: "@tsconfig/node26"`). Write local imports with `.ts` extensions so `node --watch src/index.ts` works natively in dev (no enums/namespaces/parameter properties); keep `tsx watch src/index.ts` as a fallback. Ship `dist/index.js` for hosts and point Claude Desktop at an absolute `node` path (GUI apps do not inherit nvm/fnm PATH).
- Prefer `node:sqlite` (`DatabaseSync`, WAL mode via `db.exec('PRAGMA journal_mode = WAL')`) over better-sqlite3 to avoid native-addon ABI churn on Node 26; it is unflagged at Stability 1.2 in v26.10. If you need async or an ORM, verify better-sqlite3 13.x prebuilds exist for Node 26's ABI first.
- Register in Claude Code with `claude mcp add --scope user --transport stdio linkedin-applicants --env LINKEDIN_MCP_DATA_DIR="$HOME/.linkedin-applicants-mcp" -- node /ABSOLUTE/PATH/TO/linkedin-applicants-mcp/dist/index.js` (or `claude mcp add-json` with a `"timeout"` field), and in Claude Desktop via claude_desktop_config.json; verify with `claude mcp list`, `/mcp`, and `npx @modelcontextprotocol/inspector node dist/index.js`.
- Write an in-process test harness with `InMemoryTransport.createLinkedPair()` + `Client` (from `@modelcontextprotocol/client`) that stubs the Playwright layer, and one spawn-based smoke test with `StdioClientTransport` against `dist/index.js` to catch stdout pollution.
- Do not build on MCP Tasks yet: the core spec moved them to the io.modelcontextprotocol/tasks extension, the v2 SDK has no server-side implementation, and Claude Desktop/Code do not implement the client side. Revisit if `@modelcontextprotocol/ext-tasks` gains a server API and Anthropic hosts ship Tasks support.

### Open questions

- Does the current consumer Claude Desktop build still cancel tool calls at ~60 s and ignore progress notifications? Evidence is from GitHub issues (#22542, #5221) not official docs; a quick empirical test with a `sleep` tool is advisable before finalizing `wait_for_job`'s cap.
- Has Claude Desktop adopted the 2026-07-28 revision / v2 runtime? Not documented; irrelevant for correctness because serveStdio serves the legacy `initialize` opening by default, but it affects whether list_changed notifications and `resultType` show up.
- Will @modelcontextprotocol/ext-tasks add a server-side (receiver-for-tools) API, and will Claude Code/Desktop implement Tasks (issues #52137, #76571)? Until then the job-id polling pattern is required.
- @modelcontextprotocol/server 2.1.0 is two days old (2026-09-23), check its changelog/issues for regressions and consider pinning an exact version in package.json for reproducibility.
- Does better-sqlite3 13.0.3 publish prebuilt binaries for Node 26's ABI, or would it compile from source on the user's Mac? If unsure, use node:sqlite.
- Exact interaction of Claude Code's auto-backgrounding (>2 min) with a long-polling `wait_for_job` tool: does the backgrounded call keep receiving progress and count against the idle timeout? Docs describe the mechanism but not this combination.
- Whether `ctx.mcpReq.log` silently no-ops when `capabilities.logging` is not declared (docs say the capability must be declared; sendLoggingMessage checks `this._capabilities.logging`). Verify at runtime if MCP logging is used at all.
- TypeScript 7.0 has no programmatic API; if any dev tooling (vitest with typecheck, ts-morph, eslint typed rules) needs the TS API, it must use `@typescript/typescript6` or TypeScript 6.x instead.

### Snippets

#### package.json for the MCP server (Node 26, ESM, v2 SDK) with exact current versions

```json
{
  "name": "linkedin-applicants-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.19" },
  "bin": { "linkedin-applicants-mcp": "./dist/index.js" },
  "scripts": {
    "dev": "node --watch src/index.ts",
    "dev:tsx": "tsx watch src/index.ts",
    "typecheck": "tsc --noEmit",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "inspect": "npx @modelcontextprotocol/inspector node dist/index.js",
    "test": "node --test --experimental-strip-types test/**/*.test.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^2.1.0",
    "zod": "^4.6.5",
    "playwright": "^1.63.0"
  },
  "devDependencies": {
    "@modelcontextprotocol/client": "^2.1.0",
    "@types/node": "^26.6.2",
    "tsx": "^4.23.15",
    "typescript": "^7.0.2"
  },
  "overrides": { "zod": "^4.6.5" }
}
```

#### tsconfig.json for Node 26 + TypeScript 7 (NodeNext ESM, erasable-only so `node src/index.ts` also runs natively)

```json
{
  "compilerOptions": {
    "target": "es2025",
    "lib": ["es2025", "ESNext.Collection", "ESNext.Temporal"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "rewriteRelativeImportExtensions": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "declaration": false
  },
  "include": ["src"]
}
// Alternative: { "extends": "@tsconfig/node26", "compilerOptions": { "rootDir": "src", "outDir": "dist", "strict": true, "verbatimModuleSyntax": true, "erasableSyntaxOnly": true, "rewriteRelativeImportExtensions": true }, "include": ["src"] }
// NOTE: with rewriteRelativeImportExtensions, write local imports as `import { x } from './jobs.ts'` so both `node src/index.ts` and the compiled dist/*.js work.
```

#### Minimal complete stdio MCP server (src/index.ts) with two tools: start_export (returns a job id immediately, background worker) and get_job_status (poll), v2 API, structuredContent + text, isError, stderr logging, graceful shutdown

```typescript
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

// ---- module-level state: survives serveStdio's probe/pinned factory calls ----
type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
interface Job {
  id: string;
  jobPostingId: string;
  status: JobStatus;
  processed: number;
  total?: number;
  error?: string;
  startedAt: string;
  updatedAt: string;
}
const jobs = new Map<string, Job>(); // replace with a SQLite-backed repository (node:sqlite DatabaseSync)
const log = (...a: unknown[]) => console.error('[linkedin-applicants]', ...a); // NEVER console.log: stdout is JSON-RPC

async function runExport(job: Job, signal: AbortSignal): Promise<void> {
  job.status = 'running';
  job.total = 25; // placeholder: real impl paginates the hiring dashboard with Playwright, human-like pacing
  for (let i = 0; i < job.total; i++) {
    if (signal.aborted) { job.status = 'cancelled'; return; }
    await new Promise(r => setTimeout(r, 400 + Math.random() * 800)); // human-like jitter
    job.processed = i + 1;
    job.updatedAt = new Date().toISOString();
  }
  job.status = 'done';
}
const controllers = new Map<string, AbortController>();

const JobStatusSchema = z.object({
  jobId: z.string(),
  status: z.enum(['queued', 'running', 'done', 'failed', 'cancelled']),
  processed: z.number().int(),
  total: z.number().int().optional(),
  error: z.string().optional(),
  updatedAt: z.string()
});
const toStatus = (j: Job) => ({ jobId: j.id, status: j.status, processed: j.processed, total: j.total, error: j.error, updatedAt: j.updatedAt });

function createServer(): McpServer {
  const server = new McpServer(
    { name: 'linkedin-applicants', version: '0.1.0' },
    {
      instructions:
        'Exports are long-running. Call start_export to enqueue a job (returns immediately with a jobId), then poll get_job_status until status is done or failed. Results are written to disk; tools return paths and counts, never full dumps.'
    }
  );

  server.registerTool(
    'start_export',
    {
      title: 'Start applicant export',
      description:
        'Queue a background export of all applicants for one LinkedIn job posting (list, application details, resume PDFs, full profiles). Returns a jobId immediately; poll get_job_status. Jobs persist across restarts.',
      inputSchema: z.object({
        jobPostingId: z.string().min(1).describe('LinkedIn job posting id, e.g. <jobId>'),
        includeResumes: z.boolean().default(true).describe('Download resume PDFs'),
        includeFullProfiles: z.boolean().default(true).describe('Also crawl each applicant public profile')
      }),
      outputSchema: JobStatusSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async ({ jobPostingId, includeResumes, includeFullProfiles }) => {
      const now = new Date().toISOString();
      const job: Job = { id: randomUUID(), jobPostingId, status: 'queued', processed: 0, startedAt: now, updatedAt: now };
      jobs.set(job.id, job);
      const ac = new AbortController();
      controllers.set(job.id, ac);
      log('queued', job.id, { jobPostingId, includeResumes, includeFullProfiles });
      // fire-and-forget: the tool returns in milliseconds (Claude Desktop cancels calls at ~60s)
      void runExport(job, ac.signal).catch(err => {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
        job.updatedAt = new Date().toISOString();
        log('job failed', job.id, job.error);
      });
      const structuredContent = toStatus(job);
      return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
    }
  );

  server.registerTool(
    'get_job_status',
    {
      title: 'Get export job status',
      description: 'Return the current status and progress counters of an export job started with start_export.',
      inputSchema: z.object({ jobId: z.string().uuid().describe('jobId returned by start_export') }),
      outputSchema: JobStatusSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ jobId }) => {
      const job = jobs.get(jobId);
      if (!job) {
        // model-recoverable error: isError result, not a thrown ProtocolError
        return { content: [{ type: 'text', text: `Unknown jobId ${jobId}. Call start_export first or list_jobs.` }], isError: true };
      }
      const structuredContent = toStatus(job);
      return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
    }
  );

  return server;
}

const handle = serveStdio(createServer, { onerror: err => log('transport error', err) });
log('serving over stdio');
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const ac of controllers.values()) ac.abort(`shutdown: ${sig}`);
    void handle.close().finally(() => process.exit(0));
  });
}
```

#### Optional long-poll tool showing progress notifications + cancellation (ctx.mcpReq), keeps under Claude Desktop's ~60 s cap while giving Claude Code live progress

```typescript
server.registerTool(
  'wait_for_job',
  {
    title: 'Wait for export job',
    description: 'Block up to maxWaitSeconds (<= 45) for a job to progress or finish, streaming progress notifications. Returns the latest status.',
    inputSchema: z.object({
      jobId: z.string().uuid(),
      maxWaitSeconds: z.number().int().min(1).max(45).default(30)
    }),
    outputSchema: JobStatusSchema,
    annotations: { readOnlyHint: true, idempotentHint: true }
  },
  async ({ jobId, maxWaitSeconds }, ctx) => {
    const job = jobs.get(jobId);
    if (!job) return { content: [{ type: 'text', text: `Unknown jobId ${jobId}` }], isError: true };
    const progressToken = ctx.mcpReq._meta?.progressToken; // only present if the client asked for progress
    const deadline = Date.now() + maxWaitSeconds * 1000;
    let lastSent = -1;
    while (Date.now() < deadline && !ctx.mcpReq.signal.aborted && (job.status === 'queued' || job.status === 'running')) {
      if (progressToken !== undefined && job.processed !== lastSent) {
        lastSent = job.processed; // progress MUST increase per token
        await ctx.mcpReq.notify({
          method: 'notifications/progress',
          params: { progressToken, progress: job.processed, total: job.total, message: `${job.processed}/${job.total ?? '?'} applicants` }
        });
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    const structuredContent = toStatus(job);
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
  }
);
```

#### Dynamic tools, list-changed notifications, resources and prompts in v2 (registration handles auto-emit notifications)

```typescript
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

// Dynamic tool: keep the handle, mutate later -> notifications/tools/list_changed is sent for you
const cancelTool = server.registerTool('cancel_job', { description: 'Cancel a running export job', inputSchema: z.object({ jobId: z.string().uuid() }), annotations: { idempotentHint: true } },
  async ({ jobId }) => { controllers.get(jobId)?.abort('cancelled by user'); return { content: [{ type: 'text', text: `cancel requested for ${jobId}` }] }; });
cancelTool.disable();                 // hide until a job exists
cancelTool.enable();                  // show again
cancelTool.update({ description: 'Cancel a queued or running export job' });
// cancelTool.remove();
server.sendToolListChanged();         // manual push (rarely needed)

// Resource: one JSON document per job (read-only data the host can attach as context)
server.registerResource(
  'job-report',
  new ResourceTemplate('linkedin-export://jobs/{jobId}/report', { list: async () => ({ resources: [...jobs.values()].map(j => ({ uri: `linkedin-export://jobs/${j.id}/report`, name: `Export ${j.id}` })) }) }),
  { title: 'Export job report', description: 'Summary JSON for one export job', mimeType: 'application/json' },
  async (uri, { jobId }) => {
    const job = jobs.get(String(jobId));
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(job ?? { error: 'not found' }) }] };
  }
);

// Prompt: canned screening prompt with a typed argument
server.registerPrompt(
  'screen_applicants',
  { title: 'Screen applicants', description: 'Rank exported applicants for a role', argsSchema: z.object({ jobId: z.string().uuid(), mustHave: z.string().describe('Comma-separated must-have skills') }) },
  async ({ jobId, mustHave }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Using get_job_results for job ${jobId}, rank applicants by fit for: ${mustHave}. Return a table.` } }]
  })
);
```

#### Claude Desktop registration (macOS): ~/Library/Application Support/Claude/claude_desktop_config.json, absolute paths, restart the app fully

```json
{
  "mcpServers": {
    "linkedin-applicants": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/linkedin-applicants-mcp/dist/index.js"],
      "env": {
        "LINKEDIN_MCP_DATA_DIR": "/Users/you/.linkedin-applicants-mcp",
        "LINKEDIN_MCP_LOG_LEVEL": "info"
      }
    }
  }
}
// Logs: tail -n 20 -f ~/Library/Logs/Claude/mcp*.log   (that package-applicants.log = your stderr)
```

#### Claude Code registration: CLI commands and the equivalent .mcp.json (project scope) with per-server timeout

```bash
# user scope (all projects); `--` is REQUIRED; keep a flag between --env and the name
claude mcp add --scope user --transport stdio linkedin-applicants \
  --env LINKEDIN_MCP_DATA_DIR="$HOME/.linkedin-applicants-mcp" \
  -- node /ABSOLUTE/PATH/TO/linkedin-applicants-mcp/dist/index.js

# or JSON form (lets you set a per-server wall-clock timeout in ms)
claude mcp add-json linkedin-applicants '{"type":"stdio","command":"node","args":["/ABSOLUTE/PATH/TO/linkedin-applicants-mcp/dist/index.js"],"env":{"LINKEDIN_MCP_DATA_DIR":"/Users/you/.linkedin-applicants-mcp"},"timeout":600000}'

# dev-mode variant (no build): claude mcp add linkedin-dev -- npx tsx /ABSOLUTE/PATH/TO/linkedin-applicants-mcp/src/index.ts
claude mcp list && claude mcp get linkedin-applicants   # then /mcp inside a session

# .mcp.json (project scope, --scope project) equivalent:
# {
#   "mcpServers": {
#     "linkedin-applicants": {
#       "type": "stdio",
#       "command": "node",
#       "args": ["${CLAUDE_PROJECT_DIR}/dist/index.js"],
#       "env": { "LINKEDIN_MCP_DATA_DIR": "${LINKEDIN_MCP_DATA_DIR:-$HOME/.linkedin-applicants-mcp}" },
#       "timeout": 600000
#     }
#   }
# }
# Useful env: MAX_MCP_OUTPUT_TOKENS=50000, CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0, MCP_SDK_GENERATION=v2, MCP_PROTOCOL_NEGOTIATION=auto
```

#### In-process test of the server with the v2 client (no child process), plus spawn-based smoke test

```typescript
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createServer } from '../src/server.ts';

// 1) in-process
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServer();
const client = new Client({ name: 'test-harness', version: '1.0.0' });
await server.connect(serverTransport);
await client.connect(clientTransport);
const started = await client.callTool({ name: 'start_export', arguments: { jobPostingId: '<jobId>' } });
console.error(started.structuredContent); // { jobId, status: 'queued', ... }

// 2) real stdio child (catches stdout pollution)
const stdioClient = new Client({ name: 'smoke', version: '1.0.0' });
await stdioClient.connect(new StdioClientTransport({ command: 'node', args: ['dist/index.js'] }));
console.error((await stdioClient.listTools()).tools.map(t => t.name));
```

#### SQLite job store with Node 26 built-in node:sqlite (no native addon), WAL mode for a long-running writer

```typescript
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.LINKEDIN_MCP_DATA_DIR ?? join(process.env.HOME!, '.linkedin-applicants-mcp');
mkdirSync(dir, { recursive: true });
export const db = new DatabaseSync(join(dir, 'applicants.sqlite'), { enableForeignKeyConstraints: true, timeout: 5000 });
db.exec(`PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, job_posting_id TEXT NOT NULL, status TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0, total INTEGER, cursor TEXT, error TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS applicants (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), name TEXT, profile_url TEXT, applied_at TEXT, resume_path TEXT, profile_json TEXT, status TEXT NOT NULL DEFAULT 'pending', updated_at TEXT NOT NULL);`);
const upsertJob = db.prepare(`INSERT INTO jobs (id, job_posting_id, status, processed, total, cursor, error, started_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET status=excluded.status, processed=excluded.processed, total=excluded.total, cursor=excluded.cursor, error=excluded.error, updated_at=excluded.updated_at`);
export const saveJob = (j: { id: string; jobPostingId: string; status: string; processed: number; total?: number; cursor?: string; error?: string; startedAt: string; updatedAt: string }) =>
  upsertJob.run(j.id, j.jobPostingId, j.status, j.processed, j.total ?? null, j.cursor ?? null, j.error ?? null, j.startedAt, j.updatedAt);
export const pendingJobs = () => db.prepare(`SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY started_at`).all(); // resume on startup
```

#### v1 fallback (only if you must stay on @modelcontextprotocol/sdk 1.30.x): imports and raw-shape registerTool

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod'; // v1 accepts zod ^3.25 || ^4.0

const server = new McpServer({ name: 'linkedin-applicants', version: '0.1.0' });
server.registerTool(
  'get_job_status',
  { title: 'Get export job status', description: '...', inputSchema: { jobId: z.string() }, outputSchema: { status: z.string(), processed: z.number() } }, // RAW shapes in v1
  async ({ jobId }) => {
    const out = { status: 'running', processed: 3 };
    return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
  }
);
await server.connect(new StdioServerTransport());
console.error('v1 server on stdio');
// Migrate later with: npx @modelcontextprotocol/codemod@latest v1-to-v2 .
```
