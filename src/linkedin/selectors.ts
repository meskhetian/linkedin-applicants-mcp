/**
 * Every selector we rely on, in one place, as ordered candidate lists.
 *
 * LinkedIn runs two DOM generations side by side (2026): the legacy Ember/artdeco markup with
 * stable BEM classes, and the new server-driven UI (SDUI / React Server Components) with hashed
 * class names where only data-view-name, componentkey, aria-label, role and text survive deploys.
 * Detect with `detectGeneration()` and read `SEL[gen]`. Text-based fallbacks (getByText / innerText)
 * are always the last resort, and every scraper stores raw text so parsers can be fixed offline.
 */

export type Generation = 'legacy' | 'sdui';

export interface SelectorSet {
  loggedIn: string[];
  jobs: {
    /** A posted-job card in /my-items/posted-jobs/ */
    card: string[];
    /** Anchor inside the card that links to /hiring/jobs/<id>/ or /jobs/view/<id>/ */
    link: string[];
    title: string[];
    /** Text like "Active", "Closed", "Paused", "Draft" */
    status: string[];
    /** Text like "1,234 applicants" */
    applicantCount: string[];
    /** Tab / pill to switch between open and closed jobs */
    closedTab: string[];
    /** Load more / next page in the list */
    showMore: string[];
  };
  applicants: {
    card: string[];
    name: string[];
    headline: string[];
    location: string[];
    appliedAgo: string[];
    detailLink: string[];
    /** Numeric page buttons; use with aria-label "Page N" */
    pageButton: (n: number) => string;
    nextButton: string[];
    /** Header text "N applicants" */
    totalCount: string[];
    /** Ratings filter dropdown trigger and its "Not a fit" option (hidden by default!) */
    ratingsFilter: string[];
    ratingsNotAFitOption: string[];
    ratingsApply: string[];
    /** Applicant list container to scroll for lazy-loading */
    listContainer: string[];
    /** "Show more" control of the infinite-scroll (Hiring Pro) list */
    showMore: string[];
    /** Hiring Pro: switch from the default "Top fit" view to all applicants */
    allApplicantsFilter: string[];
    /** Hiring Pro: the currently selected page indicator (legacy artdeco) */
    currentPage: string[];
  };
  detail: {
    panel: string[];
    name: string[];
    headline: string[];
    location: string[];
    appliedAgo: string[];
    profileLink: string[];
    /** "More" button in the header that reveals email/phone */
    moreButton: string[];
    /** Hiring Pro: explicit "Contact" button in the detail pane */
    contactButton: string[];
    contactItems: string[];
    /** Any element that exposes an email / phone text */
    contactText: string[];
    /** Button/link that opens the resume viewer */
    resumeButton: string[];
    /** Legacy inline attachment with direct href */
    resumeAttachment: string[];
    /** Legacy: direct "Download resume" link / menu item */
    downloadResumeLink: string[];
    /** Download control inside the viewer */
    downloadButton: string[];
    /** Viewer frame / embed / object whose src is the file */
    viewerFrame: string[];
    dismiss: string[];
    /** Rating controls */
    ratingGoodFit: string[];
    ratingMaybe: string[];
    ratingNotAFit: string[];
    /** Screening questions section */
    screeningSection: string[];
    screeningQuestion: string[];
    screeningAnswer: string[];
  };
  profile: {
    main: string[];
    name: string[];
    headline: string[];
    location: string[];
    about: string[];
    moreButton: string[];
    saveToPdf: string[];
    /** Items in a /details/<section>/ list */
    detailsItem: string[];
    contactDialog: string[];
    openToWork: string[];
  };
}

