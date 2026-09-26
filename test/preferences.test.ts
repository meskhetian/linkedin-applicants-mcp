import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureChromePreferences } from '../src/browser/session.js';

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
