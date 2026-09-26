import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { clearDownloadHistory, ensureChromePreferences, parseSingletonLockPid, profileLockHolder } from '../src/browser/session.js';

describe('ensureChromePreferences', () => {
  it('keeps PDFs in the viewer, silences download prompts and clears the crash flag', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'li-prefs-'));
    fs.mkdirSync(path.join(dir, 'Default'));
    fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ plugins: { always_open_pdf_externally: true }, profile: { exit_type: 'Crashed', exited_cleanly: false }, other: 1 }));
    ensureChromePreferences(dir, path.join(dir, 'downloads'));
    const prefs = JSON.parse(fs.readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8')) as Record<string, Record<string, unknown>>;
    expect(prefs.plugins!.always_open_pdf_externally).toBe(false);
    expect(prefs.download!.prompt_for_download).toBe(false);
    expect(prefs.profile!.exit_type).toBe('Normal');
    expect(prefs.profile!.exited_cleanly).toBe(true);
    expect(prefs.other).toBe(1);
    expect(fs.existsSync(path.join(dir, 'First Run'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('clearDownloadHistory', () => {
  it('empties the download tables and leaves everything else', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'li-hist-'));
    fs.mkdirSync(path.join(dir, 'Default'));
    const db = new DatabaseSync(path.join(dir, 'Default', 'History'));
    db.exec("CREATE TABLE downloads(id INTEGER PRIMARY KEY, target_path TEXT); CREATE TABLE downloads_url_chains(id INTEGER, url TEXT); CREATE TABLE downloads_slices(download_id INTEGER); CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT)");
    db.exec("INSERT INTO downloads VALUES (1, '/x/resume.pdf'); INSERT INTO downloads_url_chains VALUES (1, 'https://example.test/a'); INSERT INTO downloads_slices VALUES (1); INSERT INTO urls VALUES (1, 'https://example.test/')");
    db.close();
    expect(clearDownloadHistory(dir)).toBe(3);
    const check = new DatabaseSync(path.join(dir, 'Default', 'History'), { readOnly: true });
    expect(check.prepare('SELECT count(*) c FROM downloads').get()).toEqual({ c: 0 });
    expect(check.prepare('SELECT count(*) c FROM urls').get()).toEqual({ c: 1 });
    check.close();
    expect(clearDownloadHistory(dir)).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op without a History database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'li-nohist-'));
    expect(clearDownloadHistory(dir)).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('profile lock', () => {
  it('parses the pid Chrome writes into SingletonLock', () => {
    expect(parseSingletonLockPid('MacBook-Pro-6.local-50715')).toBe(50715);
    expect(parseSingletonLockPid('host-with-dashes.local-7')).toBe(7);
    expect(parseSingletonLockPid('garbage')).toBeUndefined();
  });

  it('ignores a stale lock and reports a live holder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'li-lock-'));
    expect(profileLockHolder(dir)).toBeUndefined();
    fs.symlinkSync('host-999999', path.join(dir, 'SingletonLock'));
    expect(profileLockHolder(dir)).toBeUndefined();
    fs.unlinkSync(path.join(dir, 'SingletonLock'));
    fs.symlinkSync(`host-${process.ppid}`, path.join(dir, 'SingletonLock'));
    expect(profileLockHolder(dir)).toBe(process.ppid);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
