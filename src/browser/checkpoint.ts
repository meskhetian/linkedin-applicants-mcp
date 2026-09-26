import type { CheckpointInfo } from '../types.js';

/** URL paths LinkedIn sends you to when it wants a human. */
export const BLOCKER_URL =
  /^https?:\/\/(www\.)?linkedin\.com\/(checkpoint\/|challenge\/|authwall|uas\/login|uas\/consumer-email-challenge|login(\/|\?|$)|signup)/i;

const TEXT_SIGNALS: Array<{ re: RegExp; kind: CheckpointInfo['kind']; message: string }> = [
  { re: /let'?s do a quick security check|security verification|verify (that )?you'?re (a )?human/i, kind: 'security_verification', message: 'Security verification page' },
  { re: /captcha|puzzle|are you a robot/i, kind: 'captcha', message: 'CAPTCHA / puzzle challenge' },
  { re: /unusual activity|we'?ve restricted your account|your account has been (temporarily )?restricted/i, kind: 'unusual_activity', message: 'Unusual activity / account restriction notice' },
  { re: /you'?ve reached the (commercial use|weekly|monthly) limit|reached the limit/i, kind: 'rate_limited', message: 'Usage limit banner' },
  { re: /sign in to linkedin|join linkedin|welcome back/i, kind: 'login', message: 'Login page' },
];

/**
 * Classify the current page. `bodyText` is optional (first ~5k chars of body innerText) and only
 * consulted when the URL alone is not conclusive.
 */
export function detectCheckpoint(url: string, bodyText?: string): CheckpointInfo | null {
  if (BLOCKER_URL.test(url)) {
    const lower = url.toLowerCase();
    if (lower.includes('/checkpoint/') || lower.includes('/challenge/')) {
      const hit = bodyText ? TEXT_SIGNALS.find((s) => s.re.test(bodyText)) : undefined;
      return { kind: hit?.kind ?? 'security_verification', url, message: hit?.message ?? 'LinkedIn checkpoint page' };
    }
    return { kind: 'login', url, message: 'Redirected to login / authwall' };
  }
  if (bodyText) {
    // Only trust strong signals off-URL (avoid false positives from feed posts mentioning "captcha").
    const strong = TEXT_SIGNALS.filter((s) => s.kind === 'unusual_activity' || s.kind === 'rate_limited').find((s) => s.re.test(bodyText.slice(0, 4000)));
    if (strong) return { kind: strong.kind, url, message: strong.message };
  }
  return null;
}

export type VoyagerHealth =
  | 'ok'
  | 'rate-limited' // 429, honour retry-after; stop for hours
  | 'edge-bot-block' // 999, LinkedIn edge said no
  | 'session-or-permission' // 401/403
  | 'endpoint-retired' // 410 / 404, try the next decoration / endpoint
  | 'login-wall' // HTML where JSON was expected
  | 'session-revoked';

export function classifyVoyagerResponse(status: number, contentType: string, setCookie = ''): VoyagerHealth {
  if (status === 999) return 'edge-bot-block';
  if (status === 429) return 'rate-limited';
  if (status === 401 || status === 403) return 'session-or-permission';
  if (status === 410 || status === 404 || status === 400) return 'endpoint-retired';
  if ((status === 301 || status === 302) && /li_at="?delete me/i.test(setCookie)) return 'session-revoked';
  if (status === 200 && /text\/html/i.test(contentType)) return 'login-wall';
  return 'ok';
}

/** Is the health value something that should pause the whole queue for a human? */
export function isHardBlock(h: VoyagerHealth): boolean {
  return h === 'edge-bot-block' || h === 'session-or-permission' || h === 'login-wall' || h === 'session-revoked';
}
