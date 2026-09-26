import fs from 'node:fs';
import path from 'node:path';
import type { LogLevel, Logger } from './types.js';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level: LogLevel;
  /** Directory for daily log files; omitted = stderr only */
  logsDir?: string;
  /** Extra sink, e.g. MCP server.sendLoggingMessage */
  sink?: (level: LogLevel, msg: string, data: Record<string, unknown>) => void;
}

/**
 * JSON-lines logger. Writes to stderr (never stdout, stdout is the MCP transport)
 * and to <logsDir>/linkedin-mcp-YYYY-MM-DD.log.
 */
export function createLogger(opts: LoggerOptions, bindings: Record<string, unknown> = {}): Logger {
  const threshold = LEVELS[opts.level] ?? LEVELS.info;
  let fileStream: fs.WriteStream | undefined;
  let fileDate = '';

  function fileFor(date: string): fs.WriteStream | undefined {
    if (!opts.logsDir) return undefined;
    if (fileStream && fileDate === date) return fileStream;
    try {
      fs.mkdirSync(opts.logsDir, { recursive: true });
      fileStream?.end();
      fileStream = fs.createWriteStream(path.join(opts.logsDir, `linkedin-mcp-${date}.log`), { flags: 'a' });
      fileDate = date;
      return fileStream;
    } catch {
      return undefined;
    }
  }

  function write(level: LogLevel, msg: string, data?: Record<string, unknown>) {
    if (LEVELS[level] < threshold) return;
    const now = new Date();
    const rec = { ts: now.toISOString(), level, msg, ...bindings, ...(data ?? {}) };
    const line = JSON.stringify(rec, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v));
    try {
      process.stderr.write(line + '\n');
    } catch {
      /* ignore */
    }
    fileFor(now.toISOString().slice(0, 10))?.write(line + '\n');
    try {
      opts.sink?.(level, msg, { ...bindings, ...(data ?? {}) });
    } catch {
      /* ignore */
    }
  }

  const logger: Logger = {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    child: (b) => createLogger(opts, { ...bindings, ...b }),
  };
  return logger;
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
