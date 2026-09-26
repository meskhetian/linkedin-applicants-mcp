import { describe, expect, it } from 'vitest';
import { filenameFromContentDisposition, parseDetailHeaderText, parseScreeningText, pickResumeExt, sniffExt } from '../src/linkedin/application.js';

describe('filenameFromContentDisposition', () => {
  it('handles plain, quoted and RFC 5987 forms', () => {
    expect(filenameFromContentDisposition('attachment; filename=Jane.pdf')).toBe('Jane.pdf');
    expect(filenameFromContentDisposition('attachment; filename="Jane Doe CV.pdf"')).toBe('Jane Doe CV.pdf');
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''J%C3%A4ne%20CV.pdf")).toBe('Jäne CV.pdf');
    expect(filenameFromContentDisposition("inline; filename=\"fallback.pdf\"; filename*=UTF-8''real.docx")).toBe('real.docx');
    expect(filenameFromContentDisposition(undefined)).toBeUndefined();
  });
});

describe('sniffExt / pickResumeExt', () => {
  it('prefers magic bytes, then file name, then content type', () => {
    expect(sniffExt(Buffer.from('%PDF-1.7 ...'))).toBe('pdf');
    expect(sniffExt(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe('docx');
    expect(pickResumeExt({ fileName: 'cv.docx', contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.4') })).toBe('pdf');
    expect(pickResumeExt({ fileName: 'cv.DOCX', contentType: 'application/octet-stream' })).toBe('docx');
    expect(pickResumeExt({ fileName: 'weird.bin', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).toBe('docx');
    expect(pickResumeExt({})).toBe('pdf');
  });
});

describe('parseScreeningText', () => {
  it('pairs questions with answers and notes', () => {
    const qa = parseScreeningText(
      'Screening questions\nMust-have\nHow many years of Python experience do you have?\n5\nIdeal answer: 3\nAre you legally authorized to work in Germany?\nYes\nMeets requirement\nPreferred\nWhat is your notice period?\n2 months',
    );
    expect(qa).toEqual([
      { question: 'How many years of Python experience do you have?', answer: '5 (ideal: 3)' },
      { question: 'Are you legally authorized to work in Germany?', answer: 'Yes (meets requirement)' },
      { question: 'What is your notice period?', answer: '2 months' },
    ]);
  });
  it('returns nothing for text without questions', () => {
    expect(parseScreeningText('Jane Doe\nBerlin')).toEqual([]);
  });
});

describe('parseDetailHeaderText', () => {
  it('extracts header fields from a detail page', () => {
    const h = parseDetailHeaderText('Applicants\nJane Doe\nJane Doe · 2nd\nSenior Backend Engineer at Acme\nBerlin, Germany\nApplied 3 days ago\nMessage\nGood fit\nMaybe\nNot a fit\nMore');
    expect(h).toMatchObject({ fullName: 'Jane Doe', headline: 'Senior Backend Engineer at Acme', location: 'Berlin, Germany', appliedAgo: 'Applied 3 days ago' });
  });
});
