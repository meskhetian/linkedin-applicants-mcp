import { describe, expect, it } from 'vitest';
import { NetworkCapture } from '../src/browser/capture.js';
import { silentLogger } from '../src/log.js';

/** A page that only records the response handler, and responses shaped like LinkedIn's. */
function fakePage() {
  let handler: ((r: unknown) => void) | undefined;
  const page = {
    on: (evt: string, h: (r: unknown) => void) => {
      if (evt === 'response') handler = h;
    },
    once: () => {},
    off: () => {},
  };
  const respond = (url: string, contentType: string, body: string) =>
    handler!({
      url: () => url,
      headers: () => ({ 'content-type': contentType }),
      status: () => 200,
      request: () => ({ method: () => 'GET', headers: () => ({}) }),
      body: async () => Buffer.from(body, 'utf8'),
    });
  return { page, respond };
}

describe('NetworkCapture memory budget', () => {
  it('keeps the total of kept bodies under the budget, dropping the oldest first', async () => {
    const cap = new NetworkCapture(silentLogger, { maxTotalBytes: 10 * 1024 * 1024 });
    const { page, respond } = fakePage();
    cap.attach(page as never);
    const big = 'x'.repeat(3 * 1024 * 1024); // a 3 MB list page, like LinkedIn's hiring documents
    for (let i = 0; i < 12; i++) respond(`https://www.linkedin.com/hiring/applicants/?jobId=1&start=${i * 25}`, 'text/html; charset=utf-8', big);
    await cap.drain();
    const { entries, bytes } = cap.stats();
    expect(bytes).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(entries).toBe(3);
    const kept = cap.all().map((e) => e.seq);
    expect(kept).toEqual([10, 11, 12]); // the newest three, in order
    expect(cap.since(11).map((e) => e.seq)).toEqual([12]);
  });

  it('counts a parsed JSON copy and still keeps a single oversized entry', async () => {
    const cap = new NetworkCapture(silentLogger, { maxTotalBytes: 1000 });
    const { page, respond } = fakePage();
    cap.attach(page as never);
    respond('https://www.linkedin.com/voyager/api/graphql?queryId=a', 'application/json', JSON.stringify({ a: 'y'.repeat(300) }));
    await cap.drain();
    expect(cap.stats().bytes).toBeGreaterThan(600); // body plus its parsed copy
    respond('https://www.linkedin.com/voyager/api/graphql?queryId=b', 'application/json', JSON.stringify({ b: 'z'.repeat(5000) }));
    await cap.drain();
    expect(cap.stats().entries).toBe(1); // the newest is kept even alone over budget
    expect((cap.all()[0]!.json as { b: string }).b.length).toBe(5000);
    cap.clear();
    expect(cap.stats()).toEqual({ entries: 0, bytes: 0 });
  });
});
