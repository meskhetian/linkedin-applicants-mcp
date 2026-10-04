import { describe, expect, it } from 'vitest';
import { defaultPacing } from '../src/config.js';
import { Humanizer, SLOW_MOVE_MS, bezierPath, randInt, sampleLogNormal } from '../src/browser/humanize.js';

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('sampleLogNormal', () => {
  it('stays within [min, max] and centers near the median', () => {
    const rng = seeded(42);
    const spec = { minMs: 1000, medianMs: 3000, maxMs: 12000 };
    const xs = Array.from({ length: 5000 }, () => sampleLogNormal(spec, rng));
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(spec.minMs);
      expect(x).toBeLessThanOrEqual(spec.maxMs);
    }
    const sorted = [...xs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    expect(median).toBeGreaterThan(2400);
    expect(median).toBeLessThan(3600);
    // right-skewed: mean above median
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean).toBeGreaterThan(median);
    // not degenerate: clipping should affect only a small tail
    const clipped = xs.filter((x) => x === spec.minMs || x === spec.maxMs).length;
    expect(clipped / xs.length).toBeLessThan(0.08);
  });

  it('handles degenerate specs without throwing', () => {
    expect(sampleLogNormal({ minMs: 100, medianMs: 100, maxMs: 100 })).toBeGreaterThanOrEqual(100);
    expect(sampleLogNormal({ minMs: 500, medianMs: 100, maxMs: 200 })).toBeGreaterThanOrEqual(500);
  });
});

describe('bezierPath', () => {
  it('ends exactly at the target and has the requested number of steps', () => {
    const pts = bezierPath({ x: 0, y: 0 }, { x: 400, y: 120 }, 25, seeded(7));
    expect(pts).toHaveLength(25);
    expect(pts[24]).toEqual({ x: 400, y: 120 });
  });

  it('is not a straight line', () => {
    const pts = bezierPath({ x: 0, y: 0 }, { x: 500, y: 0 }, 40, seeded(3));
    const maxDev = Math.max(...pts.map((p) => Math.abs(p.y)));
    expect(maxDev).toBeGreaterThan(2);
  });
});

describe('randInt', () => {
  it('is inclusive of both bounds', () => {
    const rng = seeded(1);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(randInt(3, 5, rng));
    expect([...seen].sort()).toEqual([3, 4, 5]);
  });
});

describe('Humanizer.moveTo with a starved window', () => {
  const pacing = () => defaultPacing('normal');
  function fakePage(moveMs: number) {
    const moves: Array<{ x: number; y: number }> = [];
    const page = {
      viewportSize: () => ({ width: 1440, height: 900 }),
      mouse: {
        move: async (x: number, y: number) => {
          moves.push({ x, y });
          if (moveMs) await new Promise((r) => setTimeout(r, moveMs));
        },
      },
    };
    return { page: page as never, moves };
  }

  it('keeps the full curved path when Chrome answers quickly', async () => {
    const h = new Humanizer(pacing, () => 0.5);
    const { page, moves } = fakePage(0);
    await h.moveTo(page, 100, 100); // first move sets the cursor near the centre
    moves.length = 0;
    await h.moveTo(page, 1300, 800);
    expect(moves.length).toBeGreaterThan(20);
    expect(moves.at(-1)).toEqual({ x: 1300, y: 800 });
  });

  it('finishes in a few larger steps once a single move is slow', async () => {
    const h = new Humanizer(pacing, () => 0.5);
    const { page, moves } = fakePage(SLOW_MOVE_MS + 30);
    await h.moveTo(page, 100, 100);
    moves.length = 0;
    await h.moveTo(page, 1300, 800);
    expect(moves.length).toBeLessThanOrEqual(3);
    expect(moves.at(-1)).toEqual({ x: 1300, y: 800 });
  });
});
