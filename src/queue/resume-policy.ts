import type { Task } from '../types.js';

/** Errors that mean Chrome itself disappeared while a task ran (crash, killed, or closed by hand). */
export const BROWSER_LOST_RE = /browser has been closed|target (page, context or browser )?closed|target closed|crashed|browser has disconnected/i;

/**
 * After the browser was lost during an application fetch, the retry runs without the resume download so the
 * contact details, qualifications and profile link are still captured. The resume can be fetched again later
 * with applicants_fetch_details.
 */
export function shouldSkipResumeDownload(task: Pick<Task, 'attempts' | 'lastError'>, wanted: boolean): boolean {
  return wanted && task.attempts >= 1 && BROWSER_LOST_RE.test(task.lastError ?? '');
}
