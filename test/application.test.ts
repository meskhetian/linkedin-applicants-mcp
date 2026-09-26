import { describe, expect, it } from 'vitest';
import { classifyTrapRequest, decideResumeIntercept, extractQualificationsText, filenameFromContentDisposition, findDocumentUrls, looksTextual, parseDetailHeaderText, parseScreeningText, pickResumeExt, redactUrl, scoreDocumentUrl, shouldReadResponseBody, sliceBetween, sniffExt } from '../src/linkedin/application.js';

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

describe('extractQualificationsText (Hiring Pro pane)', () => {
  const pane = [
    'Dana Whitfield', '· 2nd', 'Head of Operations', 'Toronto, Ontario, Canada', 'Applied 3d ago',
    'Resume', 'Share', 'Shortlist', 'Move to', 'Contact', 'Interview with AI',
    'Qualifications', 'Top fit', '6/6', 'Must-have', '5/5', 'Preferred',
    'Must-have', '10+ years of experience in operations leadership', 'Preferred', 'Deep fundraising network',
    'Rate this AI-generated content', 'Experience', 'Chief Operating Officer', 'Acme Robotics • 2021-Present', 'View full profile',
  ].join('\n\n');

  it('returns the Qualifications section only', () => {
    const q = extractQualificationsText(pane)!;
    expect(q.startsWith('Qualifications\nTop fit\n6/6\nMust-have')).toBe(true);
    expect(q).toContain('10+ years of experience in operations leadership');
    expect(q).not.toContain('Rate this AI-generated content');
    expect(q).not.toContain('Chief Operating Officer');
  });

  it('is undefined when the pane has no such section', () => {
    expect(extractQualificationsText('Dana Whitfield\nApplied 3d ago\nResume')).toBeUndefined();
    expect(sliceBetween('a\nb\nc', /^b$/, /^zzz$/)).toBe('b\nc');
  });
});

describe('decideResumeIntercept (network-layer resume capture)', () => {
  const pdf = Buffer.from('%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n1 0 obj', 'latin1');
  const html = Buffer.from('<!doctype html><html><body>viewer</body></html>');

  it('swallows a navigation to a PDF so Chrome never starts a download', () => {
    expect(decideResumeIntercept({ url: 'https://media.licdn.com/dms/document/x.pdf', resourceType: 'document', contentType: 'application/pdf', bytes: pdf, fromWorkingPage: true })).toEqual({ isFile: true, swallow: true });
  });

  it('swallows attachments regardless of resource type', () => {
    expect(decideResumeIntercept({ url: 'https://www.linkedin.com/ambry/?x-li-ambry-ep=abc', resourceType: 'xhr', contentType: 'application/octet-stream', contentDisposition: 'attachment; filename="cv.docx"', bytes: Buffer.alloc(300), fromWorkingPage: true })).toEqual({ isFile: true, swallow: true });
  });

  it('passes an inline viewer fetch through while still recognising the file', () => {
    expect(decideResumeIntercept({ url: 'https://media.licdn.com/dms/document/x', resourceType: 'fetch', contentType: 'application/pdf', bytes: pdf, fromWorkingPage: true })).toEqual({ isFile: true, swallow: false });
  });

  it('swallows any file that lands in a popup we opened', () => {
    expect(decideResumeIntercept({ url: 'https://example.cdn/some/signed/url', resourceType: 'fetch', contentType: 'application/pdf', bytes: pdf, fromWorkingPage: false })).toEqual({ isFile: true, swallow: true });
  });

  it('leaves HTML alone', () => {
    expect(decideResumeIntercept({ url: 'https://www.linkedin.com/hiring/applicants/', resourceType: 'document', contentType: 'text/html; charset=utf-8', bytes: html, fromWorkingPage: false })).toEqual({ isFile: false, swallow: false });
  });
});

