import { describe, expect, it } from 'vitest';
import { decideNextPage, fitPriorityBonus, nextSweepSort, parseApplicantCardText, parseAppliedOn, parseFitScore, parseNameBadges, parseProRowText } from '../src/linkedin/applicants.js';

describe('parseApplicantCardText (legacy)', () => {
  it('parses a legacy-style card', () => {
    const p = parseApplicantCardText('Jane Doe\nJane Doe\nSenior Backend Engineer at Acme\nBerlin, Germany\nApplied 3 days ago\nMeets all must-have qualifications');
    expect(p).toMatchObject({ fullName: 'Jane Doe', headline: 'Senior Backend Engineer at Acme', location: 'Berlin, Germany', appliedAgo: 'Applied 3 days ago', meetsScreening: true });
  });

  it('parses an SDUI-style card with badges and screening counters', () => {
    const p = parseApplicantCardText('New\nJohn Smith · 2nd\nData Scientist | Python, SQL\nIstanbul, Türkiye\n2/3 must-have qualifications\n2 weeks ago');
    expect(p.fullName).toBe('John Smith');
    expect(p.headline).toBe('Data Scientist | Python, SQL');
    expect(p.location).toBe('Istanbul, Türkiye');
    expect(p.appliedAgo).toBe('2 weeks ago');
    expect(p.meetsScreening).toBe(false);
  });

  it('handles a card with only name and location', () => {
    const p = parseApplicantCardText('Ali Veli\nAnkara, Türkiye\nApplied 1 hour ago');
    expect(p.fullName).toBe('Ali Veli');
    expect(p.location).toBe('Ankara, Türkiye');
    expect(p.headline).toBeUndefined();
  });
});

describe('parseProRowText (Hiring Pro)', () => {
  it('parses a column-style row', () => {
    const p = parseProRowText('Jane Doe\nSenior Backend Engineer\nAcme\nBerlin, Germany\n3/3 Must-have\n1/2 Preferred\nApplied on: Sep 20, 2026');
    expect(p).toMatchObject({ fullName: 'Jane Doe', title: 'Senior Backend Engineer', company: 'Acme', location: 'Berlin, Germany', appliedOn: 'Applied on: Sep 20, 2026', meetsScreening: true });
    expect(p.qualificationsText).toBe('3/3 Must-have · 1/2 Preferred');
  });

  it('splits "Title at Company" and ignores badges', () => {
    const p = parseProRowText('Top fit\nJohn Smith\nData Scientist at Globex\nIstanbul, Türkiye\n1/3 Must-have\nApplied 2 days ago');
    expect(p).toMatchObject({ fullName: 'John Smith', title: 'Data Scientist', company: 'Globex', location: 'Istanbul, Türkiye', meetsScreening: false });
  });
});

describe('parseNameBadges', () => {
  it('extracts the name and badges from the accessibility line', () => {
    expect(parseNameBadges('Dana Whitfield, new applicant')).toEqual({ name: 'Dana Whitfield', isNew: true, openToWork: false });
    expect(parseNameBadges('Dana Whitfield is open to work, new applicant')).toEqual({ name: 'Dana Whitfield', isNew: true, openToWork: true });
    expect(parseNameBadges('Dana Whitfield is open to work')).toEqual({ name: 'Dana Whitfield', isNew: false, openToWork: true });
  });

  it('leaves plain names alone', () => {
    expect(parseNameBadges('Dana Whitfield')).toBeUndefined();
    expect(parseNameBadges('Dr. Erika N.')).toBeUndefined();
    expect(parseNameBadges(', new applicant')).toBeUndefined();
  });
});

