import { describe, expect, it } from 'vitest';
import { findDetailPanePath } from '../src/linkedin/application.js';

/** A minimal element tree with the DOM members findDetailPanePath uses. */
class El {
  parentElement: El | null = null;
  children: El[] = [];
  constructor(
    public tagName: string,
    private attrs: Record<string, string> = {},
    private ownText = '',
  ) {}
  add(...kids: El[]): this {
    for (const k of kids) {
      k.parentElement = this;
      this.children.push(k);
    }
    return this;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  get textContent(): string {
    return [this.ownText, ...this.children.map((c) => c.textContent)].filter(Boolean).join('\n');
  }
  get innerText(): string {
    return this.textContent;
  }
  private all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  private matches(sel: string): boolean {
    if (sel === 'a') return this.tagName === 'A';
    if (sel === 'a[href*="/in/"]') return this.tagName === 'A' && (this.attrs.href ?? '').includes('/in/');
    if (sel === 'a[componentkey^="paginatedApplicantCard-"]') return this.tagName === 'A' && (this.attrs.componentkey ?? '').startsWith('paginatedApplicantCard-');
    throw new Error(`selector not supported in the fake: ${sel}`);
  }
  querySelectorAll(sel: string): El[] {
    return this.all().filter((e) => e.matches(sel));
  }
  querySelector(sel: string): El | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

const div = (text = '') => new El('DIV', {}, text);
const summary = 'Qualifications\n' + 'Ten years running operations for venture-backed companies across three continents. '.repeat(6);

function page(paneText: string) {
  const body = new El('BODY');
  const html = new El('HTML').add(body);
  const list = div().add(
    new El('A', { componentkey: 'paginatedApplicantCard-111', href: '/hiring/applicants/?applicationId=111' }, 'Grace Hopper\nApplied on: 9/19/2026'),
    new El('A', { componentkey: 'paginatedApplicantCard-222', href: '/hiring/applicants/?applicationId=222' }, 'Ada Lovelace\nApplied on: 9/20/2026'),
  );
  const header = div().add(new El('A', { href: 'https://www.linkedin.com/in/dana/' }, 'Dana Whitfield'), div('Applied 3d ago'));
  const profile = div().add(new El('A', { href: 'https://www.linkedin.com/in/dana/', 'data-view-name': 'hiring-applicant-view-profile' }, 'View full profile'));
  const pane = div().add(header, profile, div(paneText));
  const layout = div().add(list, div().add(pane));
  body.add(div('Hiring Pro'), new El('MAIN').add(layout));
  return { doc: html as unknown as Document, pane };
}

describe('findDetailPanePath', () => {
  it('returns a plain CSS path to the innermost pane with the header and summary', () => {
    const { doc } = page(summary);
    expect(findDetailPanePath(doc)).toBe('body > main:nth-child(2) > div:nth-child(1) > div:nth-child(2) > div:nth-child(1)');
  });

  it('never climbs into the container that also holds the applicant list', () => {
    const { doc } = page('short');
    // the pane is under 400 characters: its innermost qualifying div wins, not the list and detail layout
    expect(findDetailPanePath(doc)).toBe('body > main:nth-child(2) > div:nth-child(1) > div:nth-child(2) > div:nth-child(1)');
  });

  it('returns null without a View full profile link', () => {
    const body = new El('BODY').add(div('Hiring Pro'));
    new El('HTML').add(body);
    expect(findDetailPanePath(body.parentElement as unknown as Document)).toBeNull();
  });
});