describe('viewer payloads are text, not resumes', () => {
  const rsc = Buffer.from('1:I["2ad3ea7278caf3e388ff36e545132f6c",[],"DestinationReporter"]\n2:I["9572b44cf39ab2b79fb58e1626297543",[],"PageLoadTracingProvider"]\n0:["$","div",null,{"data-sdui-screen":"com.linkedin.sdui.flagshipnav.hiring.appeval.ResumeViewer"}]');

  it('looksTextual tells text from documents', () => {
    expect(looksTextual(rsc)).toBe(true);
    expect(looksTextual(Buffer.from('{"data":1}'))).toBe(true);
    expect(looksTextual(Buffer.from('%PDF-1.7\n%\u00e2\u00e3', 'latin1'))).toBe(false);
    expect(looksTextual(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toBe(false);
  });

  it('decideResumeIntercept never treats a viewer payload as a file, whatever the headers say', () => {
    expect(decideResumeIntercept({ url: 'https://www.linkedin.com/hiring/applicants/?applicationId=1', resourceType: 'fetch', contentType: 'application/octet-stream', bytes: rsc, fromWorkingPage: true }).isFile).toBe(false);
    expect(decideResumeIntercept({ url: 'https://www.linkedin.com/hiring/applicants/?applicationId=1', resourceType: 'fetch', contentType: 'text/x-component', contentDisposition: 'attachment', bytes: rsc, fromWorkingPage: false }).isFile).toBe(false);
  });

  it('findDocumentUrls pulls the analyzed PDF first and drops images and manifests', () => {
    const payload = 'x "https://www.linkedin.com/dms/prv/document/media/v2/D562/recruiter-candidate-document-pdf-analyzed/B56/0/1789?m=AQK\\u0026v=beta" y "https://www.linkedin.com/dms/prv/image/v2/D562/recruiter-candidate-document-cover-images_1280/B56/0/1789?m=AQI" z "https://www.linkedin.com/dms/prv/document/pl/v2/D562/recruiter-candidate-document-master-manifest/B56/0/1789?m=AQL" w "https://www.linkedin.com/dms/prv/document/media/v2/D562/other-document/B56/0/1?m=1"';
    expect(findDocumentUrls(payload)).toEqual([
      'https://www.linkedin.com/dms/prv/document/media/v2/D562/recruiter-candidate-document-pdf-analyzed/B56/0/1789?m=AQK&v=beta',
      'https://www.linkedin.com/dms/prv/document/media/v2/D562/other-document/B56/0/1?m=1',
    ]);
    expect(findDocumentUrls('nothing here')).toEqual([]);
  });
});

describe('classifyTrapRequest', () => {
  it('ignores unrelated tabs and everything that is not a top-level navigation', () => {
    expect(classifyTrapRequest({ url: 'https://media.licdn.com/dms/document/x.pdf', isTopLevelNavigation: true, origin: 'other' })).toEqual({ swallow: false });
    expect(classifyTrapRequest({ url: 'https://media.licdn.com/dms/document/x.pdf', isTopLevelNavigation: false, origin: 'working' })).toEqual({ swallow: false });
    expect(classifyTrapRequest({ url: 'https://www.linkedin.com/hiring/applicants/?applicationId=1', isTopLevelNavigation: false, origin: 'popup' })).toEqual({ swallow: false });
  });

  it('answers navigations to files itself, and lets popups load ordinary LinkedIn pages', () => {
    expect(classifyTrapRequest({ url: 'https://media.licdn.com/dms/document/x.pdf', isTopLevelNavigation: true, origin: 'working' })).toEqual({ swallow: true });
    expect(classifyTrapRequest({ url: 'https://example.cdn/signed', isTopLevelNavigation: true, origin: 'popup' })).toEqual({ swallow: true });
    expect(classifyTrapRequest({ url: 'https://www.linkedin.com/hiring/applicants/?applicationId=1&jobId=2', isTopLevelNavigation: true, origin: 'popup' })).toEqual({ swallow: false });
    expect(classifyTrapRequest({ url: 'https://www.linkedin.com/hiring/applicants/?applicationId=1&jobId=2', isTopLevelNavigation: true, origin: 'working' })).toEqual({ swallow: false });
  });
});

describe('redactUrl and scoreDocumentUrl', () => {
  it('keeps host and path only', () => {
    expect(redactUrl('https://www.linkedin.com/dms/prv/document/media/v2/x/recruiter-candidate-document-pdf-analyzed/y?m=SECRET&e=1')).toBe('www.linkedin.com/dms/prv/document/media/v2/x/recruiter-candidate-document-pdf-analyzed/y');
    expect(redactUrl('not a url?token=1')).toBe('not a url');
  });

  it('ranks the analysed PDF first', () => {
    const urls = ['https://example.cdn/signed', 'https://www.linkedin.com/dms/prv/document/media/v2/x/other/y?m=1', 'https://www.linkedin.com/dms/prv/document/media/v2/x/recruiter-candidate-document-pdf-analyzed/y?m=1'];
    expect([...urls].sort((a, b) => scoreDocumentUrl(a) - scoreDocumentUrl(b))[0]).toContain('pdf-analyzed');
  });
});

describe('decideResumeIntercept uses the url for unknown binary navigations', () => {
  const binary = Buffer.alloc(2048, 0x9c);
  it('treats a resume-looking navigation with unknown binary bytes as the file, but not an arbitrary one', () => {
    const base = { resourceType: 'document', contentType: null, bytes: binary, fromWorkingPage: true };
    expect(decideResumeIntercept({ ...base, url: 'https://www.linkedin.com/dms/prv/document/media/v2/x/recruiter-candidate-document-pdf-analyzed/y' }).isFile).toBe(true);
    expect(decideResumeIntercept({ ...base, url: 'https://www.linkedin.com/hiring/applicants/?applicationId=1' }).isFile).toBe(false);
  });
});

describe('shouldReadResponseBody', () => {
  it('never awaits streams or telemetry', () => {
    expect(shouldReadResponseBody({ resourceType: 'fetch', contentType: 'text/event-stream', url: 'https://www.linkedin.com/realtime/connect' })).toBe('skip');
    expect(shouldReadResponseBody({ resourceType: 'fetch', contentType: 'application/json', url: 'https://www.linkedin.com/realtime/realtimeFrontendClientConnectivityTracking' })).toBe('skip');
    expect(shouldReadResponseBody({ resourceType: 'fetch', contentType: 'application/json', url: 'https://www.linkedin.com/li/track' })).toBe('skip');
  });

  it('reads viewer payloads as text and viewer file fetches as files', () => {
    expect(shouldReadResponseBody({ resourceType: 'fetch', contentType: 'text/x-component', url: 'https://www.linkedin.com/hiring/applicants/?applicationId=1' })).toBe('text');
    expect(shouldReadResponseBody({ resourceType: 'xhr', contentType: 'application/pdf', url: 'https://www.linkedin.com/dms/prv/document/media/v2/x/recruiter-candidate-document-pdf-analyzed/y' })).toBe('file');
    expect(shouldReadResponseBody({ resourceType: 'document', contentType: 'application/pdf', url: 'https://media.licdn.com/dms/document/x.pdf' })).toBe('skip');
    expect(shouldReadResponseBody({ resourceType: 'image', contentType: 'image/png', url: 'https://media.licdn.com/dms/image/v2/x/profile-displayphoto-shrink_100_100/y' })).toBe('skip');
    expect(shouldReadResponseBody({ resourceType: 'script', contentType: 'application/javascript', url: 'https://static.licdn.com/sc/h/app.js' })).toBe('skip');
  });
});