describe('parseProRowText (unopened applications)', () => {
  it('drops the "new applicant" badge line and keeps the real headline', () => {
    const p = parseProRowText('Dana Whitfield, new applicant\nDana Whitfield\n\nHead of Operations | Scaling logistics platforms\n\nSan Francisco Bay Area\n\n4/6\n\nMust-have\n\n5/5\n\nPreferred');
    expect(p.fullName).toBe('Dana Whitfield');
    expect(p.title).toBe('Head of Operations | Scaling logistics platforms');
    expect(p.company).toBeUndefined();
    expect(p.location).toBe('San Francisco Bay Area');
    expect(p.isNew).toBe(true);
    expect(p.openToWork).toBeUndefined();
  });

  it('handles "is open to work" and an empty "--" headline', () => {
    const p = parseProRowText('Priya Raman is open to work, new applicant\nPriya Raman\n\n--\n\nAustin, Texas, United States\n\n1/6\n\nMust-have\n\n2/5\n\nPreferred');
    expect(p.fullName).toBe('Priya Raman');
    expect(p.title).toBeUndefined();
    expect(p.company).toBeUndefined();
    expect(p.location).toBe('Austin, Texas, United States');
    expect(p.isNew).toBe(true);
    expect(p.openToWork).toBe(true);
  });

  it('still splits a real "Title at Company" headline after the badge line', () => {
    const p = parseProRowText('Priya Raman is open to work, new applicant\nPriya Raman\n\nRetail Sales Assistant at Acme Robotics\n\nToronto, Ontario, Canada\n\n1/6\n\nMust-have\n\n2/5\n\nPreferred');
    expect(p.fullName).toBe('Priya Raman');
    expect(p.title).toBe('Retail Sales Assistant');
    expect(p.company).toBe('Acme Robotics');
    expect(p.location).toBe('Toronto, Ontario, Canada');
  });

  it('keeps the badge line when the name line is missing', () => {
    const p = parseProRowText('Dana Whitfield, new applicant\n\nCOO\n\nUnited States');
    expect(p.fullName).toBe('Dana Whitfield');
    expect(p.title).toBe('COO');
    expect(p.location).toBe('United States');
  });
});

describe('parseApplicantCardText (unopened applications)', () => {
  it('drops the badge line on legacy cards too', () => {
    const p = parseApplicantCardText('Dana Whitfield, new applicant\nDana Whitfield\nHead of Operations at Acme Robotics\nToronto, Ontario, Canada\nApplied 3 days ago');
    expect(p.fullName).toBe('Dana Whitfield');
    expect(p.headline).toBe('Head of Operations at Acme Robotics');
    expect(p.location).toBe('Toronto, Ontario, Canada');
  });
});

describe('parseAppliedOn', () => {
  const now = new Date('2026-09-25T12:00:00Z');
  it('handles relative and absolute forms', () => {
    expect(parseAppliedOn('Applied 3 days ago', now)).toBe('2026-09-22T12:00:00.000Z');
    expect(parseAppliedOn('Applied on: Sep 20, 2026', now)?.slice(0, 10)).toBe('2026-09-20');
    expect(parseAppliedOn('Applied on Sep 20', now)?.slice(0, 7)).toBe('2026-09');
    expect(parseAppliedOn(undefined, now)).toBeUndefined();
    expect(parseAppliedOn('nonsense', now)).toBeUndefined();
  });
});

describe('decideNextPage', () => {
  const base = { cardsOnPage: 25, start: 0, hasNextButton: false, pagesThisRun: 1 };
  it('stops on empty pages and when the run budget is used', () => {
    expect(decideNextPage({ ...base, newIdsOnPage: 0, cardsOnPage: 0 }).action).toBe('stop');
    expect(decideNextPage({ ...base, newIdsOnPage: 25, maxPages: 1 }).action).toBe('stop');
    expect(decideNextPage({ ...base, newIdsOnPage: 25, maxPages: 2 }).action).toBe('offset');
  });
  it('stops at the reported total in offset mode but keeps scrolling in scroll mode', () => {
    expect(decideNextPage({ ...base, newIdsOnPage: 25, start: 2975, total: 3000 }).action).toBe('stop');
    expect(decideNextPage({ ...base, newIdsOnPage: 25, start: 2950, total: 3000 }).action).toBe('offset');
    expect(decideNextPage({ ...base, newIdsOnPage: 25, start: 2975, total: 3000, mode: 'scroll' }).action).toBe('scroll');
  });
  it('falls back to buttons or scrolling when the offset parameter is ignored', () => {
    expect(decideNextPage({ ...base, newIdsOnPage: 0, hasNextButton: true })).toMatchObject({ action: 'button' });
    expect(decideNextPage({ ...base, newIdsOnPage: 0, hasNextButton: false })).toMatchObject({ action: 'scroll' });
    expect(decideNextPage({ ...base, newIdsOnPage: 0, hasNextButton: false, mode: 'scroll' })).toMatchObject({ action: 'stop' });
    expect(decideNextPage({ ...base, newIdsOnPage: 0, hasNextButton: false, mode: 'buttons' })).toMatchObject({ action: 'stop' });
  });
  it('keeps using the detected mode', () => {
    expect(decideNextPage({ ...base, newIdsOnPage: 25, hasNextButton: true, mode: 'buttons' }).action).toBe('button');
    expect(decideNextPage({ ...base, newIdsOnPage: 25, hasNextButton: false, mode: 'buttons' }).action).toBe('stop');
  });
});

