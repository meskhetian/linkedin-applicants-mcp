import { describe, expect, it } from 'vitest';
import { shouldSkipResumeDownload } from '../src/queue/resume-policy.js';

describe('shouldSkipResumeDownload', () => {
  it('skips the resume only on a retry after the browser was lost', () => {
    expect(shouldSkipResumeDownload({ attempts: 1, lastError: 'Error: download.saveAs: Target page, context or browser has been closed' }, true)).toBe(true);
    expect(shouldSkipResumeDownload({ attempts: 2, lastError: 'Error: page.goto: Target page, context or browser has been closed' }, true)).toBe(true);
  });

  it('never skips on the first attempt, when the resume was not wanted, or after unrelated errors', () => {
    expect(shouldSkipResumeDownload({ attempts: 0, lastError: undefined }, true)).toBe(false);
    expect(shouldSkipResumeDownload({ attempts: 1, lastError: 'browser has been closed' }, false)).toBe(false);
    expect(shouldSkipResumeDownload({ attempts: 1, lastError: 'Error: Could not find applicant cards' }, true)).toBe(false);
  });
});
