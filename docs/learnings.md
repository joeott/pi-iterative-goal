# pi-iterative-goal Docs Bundle Handoff

Date: 2026-06-22
Branch: `refactor/autonomous-kernel-p0-p1`
Primary artifact: `ai_docs/user_guide/index.html`
PDF artifact: `ai_docs/user_guide/pdf/pi-iterative-goal-user-guide.pdf`

## What Changed

- Added a self-contained HTML user guide under `ai_docs/user_guide/`.
- Added local assets only: `assets/guide.css` and `assets/guide.js`.
- Added desktop and mobile Playwright screenshots:
  - `ai_docs/user_guide/screenshots/desktop.png`
  - `ai_docs/user_guide/screenshots/mobile.png`
- Added sandbox evidence:
  - `ai_docs/user_guide/sandbox-report.json`
  - `ai_docs/user_guide/sandbox-report.md`
- Added `scripts/user-guide-sandbox-validation.mjs` to validate docs, source inventory, mocked extension loading, mocked AWS CLI behavior, provider contracts, and negative policy cases.
- Generated an Acrobat-friendly PDF at `ai_docs/user_guide/pdf/pi-iterative-goal-user-guide.pdf`.

## Verified This Session

- `node scripts/user-guide-sandbox-validation.mjs`
  - Final result: 9 PASS, 0 WARN, 0 FAIL.
  - Includes `npm run validate`.
- Playwright wrapper visual QA:
  - Served the guide through a temporary local HTTP server on `127.0.0.1:8876`.
  - Captured desktop viewport at 1440x1100.
  - Captured mobile viewport at 390x1100.
  - Console health was clean on final desktop and mobile reloads: 0 errors, 0 warnings.
- Adobe handoff:
  - Generated PDF with Chrome headless.
  - Opened the PDF in `/Applications/Adobe Acrobat DC/Adobe Acrobat.app`.

## Important Boundaries

The sandbox deliberately avoids production side effects:

- No real AWS mutations.
- No real GitHub PR creation inside the harness tests.
- No cloud writes.
- Runtime checks use disposable temp repositories and mocked provider calls.

## Incompletely Tested Items

These should remain explicit in the PR and future work:

- Actual Pi interactive command flow was not exercised end-to-end in a live Pi session. The docs runner loads `dist/index.js` through a fake Pi API and verifies registration plus `goal_shell`, but it does not drive `/goal-start -> phase prompts -> evaluator -> /goal-authorize-release` in the real UI.
- `goal_git create_pr` was not tested against GitHub from an active harness run with a real `ReleaseAuthorization`; the docs runner covers policy denial for missing authorization and source-level inventory only.
- AWS coverage is mocked and read-only. It validates profile preflight and STS-style behavior through fake `pi.exec`; it does not verify real SSO profiles, session-manager-plugin behavior, or allowed mutating families.
- Browser, MCP, and vision providers are contract-checked only. They intentionally fail closed without configured backends.
- Network fetch behavior is policy/provider covered without performing live external fetches. Public DNS and redirect behavior should be rechecked if the provider is promoted for operational use.
- Visual QA covers first-viewport desktop/mobile screenshots. It does not include a full-page screenshot diff, PDF page-by-page visual QA, or cross-browser comparison.
- The generated PDF was opened in Acrobat but not manually page-reviewed for every section, table, or page break.
- Package install remains denied by policy; there is no approved lockfile-aware package install capability yet.
- CI status for the PR remains to be observed after push/PR creation.

## Next Session Checklist

1. Review the PR diff for accidental artifact bloat, especially `screenshots/*.png` and `pdf/*.pdf`.
2. Open `ai_docs/user_guide/index.html` in a browser and inspect lower sections beyond the first viewport.
3. Open `ai_docs/user_guide/pdf/pi-iterative-goal-user-guide.pdf` in Acrobat and scan page breaks/tables.
4. Run `node scripts/user-guide-sandbox-validation.mjs`.
5. Run `npm run validate` if a narrower validation proof is wanted apart from the docs runner.
6. After PR creation, check CI with `gh pr checks <number>`.
7. Decide whether future work should add a real Pi E2E harness for:
   - `/goal-start`
   - phase result reporting
   - evaluator handoff
   - `/goal-authorize-release`
   - `goal_git create_pr --dryRun`

## Local State Notes

- Pre-existing untracked files were intentionally left untouched:
  - `.pi/`
  - `ai_docs/context_004_merge_and_test_prompt.md`
  - `ai_docs/reviews/adversarial-slice-001.jsonl`
  - `ai_docs/reviews/slice-001.diff`
- New files intended for this PR are:
  - `ai_docs/user_guide/**`
  - `scripts/user-guide-sandbox-validation.mjs`
  - `docs/learnings.md`