describe('parseProRowText (list card as rendered 2026-09)', () => {
  it('parses name / degree / headline / location / qualification counters', () => {
    const p = parseProRowText('Dana Whitfield\n\n· 2nd\n\nHead of Operations | Scaling logistics platforms | Team builder\n\nSan Francisco Bay Area\n\n6/6\n\nMust-have\n\n5/5\n\nPreferred');
    expect(p.fullName).toBe('Dana Whitfield');
    expect(p.title).toBe('Head of Operations | Scaling logistics platforms | Team builder');
    expect(p.company).toBeUndefined();
    expect(p.location).toBe('San Francisco Bay Area');
    expect(p.meetsScreening).toBe(true);
    expect(p.qualificationsText).toBe('6/6 · Must-have · 5/5 · Preferred');
    const q = parseProRowText('Priya Raman\n\n· 2nd\n\nDirector, Strategy & Operations\n\nAustin, Texas, United States\n\n5/6\n\nMust-have\n\n5/5\n\nPreferred');
    expect(q.location).toBe('Austin, Texas, United States');
    expect(q.meetsScreening).toBe(false);
  });
});

describe('fit score from the list counters', () => {
  it('parses must-have and preferred fractions', () => {
    expect(parseFitScore('6/6 · Must-have · 5/5 · Preferred')).toMatchObject({ mustHave: 1, preferred: 1, mustHaveText: '6/6', preferredText: '5/5' });
    expect(parseFitScore('3/6 · Must-have · 2/5 · Preferred')).toMatchObject({ mustHave: 0.5, preferred: 0.4 });
    expect(parseFitScore('4/6 Must-have')).toMatchObject({ mustHave: 4 / 6, preferred: 0 });
    expect(parseFitScore(undefined)).toBeUndefined();
    expect(parseFitScore('Top fit')).toBeUndefined();
  });

  it('ranks full matches first and unknown fit last', () => {
    const b = (q: string | undefined) => fitPriorityBonus(parseFitScore(q));
    expect(b('6/6 · Must-have · 5/5 · Preferred')).toBe(34);
    expect(b('5/6 · Must-have · 5/5 · Preferred')).toBe(24);
    expect(b('4/6 · Must-have · 5/5 · Preferred')).toBe(14);
    expect(b('3/6 · Must-have · 0/5 · Preferred')).toBe(5);
    expect(b('1/6 · Must-have · 5/5 · Preferred')).toBe(4);
    expect(b(undefined)).toBe(0);
  });
});

describe('nextSweepSort', () => {
  const base = { jobId: 'j', nextOffset: 1000, pagesVisited: 41, totalReported: 1005, stored: 955, complete: true, stoppedEarly: true } as const;
  it('queues a sweep in another order when a complete list is more than 2% short', () => {
    expect(nextSweepSort({ ...base }, false)).toBe('LastName');
    expect(nextSweepSort({ ...base, sweeps: 1 }, true)).toBe('QualificationMatch');
    expect(nextSweepSort({ ...base, sweeps: 2 }, true)).toBeUndefined();
  });
  it('does not sweep lists that are close enough, incomplete, or without a total', () => {
    expect(nextSweepSort({ ...base, stored: 990 }, false)).toBeUndefined();
    expect(nextSweepSort({ ...base, complete: false }, false)).toBeUndefined();
    expect(nextSweepSort({ ...base, totalReported: undefined }, false)).toBeUndefined();
    // A sweep that did not register as a sweep must not queue itself again.
    expect(nextSweepSort({ ...base, sweeps: 0 }, true)).toBeUndefined();
  });
});
