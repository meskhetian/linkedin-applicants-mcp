import { describe, expect, it } from 'vitest';
import { EntityGraph, normalizeVoyagerProfile, toDateRange, type VoyagerResponse } from '../src/linkedin/voyager.js';

const P = 'urn:li:fsd_profile:ACoAAA';
const T = (s: string) => `com.linkedin.voyager.dash.${s}`;

const skill = (n: number, name: string) => ({ entityUrn: `urn:li:fsd_skill:${n}`, $type: T('identity.profile.Skill'), name });

const full: VoyagerResponse = {
  data: { '*elements': [P] },
  included: [
    {
      entityUrn: P,
      $type: T('identity.profile.Profile'),
      firstName: 'Ada',
      lastName: 'Lovelace',
      publicIdentifier: 'ada',
      headline: 'Analytical Engine Programmer',
      summary: 'I write notes.',
      locationName: 'London',
      geoLocation: { '*geo': 'urn:li:fsd_geo:1' },
      '*industry': 'urn:li:fsd_industry:4',
      '*profilePositionGroups': 'urn:li:collectionResponse:pg',
      '*profileEducations': 'urn:li:collectionResponse:edu',
      '*profileSkills': 'urn:li:collectionResponse:skills',
      '*profileLanguages': 'urn:li:collectionResponse:lang',
      profilePicture: {
        displayImageReference: {
          vectorImage: { rootUrl: 'https://media.licdn.com/dms/image/x/', artifacts: [{ width: 100, fileIdentifyingUrlPathSegment: '100.jpg' }, { width: 400, fileIdentifyingUrlPathSegment: '400.jpg' }] },
        },
      },
    },
    { entityUrn: 'urn:li:fsd_geo:1', $type: T('common.Geo'), defaultLocalizedName: 'London, England, United Kingdom' },
    { entityUrn: 'urn:li:fsd_industry:4', $type: T('common.Industry'), name: 'Computing' },
    { entityUrn: 'urn:li:collectionResponse:pg', '*elements': ['urn:li:fsd_profilePositionGroup:1'], paging: { total: 1 } },
    { entityUrn: 'urn:li:fsd_profilePositionGroup:1', $type: T('identity.profile.PositionGroup'), companyName: 'Babbage & Co', '*company': 'urn:li:fsd_company:9', '*profilePositionInPositionGroup': 'urn:li:collectionResponse:pos' },
    { entityUrn: 'urn:li:fsd_company:9', $type: T('organization.Company'), name: 'Babbage & Co', url: 'https://www.linkedin.com/company/babbage/' },
    { entityUrn: 'urn:li:collectionResponse:pos', '*elements': ['urn:li:fsd_profilePosition:1', 'urn:li:fsd_profilePosition:2'], paging: { total: 2 } },
    { entityUrn: 'urn:li:fsd_profilePosition:1', $type: T('identity.profile.Position'), title: 'Lead Programmer', dateRange: { start: { year: 1843, month: 1 } }, description: 'Notes on the engine', locationName: 'London', '*employmentType': 'urn:li:fsd_employmentType:1' },
    { entityUrn: 'urn:li:fsd_profilePosition:2', $type: T('identity.profile.Position'), title: 'Programmer', dateRange: { start: { year: 1840, month: 6 }, end: { year: 1842, month: 12 } } },
    { entityUrn: 'urn:li:fsd_employmentType:1', $type: T('common.EmploymentType'), name: 'Full-time' },
    { entityUrn: 'urn:li:collectionResponse:edu', '*elements': ['urn:li:fsd_profileEducation:1'], paging: { total: 1 } },
    { entityUrn: 'urn:li:fsd_profileEducation:1', $type: T('identity.profile.Education'), schoolName: 'Home tutoring', degreeName: 'Mathematics', dateRange: { start: { year: 1830 }, end: { year: 1835 } } },
    { entityUrn: 'urn:li:collectionResponse:skills', '*elements': ['urn:li:fsd_skill:1', 'urn:li:fsd_skill:2'], paging: { total: 4 } },
    skill(1, 'Mathematics'),
    skill(2, 'Poetry'),
    { entityUrn: 'urn:li:collectionResponse:lang', '*elements': ['urn:li:fsd_profileLanguage:1'], paging: { total: 1 } },
    { entityUrn: 'urn:li:fsd_profileLanguage:1', $type: T('identity.profile.Language'), name: 'English', proficiency: 'NATIVE_OR_BILINGUAL' },
  ],
};

