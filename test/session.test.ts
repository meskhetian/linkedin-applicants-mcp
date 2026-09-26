import { describe, expect, it } from 'vitest';
import { decideLoggedIn } from '../src/browser/session.js';

describe('decideLoggedIn', () => {
  it('requires a linkedin url that is not a login/checkpoint page', () => {
    expect(decideLoggedIn({ url: 'https://www.linkedin.com/feed/', hasLiAt: true, navVisible: false })).toBe(true);
    expect(decideLoggedIn({ url: 'https://www.linkedin.com/feed/', hasLiAt: false, navVisible: true })).toBe(true);
    expect(decideLoggedIn({ url: 'https://www.linkedin.com/login', hasLiAt: true, navVisible: false })).toBe(false);
    expect(decideLoggedIn({ url: 'https://www.linkedin.com/checkpoint/challenge/x', hasLiAt: true, navVisible: true })).toBe(false);
    expect(decideLoggedIn({ url: 'about:blank', hasLiAt: true, navVisible: true })).toBe(false);
    expect(decideLoggedIn({ url: 'https://www.linkedin.com/jobs/view/1/', hasLiAt: false, navVisible: false })).toBe(false);
  });
});
