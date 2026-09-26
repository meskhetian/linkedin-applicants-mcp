import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Filesystem-safe, ASCII-ish file name component. */
export function safeName(input: string, max = 80): string {
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (s || 'file').slice(0, max);
}

export function jobDir(cfg: Config, jobId: string): string {
  return ensureDir(path.join(cfg.filesDir, 'jobs', safeName(jobId)));
}

export function applicantDir(cfg: Config, jobId: string, applicationId: string, fullName?: string): string {
  const base = fullName ? `${safeName(applicationId)}_${safeName(fullName, 40)}` : safeName(applicationId);
  return ensureDir(path.join(jobDir(cfg, jobId), base));
}

export function writeJson(file: string, data: unknown): string {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function extFromContentType(ct: string | undefined | null, fallback = 'pdf'): string {
  if (!ct) return fallback;
  const c = ct.toLowerCase();
  if (c.includes('pdf')) return 'pdf';
  if (c.includes('wordprocessingml')) return 'docx';
  if (c.includes('msword')) return 'doc';
  if (c.includes('rtf')) return 'rtf';
  if (c.includes('text/plain')) return 'txt';
  return fallback;
}

export function extFromFileName(name: string | undefined | null): string | undefined {
  if (!name) return undefined;
  const m = /\.([a-zA-Z0-9]{2,5})$/.exec(name.trim());
  return m?.[1]?.toLowerCase();
}
