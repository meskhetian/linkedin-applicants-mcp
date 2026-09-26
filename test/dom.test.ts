import { describe, expect, it } from 'vitest';
import { extractEmail, extractPhone, parseCount, relativeToIso } from '../src/linkedin/dom.js';

describe('dom text helpers', () => {
  it('parses applicant counts', () => {
    expect(parseCount('1,234 applicants')).toBe(1234);
    expect(parseCount('3 applicants')).toBe(3);
    expect(parseCount('Showing 25 of 2.345 applicants')).toBe(2345);
    expect(parseCount(undefined)).toBeUndefined();
  });

  it('converts relative times', () => {
    const now = new Date('2026-09-25T12:00:00Z');
    expect(relativeToIso('Applied 3 days ago', now)).toBe('2026-09-22T12:00:00.000Z');
    expect(relativeToIso('2 weeks ago', now)).toBe('2026-09-11T12:00:00.000Z');
    expect(relativeToIso('yesterday', now)).toBeUndefined();
  });

  it('extracts contact info', () => {
    expect(extractEmail('Email: Jane.Doe+li@example.co.uk · Phone')).toBe('Jane.Doe+li@example.co.uk');
    expect(extractPhone('Phone +90 (532) 123 45 67 shared')).toBe('+90 (532) 123 45 67');
    expect(extractPhone('applied 12 days ago')).toBeUndefined();
  });
});

describe('relativeToIso short forms', () => {
  it('handles LinkedIn abbreviations', () => {
    const now = new Date('2026-09-25T12:00:00Z');
    expect(relativeToIso('Applied 3d ago', now)).toBe('2026-09-22T12:00:00.000Z');
    expect(relativeToIso('5h ago', now)).toBe('2026-09-25T07:00:00.000Z');
    expect(relativeToIso('2w ago', now)).toBe('2026-09-11T12:00:00.000Z');
    expect(relativeToIso('1mo ago', now)).toBe('2026-08-26T12:00:00.000Z');
    expect(relativeToIso('12m ago', now)).toBe('2026-09-25T11:48:00.000Z');
  });
});