const LEGACY: SelectorSet = {
  loggedIn: ['nav a[href*="/feed"]', 'nav a[href*="/mynetwork"]', 'button:has-text("Home")', '.global-nav__me', 'img.global-nav__me-photo'],
  jobs: {
    card: ['.workflow-results-container li', 'ul.reusable-search__entity-result-list > li', '.entity-result', 'li.reusable-search__result-container', '.job-card-container'],
    link: ['a[href*="/hiring/jobs/"]', 'a[href*="/jobs/view/"]', 'a.app-aware-link'],
    title: ['.entity-result__title-text', '.job-card-list__title', 'a[href*="/jobs/"] span[aria-hidden="true"]', 'h3', 'strong'],
    status: ['.entity-result__badge-text', '.job-card-container__footer-item', '.t-black--light'],
    applicantCount: ['.entity-result__insights', '.job-card-container__footer-item', 'span:has-text("applicant")'],
    closedTab: ['a[href*="jobState=CLOSED"]', 'button:has-text("Closed")', '[role="tab"]:has-text("Closed")'],
    showMore: ['button.scaffold-finite-scroll__load-button', 'button:has-text("Show more results")', '.artdeco-pagination__button--next:not([disabled])'],
  },
  applicants: {
    card: ['.hiring-applicants__list-item', 'li.hiring-applicants__list-item', '.hiring-people-card'],
    name: ['.hiring-people-card__title', '.artdeco-entity-lockup__title'],
    headline: ['.artdeco-entity-lockup__metadata:first-of-type', '.hiring-people-card__subtitle'],
    location: ['.artdeco-entity-lockup__metadata:nth-of-type(2)'],
    appliedAgo: ['.hiring-applicant-insights__separator', '.hiring-people-card__applied-time'],
    detailLink: ['a[href*="/applicants/"][href*="/detail"]', 'a.hiring-people-card__link', 'a[href*="/applicants/"]'],
    pageButton: (n) => `button[aria-label="Page ${n}"]`,
    nextButton: ['.artdeco-pagination__button--next:not([disabled])', 'button[aria-label*="Next"]:not([disabled])'],
    totalCount: ['.hiring-applicants__header-title', 'h1:has-text("applicant")', 'h2:has-text("applicant")', ':text-matches("\\\\d[\\\\d,.]* applicants?", "i")'],
    ratingsFilter: ['button:has-text("Ratings")', 'button[aria-label*="Rating"]', '.hiring-applicants-filters button:has-text("Rating")'],
    ratingsNotAFitOption: ['label:has-text("Not a fit")', 'input[type="checkbox"][value*="NOT_A_FIT"]', '[role="option"]:has-text("Not a fit")', 'li:has-text("Not a fit") input'],
    ratingsApply: ['button:has-text("Show results")', 'button:has-text("Apply")', 'button[aria-label*="Apply"]'],
    listContainer: ['.hiring-applicants__list', 'ul.hiring-applicants__list-container', 'main'],
    showMore: ['button:has-text("Show more")', 'button.scaffold-finite-scroll__load-button', 'button:has-text("Load more")'],
    allApplicantsFilter: ['[role="tab"]:has-text("All applicants")', 'button:has-text("All applicants")', 'a:has-text("All applicants")'],
    currentPage: ['button[aria-current="true"][aria-label^="Page"]', 'li.artdeco-pagination__indicator--number.active button', '.artdeco-pagination__indicator--number.selected button'],
  },
  detail: {
    panel: ['#hiring-detail-root', '.hiring-applicant-header', '.hiring-applicant-detail', 'main'],
    name: ['.hiring-applicant-header h1', '.hiring-applicant-header__name', 'main h1'],
    headline: ['.hiring-applicant-header__headline', '.hiring-applicant-header .t-16'],
    location: ['.hiring-applicant-header__location', '.hiring-applicant-header .t-14.t-black--light'],
    appliedAgo: ['.hiring-applicant-header__applied', ':text-matches("Applied \\\\d", "i")'],
    profileLink: ['.hiring-applicant-header a[href*="/in/"]', 'a[href*="/in/"]'],
    moreButton: ['.hiring-applicant-header-actions button[aria-label*="More"]', 'button.hiring-applicant-header-actions__more', 'button[aria-label="More actions"]', 'button:has-text("More")'],
    contactButton: ['button:has-text("Contact info")', 'button:has-text("Contact")'],
    contactItems: ['span.hiring-applicant-header-actions__more-content-dropdown-item-text', '.artdeco-dropdown__content-inner span'],
    contactText: [':text-matches("[\\\\w.+-]+@[\\\\w-]+\\\\.[\\\\w.-]+")', ':text-matches("\\\\+?\\\\d[\\\\d\\\\s().-]{7,}\\\\d")'],
    resumeButton: ['button:has-text("Resume")', 'a:has-text("Resume")', '.ui-attachment--doc a[href]'],
    resumeAttachment: ['div.ui-attachment.ui-attachment--doc a[href]', '.ui-attachment a[href]', 'a[href*="ambry"]', 'a[href*="/dms/"]'],
    downloadResumeLink: ['a[aria-label*="Download" i][aria-label*="resume" i]', 'a:has-text("Download resume")', '[role="menuitem"]:has-text("Download resume")', '.artdeco-dropdown__content :text-matches("Download resume", "i")'],
    downloadButton: ['button[aria-label*="Download"]', 'a[download]', 'a:has-text("Download")', 'button:has-text("Download")'],
    viewerFrame: ['iframe[src*="dms/"]', 'iframe[src*="ambry"]', 'iframe[src*=".pdf"]', '[role="dialog"] iframe', '[role="dialog"] embed', '[role="dialog"] object', 'embed[type="application/pdf"]'],
    dismiss: ['button[aria-label="Dismiss"]', 'button[aria-label="Close"]', '.artdeco-modal__dismiss', 'button[data-test-modal-close-btn]'],
    ratingGoodFit: ['button[aria-label*="Good fit"]', 'button:has-text("Good fit")'],
    ratingMaybe: ['button[aria-label*="Maybe"]', 'button:has-text("Maybe")'],
    ratingNotAFit: ['button[aria-label*="Not a fit"]', 'button:has-text("Not a fit")'],
    screeningSection: ['section:has-text("Screening question")', 'section:has-text("screening")', 'div:has(> h2:has-text("Screening"))'],
    screeningQuestion: ['.hiring-screening-questions__question', 'dt', 'h3', '.t-bold'],
    screeningAnswer: ['.hiring-screening-questions__answer', 'dd', 'p'],
  },
  profile: {
    main: ['main'],
    name: ['main h1', '.pv-top-card h1', 'h1.text-heading-xlarge'],
    headline: ['.pv-top-card .text-body-medium', 'main .text-body-medium.break-words'],
    location: ['.pv-top-card .text-body-small.inline.t-black--light.break-words', 'main .text-body-small.inline'],
    about: ['section:has(#about) .inline-show-more-text', 'section:has(#about) span[aria-hidden="true"]', '[data-view-name="profile-card"]:has-text("About")'],
    moreButton: ['main button[aria-label="More actions"]', 'main button:has-text("More")', 'main button:has-text("Resources")'],
    saveToPdf: ['[role="menuitem"]:has-text("Save to PDF")', 'div[aria-label="Save to PDF"]', 'text=/^Save to PDF$/'],
    detailsItem: ['.pvs-list__container .pvs-list__paged-list-item', 'main ul > li.artdeco-list__item', 'div[data-view-name="profile-component-entity"]', 'main ul > li'],
    contactDialog: ['dialog[open]', '[role="dialog"]', '.artdeco-modal__content'],
    openToWork: ['.pv-top-card-profile-picture img[title*="OPEN_TO_WORK"]', 'img[alt*="#OPEN_TO_WORK"]', ':text("Open to work")'],
  },
};

