import { describe, expect, it } from 'vitest';
import { URLS, detectUiVariantFromUrl, looksLikeResumeUrl, normalizeProfileUrl, parseApplicationId, parseJobId, parseVanity, ratingFromBucket } from '../src/linkedin/urls.js';

describe('urls', () => {
  it('builds dashboard urls', () => {
    expect(URLS.postedJobs('closed')).toBe('https://www.linkedin.com/my-items/posted-jobs/?jobState=CLOSED');
    expect(URLS.applicants('123', 0)).toBe('https://www.linkedin.com/hiring/jobs/123/applicants/');
    expect(URLS.applicants('123', 50)).toBe('https://www.linkedin.com/hiring/jobs/123/applicants/?start=50');
    expect(URLS.applicants('123', 25, { bucket: 'NOT_A_FIT', sort: 'APPLIED_DATE' })).toBe('https://www.linkedin.com/hiring/jobs/123/applicants/?r=NOT_A_FIT&sort_by=APPLIED_DATE&start=25');
    expect(URLS.applicantsPro('123')).toBe('https://www.linkedin.com/hiring/applicants/?jobId=123&rating=ALL&sort=DateApplied');
    expect(URLS.applicantDetail('123', '987')).toBe('https://www.linkedin.com/hiring/jobs/123/applicants/987/detail/');
    expect(URLS.applicantDetailPro('123', '987')).toBe('https://www.linkedin.com/hiring/applicants/?jobId=123&applicationId=987&rating=ALL');
    expect(URLS.profile('jane-doe')).toBe('https://www.linkedin.com/in/jane-doe/');
  });

  it('parses ids from both url shapes', () => {
    expect(parseJobId('https://www.linkedin.com/hiring/jobs/4123456789/applicants/?start=25')).toBe('4123456789');
    expect(parseJobId('https://www.linkedin.com/hiring/applicants/?jobId=4123456789&rating=ALL')).toBe('4123456789');
    expect(parseJobId('https://www.linkedin.com/jobs/view/4123456789/')).toBe('4123456789');
    expect(parseApplicationId('https://www.linkedin.com/hiring/jobs/1/applicants/55667788/detail/')).toBe('55667788');
    expect(parseApplicationId('https://www.linkedin.com/hiring/applicants/?jobId=1&applicationId=42&rating=ALL')).toBe('42');
    expect(parseVanity('https://www.linkedin.com/in/jane-doe-1234/details/experience/')).toBe('jane-doe-1234');
    expect(parseVanity('https://www.linkedin.com/in/%C3%A9lodie/')).toBe('élodie');
    expect(normalizeProfileUrl('https://linkedin.com/in/jane?miniProfileUrn=x')).toBe('https://www.linkedin.com/in/jane/');
    expect(normalizeProfileUrl('https://www.linkedin.com/company/acme/')).toBeUndefined();
  });

  it('detects the dashboard ui variant from the landing url', () => {
    expect(detectUiVariantFromUrl('https://www.linkedin.com/hiring/jobs/1/applicants/?start=25')).toBe('legacy');
    expect(detectUiVariantFromUrl('https://www.linkedin.com/hiring/applicants/?jobId=1&rating=ALL')).toBe('hiring_pro');
    expect(detectUiVariantFromUrl('https://www.linkedin.com/hiring/jobs/1/applicants/?applicationId=5')).toBe('hiring_pro');
    expect(detectUiVariantFromUrl('https://www.linkedin.com/feed/')).toBeUndefined();
  });

  it('maps rating buckets', () => {
    expect(ratingFromBucket('GOOD_FIT')).toBe('good_fit');
    expect(ratingFromBucket('NOT_A_FIT')).toBe('not_a_fit');
    expect(ratingFromBucket('UNRATED')).toBe('unrated');
  });

  it('recognises resume file urls', () => {
    expect(looksLikeResumeUrl('https://www.linkedin.com/ambry/?x-li-ambry-ep=AQ...')).toBe(true);
    expect(looksLikeResumeUrl('https://media.licdn.com/dms/document/abc/0/1?e=1&v=beta&t=sig')).toBe(true);
    expect(looksLikeResumeUrl('https://media.licdn.com/dms/image/abc/profile.jpg?e=1')).toBe(false);
    expect(looksLikeResumeUrl('https://www.linkedin.com/in/jane/')).toBe(false);
  });
});
