## What does this PR do?

<!-- One or two sentences. Link the issue: Fixes #123 -->

## Why?

<!-- Context a reviewer needs. For selector/pacing changes: what you saw on LinkedIn, on which date, in which
     DOM generation (legacy / sdui), and whether the old selectors are gone or merely reordered. -->

## How was it tested?

<!-- Commands run, LinkedIn dashboard(s) verified against (legacy / Hiring Pro) and when, anything not covered. -->

## Checklist

- [ ] `npm run typecheck`, `npm run build` and `npm test` pass locally.
- [ ] **Read-only on LinkedIn**: this change performs no rating, note, message, connection, apply or any other
      write action on LinkedIn, and does not loosen the pacing defaults or bypass checkpoints.
- [ ] **No personal data**: no real applicant names, contact details, ids, screenshots, resumes, raw snapshots
      or anything else from a data directory is included; fixtures use fictional people and companies.
- [ ] New or changed selectors are covered by a fixture-based test and dated with a comment in
      `src/linkedin/selectors.ts`.
- [ ] Tests are deterministic and offline (no network, no Chrome, injected clock/random where needed).
- [ ] README, `.env.example` and `CHANGELOG.md` ("Unreleased") updated if behaviour or configuration changed.
- [ ] If a tool was added or renamed, `EXPECTED_TOOLS` in `test/stdio-smoke.test.ts` was updated.
