import type { CheckpointInfo } from './types.js';

/** LinkedIn interrupted us with a login / verification / captcha page. Worker must pause for a human. */
export class CheckpointError extends Error {
  override readonly name = 'CheckpointError';
  constructor(public readonly info: CheckpointInfo) {
    super(`LinkedIn checkpoint (${info.kind}) at ${info.url}: ${info.message}`);
  }
}

export class NotLoggedInError extends Error {
  override readonly name = 'NotLoggedInError';
  constructor(msg = 'Not logged in to LinkedIn. Run the browser_open_login tool and sign in.') {
    super(msg);
  }
}

export class BrowserNotConnectedError extends Error {
  override readonly name = 'BrowserNotConnectedError';
  constructor(msg = 'Browser is not connected.') {
    super(msg);
  }
}

/** A required element was not found, LinkedIn markup probably changed. Includes which selectors were tried. */
export class SelectorNotFoundError extends Error {
  override readonly name = 'SelectorNotFoundError';
  constructor(
    public readonly what: string,
    public readonly tried: string[],
    public readonly url?: string,
  ) {
    super(`Could not find ${what} (tried ${tried.length} selectors)${url ? ` at ${url}` : ''}`);
  }
}

/** Soft rate limiting signal (e.g. HTTP 429 on a Voyager call, or an "you've reached the limit" banner). */
export class RateLimitedError extends Error {
  override readonly name = 'RateLimitedError';
  constructor(msg = 'LinkedIn rate limited this session.', public readonly retryAfterMs?: number) {
    super(msg);
  }
}

/** Thrown by the worker when scheduler says stop (outside work hours / caps). Not an error per se. */
export class DeferredError extends Error {
  override readonly name = 'DeferredError';
  constructor(public readonly resumeAt: Date, public readonly reason: string) {
    super(`Deferred until ${resumeAt.toISOString()}: ${reason}`);
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof CheckpointError) return false;
  if (err instanceof NotLoggedInError) return false;
  if (err instanceof DeferredError) return false;
  return true;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** The task was cancelled while it was running (queue_cancel); stop cleanly and leave it cancelled. */
export class TaskCancelledError extends Error {
  constructor(readonly taskId: number) {
    super(`Task ${taskId} was cancelled while running`);
    this.name = 'TaskCancelledError';
  }
}
