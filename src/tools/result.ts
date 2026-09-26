import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { errorMessage } from '../errors.js';

/** Success result: JSON text for the model + structuredContent for clients that render it. */
export function ok(structured: Record<string, unknown>, text?: string): CallToolResult {
  return {
    content: [{ type: 'text', text: text ?? JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

export function fail(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: errorMessage(err) }] };
}

/** Wrap a handler so any thrown error becomes an isError result instead of a protocol failure. */
export function guard<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };
}

export function clip(text: string | undefined, maxChars: number): { text?: string; truncated: boolean; totalChars: number } {
  if (!text) return { text: undefined, truncated: false, totalChars: 0 };
  if (text.length <= maxChars) return { text, truncated: false, totalChars: text.length };
  return { text: `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`, truncated: true, totalChars: text.length };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