const SDUI: SelectorSet = {
  loggedIn: ['nav a[href*="/feed"]', 'a[href*="/mynetwork"]', 'header img[alt*="Photo of"]', 'button[aria-label*="Me"]', '[data-view-name="navigation-me"]'],
  jobs: {
    card: ['[data-view-name*="posted-job" i]', '[data-view-name*="job-card" i]', '[role="list"] > [role="listitem"]', 'main li:has(a[href*="/hiring/jobs/"])', 'main li:has(a[href*="/jobs/view/"])', '[componentkey]:has(a[href*="/hiring/jobs/"])'],
    link: ['a[href*="/hiring/jobs/"]', 'a[href*="/jobs/view/"]'],
    title: ['a[href*="/hiring/jobs/"] span', 'a[href*="/jobs/view/"] span', 'h3', 'strong', 'a[href*="/jobs/"]'],
    status: [':text-matches("^(Active|Closed|Paused|Draft|In review|Open)$", "i")', '[data-view-name*="status" i]'],
    applicantCount: [':text-matches("\\\\d[\\\\d,.]*\\\\s+applicants?", "i")'],
    closedTab: ['a[href*="jobState=CLOSED"]', '[role="tab"]:has-text("Closed")', 'button:has-text("Closed")', 'a:has-text("Closed")'],
    showMore: ['button:has-text("Show more")', 'button:has-text("Load more")', 'button[aria-label*="Next"]:not([disabled])', 'button:has-text("Next")'],
  },
  applicants: {
    card: [
      'a[componentkey^="paginatedApplicantCard-"]',
      '[role="listitem"]:has(a[href*="applicationId="])',
      'li:has(a[href*="applicationId="])',
      '[role="row"]:has(a[href*="applicationId="])',
      '[data-view-name*="applicant" i]:has(a[href*="applicationId="])',
      '[data-view-name*="applicant" i]:has(a[href*="/applicants/"])',
      '[role="list"] > [role="listitem"]:has(a[href*="/applicants/"])',
      'main li:has(a[href*="/applicants/"])',
      '[componentkey]:has(a[href*="/applicants/"])',
    ],
    name: ['a[href*="applicationId="] span', 'a[href*="/applicants/"] span', '[data-view-name*="name" i]', 'strong', 'h3', 'a[href*="applicationId="]', 'a[href*="/applicants/"]'],
    headline: ['[data-view-name*="headline" i]', 'p', 'span'],
    location: ['[data-view-name*="location" i]'],
    appliedAgo: [':text-matches("Applied (on)?\\\\s*:?", "i")', ':text-matches("\\\\d+\\\\s*(minute|hour|day|week|month)s?\\\\s*ago", "i")'],
    detailLink: ['a[componentkey^="paginatedApplicantCard-"]', 'a[href*="applicationId="]', 'a[href*="/applicants/"][href*="/detail"]', 'a[href*="/applicants/"]'],
    pageButton: (n) => `button[aria-label="Page ${n}"]`,
    nextButton: ['button[aria-label*="Next"]:not([disabled])', 'button:has-text("Next"):not([disabled])', 'a[aria-label*="Next"]'],
    totalCount: [':text-matches("\\\\d[\\\\d,.]*\\\\s+applicants?", "i")', 'h1', 'h2'],
    ratingsFilter: ['button:has-text("Rating")', 'button[aria-label*="Rating" i]', '[data-view-name*="rating" i] button'],
    ratingsNotAFitOption: ['label:has-text("Not a fit")', '[role="option"]:has-text("Not a fit")', '[role="menuitemcheckbox"]:has-text("Not a fit")', 'input[type="checkbox"] ~ *:has-text("Not a fit")'],
    ratingsApply: ['button:has-text("Show results")', 'button:has-text("Apply")', 'button:has-text("Done")'],
    listContainer: ['[role="list"]', 'main'],
    showMore: ['button:has-text("Show more")', 'button:has-text("Load more")', 'button:has-text("See more applicants")'],
    allApplicantsFilter: ['[role="tab"]:has-text("All applicants")', 'button:has-text("All applicants")', '[role="option"]:has-text("All applicants")', 'a[href*="rating=ALL"]'],
    currentPage: ['button[aria-current="true"][aria-label^="Page"]', '[aria-current="page"]'],
  },
  detail: {
    panel: ['[role="dialog"]:has(a[href*="/in/"])', '#hiring-detail-root', 'main', '[data-view-name*="applicant-detail" i]', '[data-view-name*="hiring-applicant" i]'],
    name: ['main h1', 'main h2', '[data-view-name*="applicant-name" i]', 'main a[href*="/in/"] span'],
    headline: ['[data-view-name*="headline" i]', 'main h1 + p', 'main h2 + p'],
    location: ['[data-view-name*="location" i]'],
    appliedAgo: [':text-matches("Applied\\\\s", "i")', ':text-matches("\\\\d+\\\\s*(minute|hour|day|week|month)s?\\\\s*ago", "i")'],
    profileLink: ['main a[href*="/in/"]', 'a[href*="/in/"]'],
    moreButton: ['main button[aria-label*="More" i]', 'button[data-view-name*="more" i]', 'main button:has-text("More")'],
    // The SDUI button's text content carries hidden helper text, so :text-is("Contact") misses it; the data-view-name is stable.
    contactButton: [
      'button[data-view-name="hiring-applicant-contact"]',
      'button[data-view-name*="contact" i]:not([data-view-name*="contact-"])',
      'button:has-text("Contact"):not(:has-text("Contacted"))',
      'button:has-text("Contact info")',
      'button[aria-label*="Contact" i]',
      '[role="tab"]:has-text("Contact")',
    ],
    contactItems: [
      '[data-view-name^="hiring-applicant-contact-"]',
      '[role="menu"] [role="menuitem"]',
      '[role="menu"] span',
      '[role="dialog"] span',
      '[role="tooltip"] span',
      'a[href^="mailto:"]',
      'a[href^="tel:"]',
    ],
    contactText: [':text-matches("[\\\\w.+-]+@[\\\\w-]+\\\\.[\\\\w.-]+")', 'a[href^="mailto:"]', 'a[href^="tel:"]', ':text-matches("\\\\+?\\\\d[\\\\d\\\\s().-]{7,}\\\\d")'],
    resumeButton: ['button[data-view-name="hiring-applicant-view-resume"]', 'button[data-view-name*="resume" i]', 'a[data-view-name*="resume" i]', 'button:has(svg#document-small)', 'button:has-text("Resume")', 'a:has-text("Resume")', 'button:has-text("View resume")'],
    resumeAttachment: ['a[href*="ambry"]', 'a[href*="/dms/"]', 'a[href*="mediaauth"]', 'a[href$=".pdf"]', 'a[href*=".pdf?"]'],
    downloadResumeLink: ['a[aria-label*="Download" i][aria-label*="resume" i]', 'a:has-text("Download resume")', '[role="menuitem"]:has-text("Download resume")'],
    downloadButton: ['button[aria-label*="Download" i]', 'a[aria-label*="Download" i]', 'button:has(svg#download-small)', 'a:has(svg#download-small)', 'a[download]', 'button:has-text("Download")', 'a:has-text("Download")'],
    viewerFrame: ['[role="dialog"] iframe', '[role="dialog"] embed', '[role="dialog"] object', 'iframe[src*="dms/"]', 'iframe[src*="ambry"]', 'iframe[src*="mediaauth"]', 'iframe[src*=".pdf"]', 'embed[type="application/pdf"]', 'object[type="application/pdf"]'],
    dismiss: ['button[aria-label="Dismiss"]', 'button[aria-label="Close"]', '[role="dialog"] button[aria-label*="Close" i]', '[role="dialog"] button[aria-label*="Dismiss" i]', '.artdeco-modal__dismiss', 'button[data-test-modal-close-btn]'],
    ratingGoodFit: ['button[aria-label*="Good fit" i]', 'button:has-text("Good fit")', '[role="radio"]:has-text("Good fit")'],
    ratingMaybe: ['button[aria-label*="Maybe" i]', 'button:has-text("Maybe")', '[role="radio"]:has-text("Maybe")'],
    ratingNotAFit: ['button[aria-label*="Not a fit" i]', 'button:has-text("Not a fit")', '[role="radio"]:has-text("Not a fit")'],
    screeningSection: ['section:has-text("Screening question")', '[data-view-name*="screening" i]', 'div:has(> h2:has-text("Screening"))', 'div:has(> h3:has-text("Screening"))'],
    screeningQuestion: ['[data-view-name*="question" i]', 'dt', 'h3', 'h4', 'strong'],
    screeningAnswer: ['[data-view-name*="answer" i]', 'dd', 'p', 'span'],
  },
  profile: {
    main: ['main'],
    name: ['main h1', 'main h2', '[data-view-name*="profile-top-card" i] h2', 'main a[href*="/in/"] h2'],
    headline: ['main h1 ~ p', 'main h2 ~ p', '[data-view-name*="headline" i]'],
    location: ['[data-view-name*="location" i]', 'main h2 ~ div p'],
    about: ['[data-testid="expandable-text-box"]', 'section:has-text("About") [data-testid*="expandable" i]', '[data-view-name*="about" i]'],
    moreButton: ['main button[aria-label="More actions"]', 'main button[aria-label*="More" i]', 'main button:has-text("More")', 'main button:has-text("Resources")'],
    saveToPdf: ['[role="menuitem"]:has-text("Save to PDF")', '[role="menu"] :text-matches("^Save to PDF$", "i")', 'text=/^Save to PDF$/'],
    detailsItem: ['main [role="list"] > [role="listitem"]', 'main ul > li', 'main li[componentkey]', 'div[data-view-name="profile-component-entity"]', '.pvs-list__paged-list-item'],
    contactDialog: ['dialog[open]', '[role="dialog"]', '.artdeco-modal__content'],
    openToWork: ['img[alt*="#OPEN_TO_WORK"]', ':text("Open to work")', '[data-view-name*="open-to-work" i]'],
  },
};

export const SEL: Record<Generation, SelectorSet> = { legacy: LEGACY, sdui: SDUI };

/** Legacy marker classes; if none is present (and/or the sdui_ver cookie is set) we are on SDUI. */
export const LEGACY_MARKERS = ['.hiring-applicants__list-item', '.pv-top-card', '.artdeco-entity-lockup__title', '.global-nav__me', '.reusable-search__result-container'];

/** Substrings of URLs whose responses we always record for offline parsing / endpoint discovery. */
export const CAPTURE_URL_HINTS = [
  '/voyager/api/hiring',
  '/voyager/api/talent',
  '/voyager/api/jobs',
  'jobApplication',
  'applicant',
  'voyagerHiring',
  'voyagerJobs',
  '/voyager/api/identity/dash/',
  '/voyager/api/identity/profiles/',
  '/voyager/api/graphql',
  'identityDashProfile',
  '/flagship-web/rsc-action/',
  '/flagship-web/in/',
  '/flagship-web/hiring/',
  'my-items/posted-jobs',
];
