import { describe, expect, it } from 'vitest';
import { mapJobStatus, parseJobCardText } from '../src/linkedin/jobs.js';

describe('mapJobStatus', () => {
  it('maps status words and falls back to the tab', () => {
    expect(mapJobStatus('Active · Posted 3 days ago', 'open')).toBe('open');
    expect(mapJobStatus('Closed', 'open')).toBe('closed');
    expect(mapJobStatus('Paused', 'open')).toBe('paused');
    expect(mapJobStatus('Draft', 'open')).toBe('draft');
    expect(mapJobStatus('Expired', 'open')).toBe('closed');
    expect(mapJobStatus(undefined, 'closed')).toBe('closed');
    expect(mapJobStatus(undefined, 'open')).toBe('open');
  });
});

describe('parseJobCardText', () => {
  it('parses the 2026 posted-jobs card (SDUI card shape)', () => {
    const p = parseJobCardText('Head of Operations \n, Verified\nAcme Robotics\nAustin, Texas, United States (Hybrid)\nActive • Posted 3mo ago\n1,203 applicants', 'open');
    expect(p).toMatchObject({ title: 'Head of Operations', companyName: 'Acme Robotics', location: 'Austin, Texas, United States', workplaceType: 'Hybrid', status: 'open', applicantCount: 1203, postedAgo: '3mo ago' });
    const c = parseJobCardText('Program Manager \n, Verified\nAcme Robotics\nAustin, Texas, United States (Remote)\nClosed • Closed 2mo ago • $1,234.50 spent\n842 applicants', 'closed');
    expect(c).toMatchObject({ title: 'Program Manager', companyName: 'Acme Robotics', location: 'Austin, Texas, United States', workplaceType: 'Remote', status: 'closed', applicantCount: 842, closedAgo: '2mo ago' });
    const k = parseJobCardText('Regional Sales Lead \n, Verified\nAcme Robotics\nToronto, Ontario, Canada (On-site)\nClosed • Closed 5mo ago • $987.00 spent\n157 applicants', 'closed');
    expect(k).toMatchObject({ location: 'Toronto, Ontario, Canada', workplaceType: 'On-site', applicantCount: 157 });
  });
  it('parses a legacy card', () => {
    const p = parseJobCardText('Senior Backend Engineer\nAcme · Berlin, Germany (Hybrid)\n1,234 applicants\nActive · Posted 12 days ago\nView applicants', 'open');
    expect(p).toMatchObject({ title: 'Senior Backend Engineer', companyName: 'Acme', location: 'Berlin, Germany', workplaceType: 'Hybrid', status: 'open', applicantCount: 1234, postedAgo: '12 days ago' });
  });
});
