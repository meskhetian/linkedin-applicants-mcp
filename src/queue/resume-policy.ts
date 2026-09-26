import type { Task } from '../types.js';

/** Playwright's and our own wording when the page, context or browser disappeared under a running task. */
export const BROWSER_LOST_RE = /browser has been closed|target closed|crashed|browser has disconnected|not connected|BrowserNotConnectedError/i;

/** The worker prefixes a failure with this marker when Chrome itself was gone afterwards (not just a tab). */
export const BROWSER_LOST_MARK = /^Browser lost:/i;

/**
 * After Chrome was lost during an application fetch, the retry runs without the resume download so the
 * contact details, qualifications and profile link are still captured. The resume can be fetched again later
 * with applicants_fetch_details (its default selection includes applicants whose resume is still missing).
 * The marker alone decides: some failure paths requeue without counting an attempt.
 */
export function shouldSkipResumeDownload(task: Pick<Task, 'attempts' | 'lastError'>, wanted: boolean): boolean {
  return wanted && BROWSER_LOST_MARK.test(task.lastError ?? '');
}
