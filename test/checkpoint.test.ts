import { describe, expect, it } from 'vitest';
import { classifyVoyagerResponse, detectCheckpoint } from '../src/browser/checkpoint.js';

describe('detectCheckpoint', () => {
  it('flags checkpoint and login URLs', () => {
    expect(detectCheckpoint('https://www.linkedin.com/checkpoint/challenge/AgH1')?.kind).toBe('security_verification');
    expect(detectCheckpoint('https://www.linkedin.com/checkpoint/lg/login-submit', 'Are you a robot? Solve this puzzle')?.kind).toBe('captcha');
    expect(detectCheckpoint('https://www.linkedin.com/uas/login?session_redirect=%2Ffeed')?.kind).toBe('login');
    expect(detectCheckpoint('https://www.linkedin.com/authwall?trk=x')?.kind).toBe('login');
    expect(detectCheckpoint('https://www.linkedin.com/login')?.kind).toBe('login');
  });

  it('does not flag normal pages or feed text mentioning captcha', () => {
    expect(detectCheckpoint('https://www.linkedin.com/hiring/jobs/123/applicants/')).toBeNull();
    expect(detectCheckpoint('https://www.linkedin.com/in/someone/', 'I built a captcha solver once, great weekend project')).toBeNull();
    expect(detectCheckpoint('https://www.linkedin.com/loginsomething/')).toBeNull();
  });

  it('flags strong restriction text on otherwise normal URLs', () => {
    expect(detectCheckpoint('https://www.linkedin.com/feed/', "We've restricted your account temporarily")?.kind).toBe('unusual_activity');
  });
});

describe('classifyVoyagerResponse', () => {
  it('maps statuses', () => {
    expect(classifyVoyagerResponse(200, 'application/vnd.linkedin.normalized+json+2.1')).toBe('ok');
    expect(classifyVoyagerResponse(200, 'text/html; charset=utf-8')).toBe('login-wall');
    expect(classifyVoyagerResponse(429, 'application/json')).toBe('rate-limited');
    expect(classifyVoyagerResponse(999, '')).toBe('edge-bot-block');
    expect(classifyVoyagerResponse(410, 'application/json')).toBe('endpoint-retired');
    expect(classifyVoyagerResponse(302, '', 'li_at="delete me"; Path=/')).toBe('session-revoked');
  });
});
