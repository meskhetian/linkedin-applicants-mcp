import { describe, expect, it } from 'vitest';
import { BROWSER_LOST_RE, shouldSkipResumeDownload } from '../src/queue/resume-policy.js';

describe('shouldSkipResumeDownload', () => {
  it('skips the resume only on a retry after the worker marked the browser as lost', () => {
    expect(shouldSkipResumeDownload({ attempts: 1, lastError: 'Browser lost: Error: download.saveAs: Target page, context or browser has been closed' }, true)).toBe(true);
    expect(shouldSkipResumeDownload({ attempts: 2, lastError: 'Browser lost: Error: page.goto: Target page, context or browser has been closed' }, true)).toBe(true);
  });

  it('never skips on the first attempt, when the resume was not wanted, after a closed tab, or after unrelated errors', () => {
    expect(shouldSkipResumeDownload({ attempts: 0, lastError: undefined }, true)).toBe(false);
    // Requeues that do not count an attempt still carry the marker.
    expect(shouldSkipResumeDownload({ attempts: 0, lastError: 'Browser lost: BrowserNotConnectedError: Chrome is not connected' }, true)).toBe(true);
    expect(shouldSkipResumeDownload({ attempts: 1, lastError: 'Browser lost: browser has been closed' }, false)).toBe(false);
    // Same Playwright text, but the session stayed connected so the worker did not add the marker.
    expect(shouldSkipResumeDownload({ attempts: 1, lastError: 'Error: page.goto: Target page, context or browser has been closed' }, true)).toBe(false);
    expect(shouldSkipResumeDownload({ attempts: 1, lastError: 'Error: Could not find applicant cards' }, true)).toBe(false);
  });

  it('recognises the wording Playwright uses when Chrome is gone', () => {
    expect(BROWSER_LOST_RE.test('Error: page.goto: Target page, context or browser has been closed')).toBe(true);
    expect(BROWSER_LOST_RE.test('Error: browserContext.newPage: Target closed')).toBe(true);
    expect(BROWSER_LOST_RE.test('Error: locator.click: Timeout 30000ms exceeded')).toBe(false);
  });
});
