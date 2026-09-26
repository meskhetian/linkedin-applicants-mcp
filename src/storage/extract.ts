import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Extract plain text from a resume file (PDF / DOCX / TXT). Returns '' on unsupported types
 * or extraction failure; never throws (the resume file itself is still stored).
 */
export async function extractResumeText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  try {
    const buf = await fs.readFile(filePath);
    if (ext === '.pdf') return await extractPdfText(buf);
    if (ext === '.docx') return await extractDocxText(buf);
    if (ext === '.txt' || ext === '.md' || ext === '.rtf') return normalizeWhitespace(buf.toString('utf8'));
    // Unknown extension: sniff PDF magic
    if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return await extractPdfText(buf);
    return '';
  } catch {
    return '';
  }
}

export async function extractPdfText(buf: Buffer): Promise<string> {
  const { extractText } = await import('unpdf');
  const { text } = await extractText(new Uint8Array(buf), { mergePages: true });
  return normalizeWhitespace(Array.isArray(text) ? text.join('\n') : String(text ?? ''));
}

export async function extractDocxText(buf: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const fn = (mammoth as unknown as { extractRawText?: typeof mammoth.extractRawText }).extractRawText ?? mammoth.default.extractRawText;
  const res = await fn({ buffer: buf });
  return normalizeWhitespace(res.value);
}

export function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
