import { describe, expect, it } from 'vitest';
import { Db, toFtsQuery } from '../src/storage/db.js';

const now = '2026-09-25T10:00:00.000Z';

function seed() {
  const db = new Db(':memory:');
  db.upsertJob({ jobId: 'j1', title: 'Backend Engineer', status: 'open', url: 'https://www.linkedin.com/hiring/jobs/j1/applicants/', syncedAt: now });
  db.upsertApplicantFromList({ applicationId: 'a1', jobId: 'j1', fullName: 'Ada Lovelace', headline: 'Python', listSyncedAt: now, profileUrl: 'https://www.linkedin.com/in/ada/' });
  db.upsertApplicantFromList({ applicationId: 'a2', jobId: 'j1', fullName: 'Grace Hopper', listSyncedAt: now });
  return db;
}

describe('Db applicants', () => {
  it('upsert from list never clears detail fields', () => {
    const db = seed();
    db.updateApplicantDetail('a1', { email: 'ada@example.com', resumeText: 'Django Kubernetes', resumePath: '/r.pdf', hasResume: true });
    db.upsertApplicantFromList({ applicationId: 'a1', jobId: 'j1', fullName: 'Ada Lovelace', listSyncedAt: now });
    const a = db.getApplicant('a1')!;
    expect(a.email).toBe('ada@example.com');
    expect(a.resumePath).toBe('/r.pdf');
    expect(a.profileUrl).toBe('https://www.linkedin.com/in/ada/');
  });

  it('full-text search covers resume and profile text with prefix matching', () => {
    const db = seed();
    db.updateApplicantDetail('a1', { resumeText: 'Built Kubernetes operators in Go' });
    db.updateApplicantProfile('a2', '/p.json', { skills: ['COBOL'] }, 'Compiler pioneer and rear admiral');
    expect(db.listApplicants({ search: 'kuber' }).items.map((a) => a.fullName)).toEqual(['Ada Lovelace']);
    expect(db.listApplicants({ search: 'admiral compiler' }).items.map((a) => a.fullName)).toEqual(['Grace Hopper']);
    expect(db.listApplicants({ search: 'nothing-here' }).total).toBe(0);
  });

  it('reports what is missing per applicant', () => {
    const db = seed();
    expect(db.applicantIdsNeeding('j1', 'detail').map((x) => x.applicationId).sort()).toEqual(['a1', 'a2']);
    expect(db.applicantIdsNeeding('j1', 'profile').map((x) => x.applicationId)).toEqual(['a1']); // a2 has no profile url yet
    db.updateApplicantDetail('a2', { hasResume: false });
    expect(db.applicantIdsNeeding('j1', 'resume').map((x) => x.applicationId)).toEqual(['a1']);
  });

  it('job listing includes progress counters', () => {
    const db = seed();
    db.updateApplicantDetail('a1', { resumePath: '/r.pdf' });
    const [job] = db.listJobs('all');
    expect(job!.applicantsStored).toBe(2);
    expect(job!.detailsFetched).toBe(1);
    expect(job!.resumesStored).toBe(1);
  });
});

describe('Db tasks', () => {
  it('dedupes identical pending tasks and orders by priority', () => {
    const db = seed();
    const t1 = db.enqueueTask({ type: 'fetch_profile', jobId: 'j1', applicationId: 'a1', profileUrl: 'u', depth: 'basic', savePdf: false });
    const dup = db.enqueueTask({ type: 'fetch_profile', jobId: 'j1', applicationId: 'a1', profileUrl: 'u', depth: 'full', savePdf: true });
    const t2 = db.enqueueTask({ type: 'sync_applicants', jobId: 'j1' });
    expect(t1).toBeTypeOf('number');
    expect(dup).toBeUndefined();
    expect(db.nextTask(false)!.id).toBe(t2);
  });

  it('retries with backoff then fails permanently', () => {
    const db = seed();
    const id = db.enqueueTask({ type: 'sync_jobs', includeClosed: true }, { maxAttempts: 2 })!;
    db.markTaskRunning(id);
    expect(db.markTaskFailed(id, 'e1', { retry: true, backoffMs: 60_000 })).toBe('retrying');
    expect(db.nextTask(false)).toBeUndefined(); // run_after in the future
    db.getTask(id); // still pending
    expect(db.getTask(id)!.status).toBe('pending');
    db.markTaskRunning(id);
    expect(db.markTaskFailed(id, 'e2', { retry: true })).toBe('failed');
    expect(db.taskCounts().failed).toBe(1);
    expect(db.retryFailedTasks()).toBe(1);
    expect(db.getTask(id)!.status).toBe('pending');
    expect(db.getTask(id)!.attempts).toBe(0);
  });

  it('resets stale running tasks on startup without burning an attempt', () => {
    const db = seed();
    const id = db.enqueueTask({ type: 'sync_jobs', includeClosed: false })!;
    db.markTaskRunning(id);
    expect(db.resetStaleRunning()).toBe(1);
    const t = db.getTask(id)!;
    expect(t.status).toBe('pending');
    expect(t.attempts).toBe(0);
  });

  it('cancels pending tasks by job', () => {
    const db = seed();
    db.enqueueTask({ type: 'fetch_application', jobId: 'j1', applicationId: 'a1', downloadResume: true });
    db.enqueueTask({ type: 'fetch_application', jobId: 'j1', applicationId: 'a2', downloadResume: true });
    expect(db.cancelTasks({ jobId: 'j1' })).toBe(2);
    expect(db.taskCounts().cancelled).toBe(2);
  });
});

describe('toFtsQuery', () => {
  it('quotes terms and adds prefix matching', () => {
    expect(toFtsQuery('senior "python" dev*')).toBe('"senior"* "python"* "dev"*');
    expect(toFtsQuery('   ')).toBe('""');
  });
});

describe('cancelling a running task', () => {
  it('marks running tasks cancelled and a later requeue does not bring them back', () => {
    const db = new Db(':memory:');
    db.upsertJob({ jobId: 'j9', title: 'Closed role', status: 'closed', url: 'https://www.linkedin.com/hiring/jobs/j9/applicants/', syncedAt: now });
    const id = db.enqueueTask({ type: 'sync_applicants', jobId: 'j9', pagesPerRun: 12 })!;
    db.markTaskRunning(id);
    expect(db.taskStatus(id)).toBe('running');
    expect(db.cancelTasks({ jobId: 'j9' })).toBe(1);
    expect(db.taskStatus(id)).toBe('cancelled');
    db.requeueTask(id);
    expect(db.taskStatus(id)).toBe('cancelled');
  });
});

describe('applicantIdsByName', () => {
  it('matches stored names case-insensitively within a job', () => {
    const db = seed();
    expect(db.applicantIdsByName('j1', 'ada lovelace')).toEqual(['a1']);
    expect(db.applicantIdsByName('j1', 'Nobody Here')).toEqual([]);
    expect(db.applicantIdsByName('other', 'Ada Lovelace')).toEqual([]);
  });
});