const skillsTopUp: VoyagerResponse = {
  data: { '*elements': ['urn:li:fsd_skill:1', 'urn:li:fsd_skill:2', 'urn:li:fsd_skill:3', 'urn:li:fsd_skill:4'], paging: { total: 4 } },
  included: [skill(1, 'Mathematics'), skill(2, 'Poetry'), skill(3, 'Logic'), skill(4, 'French')],
};

describe('EntityGraph', () => {
  it('follows *field pointers and collections', () => {
    const g = new EntityGraph(full);
    const p = g.rootElements()[0]!;
    expect(p.firstName).toBe('Ada');
    expect(g.ref(p, 'industry')?.name).toBe('Computing');
    const skills = g.collection(p, 'profileSkills');
    expect(skills.elements.map((s) => s.name)).toEqual(['Mathematics', 'Poetry']);
    expect(skills.total).toBe(4);
    expect(g.ofTypeSuffix('.identity.profile.Position')).toHaveLength(2);
  });
});

describe('normalizeVoyagerProfile', () => {
  it('maps the entity graph to our Profile type, preferring top-ups for truncated sections', () => {
    const profile = normalizeVoyagerProfile({ full, extra: [{ route: 'profileSkills', json: skillsTopUp }], usedDecoration: 'deco-101', profileUrn: P, requests: 2 }, 'https://www.linkedin.com/in/ada/');
    expect(profile.fullName).toBe('Ada Lovelace');
    expect(profile.vanityName).toBe('ada');
    expect(profile.headline).toBe('Analytical Engine Programmer');
    expect(profile.location).toBe('London, England, United Kingdom');
    expect(profile.industry).toBe('Computing');
    expect(profile.about).toBe('I write notes.');
    expect(profile.photoUrl).toBe('https://media.licdn.com/dms/image/x/400.jpg');
    expect(profile.experience).toHaveLength(2);
    expect(profile.experience[0]).toMatchObject({ title: 'Lead Programmer', company: 'Babbage & Co', employmentType: 'Full-time', location: 'London', companyUrl: 'https://www.linkedin.com/company/babbage/' });
    expect(profile.experience[0]!.dates).toMatchObject({ start: '1843-01', isCurrent: true });
    expect(profile.experience[1]!.dates).toMatchObject({ start: '1840-06', end: '1842-12', isCurrent: false });
    expect(profile.education[0]).toMatchObject({ school: 'Home tutoring', degree: 'Mathematics' });
    expect(profile.education[0]!.dates?.text).toBe('1830 - 1835');
    expect(profile.skills).toEqual(['Mathematics', 'Poetry', 'Logic', 'French']);
    expect(profile.languages).toEqual([{ name: 'English', proficiency: 'NATIVE_OR_BILINGUAL' }]);
    expect(profile.source).toBe('voyager');
    expect(profile.raw).toMatchObject({ usedDecoration: 'deco-101', requests: 2 });
  });

  it('throws on schema drift', () => {
    expect(() => normalizeVoyagerProfile({ full: { data: {}, included: [{ entityUrn: 'urn:li:x', $type: 'Other' }] }, extra: [], usedDecoration: 'd', requests: 1 }, 'u')).toThrow(/schema drift/);
  });
});

describe('toDateRange', () => {
  it('formats ranges', () => {
    expect(toDateRange({ start: { year: 2020, month: 3 } })).toEqual({ start: '2020-03', end: undefined, isCurrent: true, text: 'Mar 2020 - Present' });
    expect(toDateRange({ start: { year: 2018 }, end: { year: 2019, month: 11 } })).toEqual({ start: '2018', end: '2019-11', isCurrent: false, text: '2018 - Nov 2019' });
    expect(toDateRange(undefined)).toBeUndefined();
  });
});
