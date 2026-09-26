import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Db } from '../src/storage/db.js';
import { csvCell, exportApplicants, toCsv } from '../src/storage/export.js';

describe('csv', () => {
  it('quotes and guards formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+90 532')).toBe("'+90 532");
    expect(csvCell(null)).toBe('');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
  it('writes header + rows with BOM', () => {
    const out = toCsv([{ a: 1, b: 'x' }], ['a', 'b']);
    expect(out.startsWith('﻿')).toBe(true);
    expect(out).toContain('a,b\n1,x\n');
  });
});

describe('exportApplicants', () => {
  it('streams csv and json exports', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'li-export-'));
    const cfg = loadConfig({ dataDir: tmp });
    const db = new Db(':memory:');
    const now = '2026-09-25T10:00:00.000Z';
    db.upsertJob({ jobId: 'j1', title: 'Backend Engineer', status: 'open', url: 'u', syncedAt: now });
    db.upsertApplicantFromList({ applicationId: 'a1', jobId: 'j1', fullName: 'Ada, Lovelace', headline: '=cmd', listSyncedAt: now });
    db.upsertApplicantFromList({ applicationId: 'a2', jobId: 'j1', fullName: 'Grace Hopper', listSyncedAt: now });
    db.updateApplicantDetail('a1', { email: 'ada@example.com', resumeText: 'Django, Kubernetes', screeningAnswers: [{ question: 'Visa?', answer: 'Yes' }] });
    const csv = await exportApplicants(db, cfg, { jobId: 'j1', format: 'csv', includeResumeText: true });
    expect(csv.count).toBe(2);
    const text = fs.readFileSync(csv.path, 'utf8');
    expect(text).toContain('"Ada, Lovelace"');
    expect(text).toContain("'=cmd");
    expect(text).toContain('Backend Engineer');
    expect(text).toContain('Django, Kubernetes');
    const json = await exportApplicants(db, cfg, { format: 'json', includeProfile: true });
    const arr = JSON.parse(fs.readFileSync(json.path, 'utf8')) as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(2);
    expect(arr.find((r) => r.applicationId === 'a1')?.screeningAnswers).toEqual([{ question: 'Visa?', answer: 'Yes' }]);
    const jsonl = await exportApplicants(db, cfg, { format: 'jsonl' });
    expect(fs.readFileSync(jsonl.path, 'utf8').trim().split('\n')).toHaveLength(2);
  });
});
