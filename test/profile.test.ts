import { describe, expect, it } from 'vitest';
import { parseAboutText, parseContactText, parseDateRangeText, parseDetailsItemText, parseInlineSection, parseProfileHeaderText, profileToText } from '../src/linkedin/profile.js';
import type { Profile } from '../src/types.js';

describe('parseDateRangeText', () => {
  it('parses month ranges, present and durations', () => {
    expect(parseDateRangeText('Jan 2020 - Present · 6 yrs 9 mos')).toMatchObject({ start: '2020-01', end: undefined, isCurrent: true });
    expect(parseDateRangeText('Sep 2015 – Dec 2019 · 4 yrs 4 mos')).toMatchObject({ start: '2015-09', end: '2019-12', isCurrent: false });
    expect(parseDateRangeText('2016 - 2020')).toMatchObject({ start: '2016', end: '2020' });
    expect(parseDateRangeText('Issued Mar 2024')).toMatchObject({ start: '2024-03' });
    expect(parseDateRangeText('no dates here')).toBeUndefined();
  });
});

describe('parseDetailsItemText', () => {
  it('parses an experience item', () => {
    const p = parseDetailsItemText('Senior Engineer\nSenior Engineer\nAcme · Full-time\nJan 2020 - Present · 6 yrs 9 mos\nBerlin, Germany · Hybrid\nBuilt things\nand more things', 'experience');
    expect(p.title).toBe('Senior Engineer');
    expect(p.extra.company).toBe('Acme');
    expect(p.extra.employmentType).toBe('Full-time');
    expect(p.dates).toMatchObject({ start: '2020-01', isCurrent: true });
    expect(p.location).toBe('Berlin, Germany · Hybrid');
    expect(p.description).toBe('Built things\nand more things');
  });

  it('parses education and certification items', () => {
    const e = parseDetailsItemText('MIT\nMaster of Science, Computer Science\n2016 - 2018\nGrade: 4.0', 'education');
    expect(e.title).toBe('MIT');
    expect(e.subtitle).toBe('Master of Science, Computer Science');
    expect(e.dates).toMatchObject({ start: '2016', end: '2018' });
    const c = parseDetailsItemText('AWS Certified Solutions Architect\nAmazon Web Services\nIssued Mar 2024 · Expires Mar 2027\nCredential ID ABC-123\nShow credential', 'certifications');
    expect(c.title).toBe('AWS Certified Solutions Architect');
    expect(c.subtitle).toBe('Amazon Web Services');
    expect(c.extra.credentialId).toBe('ABC-123');
    expect(c.extra.issued).toBe('Mar 2024');
    expect(c.extra.expires).toBe('Mar 2027');
  });

  it('parses skills and languages', () => {
    expect(parseDetailsItemText('Kubernetes\n12 endorsements', 'skills').title).toBe('Kubernetes');
    expect(parseDetailsItemText('German\nProfessional working proficiency', 'languages')).toMatchObject({ title: 'German', subtitle: 'Professional working proficiency' });
  });
});

describe('parseProfileHeaderText / about / inline sections', () => {
  const text = [
    'Skip to main content',
    'Home',
    'My Network',
    'Jane Doe · 2nd',
    'Jane Doe',
    '(She/Her)',
    'Senior Backend Engineer at Acme | Go, Kubernetes',
    'Berlin, Berlin, Germany · Contact info',
    '500+ connections',
    'About',
    'I build reliable systems.',
    '…see more',
    'Experience',
    'Senior Backend Engineer',
    'Acme · Full-time',
    'Jan 2020 - Present · 6 yrs',
    'Berlin, Germany',
    'Backend Engineer',
    'Globex · Full-time',
    'Mar 2016 - Dec 2019 · 3 yrs 10 mos',
    'Education',
    'TU Berlin',
  ].join('\n');

  it('extracts name, headline and location', () => {
    const h = parseProfileHeaderText(text);
    expect(h.fullName).toBe('Jane Doe');
    expect(h.headline).toBe('Senior Backend Engineer at Acme | Go, Kubernetes');
    expect(h.location).toBe('Berlin, Berlin, Germany · Contact info');
  });

  it('extracts about and splits inline experience into items', () => {
    expect(parseAboutText(text)).toBe('I build reliable systems.');
    const items = parseInlineSection(text, 'Experience');
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('Senior Backend Engineer');
    expect(items[1]).toContain('Globex');
  });
});

describe('parseContactText', () => {
  it('extracts contact fields', () => {
    const c = parseContactText("Jane's Profile\nlinkedin.com/in/jane\nWebsite\nhttps://jane.dev (Personal)\nEmail\njane@example.com\nPhone\n+49 170 1234567 (Mobile)\nBirthday\nMarch 3", ['https://www.linkedin.com/in/jane/', 'https://jane.dev/', 'mailto:jane@example.com']);
    expect(c.email).toBe('jane@example.com');
    expect(c.phone).toBe('+49 170 1234567');
    expect(c.websites).toEqual(['https://jane.dev/']);
    expect(c.birthday).toBe('March 3');
  });
});

describe('profileToText', () => {
  it('renders all sections', () => {
    const p: Profile = {
      profileUrl: 'https://www.linkedin.com/in/jane/',
      fullName: 'Jane Doe',
      headline: 'Engineer',
      about: 'Hi',
      experience: [{ title: 'Engineer', company: 'Acme', dates: { start: '2020-01', isCurrent: true, text: 'Jan 2020 - Present' }, description: 'Did X' }],
      education: [{ school: 'MIT', degree: 'MSc' }],
      skills: ['Go', 'Kubernetes'],
      certifications: [{ name: 'CKA', issuer: 'CNCF' }],
      languages: [{ name: 'English', proficiency: 'Native' }],
      projects: [],
      honors: [{ title: 'Award' }],
      volunteering: [],
      publications: [],
      courses: [],
      source: 'dom',
      fetchedAt: '2026-09-25T00:00:00.000Z',
    };
    const t = profileToText(p);
    for (const s of ['Jane Doe', 'Engineer, Acme', 'Jan 2020 - Present', 'MIT, MSc', 'Skills: Go, Kubernetes', 'CKA, CNCF', 'English (Native)', 'Honors:', 'Award']) expect(t).toContain(s);
  });
});
