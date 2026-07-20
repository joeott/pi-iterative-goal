# pi-iterative-goal Docs Bundle Handoff

> This is the canonical durable-learning record. Runtime status belongs in
> state.md; the active contract and lane scoreboard belong in goal.md.

## 2026-07-20 — Exact-route and isolation hardening truths

- A run-pool boundary must be asynchronous and explicit. A new run cannot erase
  the prior registry while children may still be alive; it must fail closed until
  `shutdownRunAgentPools()` has been awaited.
- A worker is contained only when Pi starts with no built-in tools, exactly one
  tracked custom extension, a tracked-HEAD disposable worktree, one selected
  provider credential, path-safe read/write tools, enforced token/turn/cost/time
  budgets, and exact TERM-to-KILL ownership. Prompt instructions are not a boundary.
- Model telemetry may call a gate PASS only when that invocation had an output
  schema and returned schema-valid structured output with an exact response model.
  Unknown prices remain `null`; they are never inferred from a provider-reported
  aggregate. Prompt and response bytes belong only in digests, not metadata logs.
- Multi-process hash-chained logs need atomic lock ownership and nonce-checked
  stale-lock recovery. Retention must preserve receipts/evidence, reject unsafe
  owners or links, and cap only the managed runtime tree.
- On macOS, a deny-default Seatbelt process needs literal read access to the root
  vnode for dyld, canonical `/private/...` temporary paths, and the concrete
  Command Line Tools executable rather than the `/usr/bin/git` xcode-select shim.
  Capability probing must prove outside-read, outside-write, and network denial
  before a receipt can claim OS enforcement.
- Catalog presence, authenticated inference, structured output, and tool behavior
  are separate provider gates. The exact roster hash is
  `683bac3a4b8df5127c9c77a228288b8c87564e4a90089f8d70dd5181f76b9601`:
  Z.ai GLM 5.2, both Fireworks GLM 5.2 routes, and all three Cerebras routes passed
  live behavior; the exact Kimi K3, Sonnet 5, and Fable 5 OpenRouter names were
  catalog-valid but inference returned HTTP 401. No substitute route is a PASS.
- Runtime materialization may persist provider names and credential variable names,
  never credential values. Launchers remain offline by default and must reject
  extension/model/config overrides that weaken the exact-roster boundary.

---

## 2026-07-20 — Production-certification claim corrected

The earlier July 20 entry below is retained as historical evidence of what commit
`275b23d` reported, but its headline and `9/9 PASS` statement are **superseded**.
The run is useful partial evidence: it drove the real local Pi 0.75.5 RPC runtime
and made live Z.ai model calls in a disposable repository. It is not production
certification of campaigns C1–C4.

Durable corrections:

- All C1–C4 feature flags were off, so the run did not exercise real sharding,
  scheduling, concurrent writer isolation, merge-back, or delivered-HEAD release.
- The reported gate fail→success did not prove the same kernel-owned check changing
  from FAIL to PASS. Validation status could be authored by the model and then
  trusted by the release path.
- Reviewer output was degraded/schema-invalid and exceeded its configured response
  budget, but the scenario still passed. The printed `<30` model-call bound was not
  enforced; the run recorded 48 calls.
- A worker `process_restart` occurred. Child Pi processes could rediscover the
  parent extension and shared configuration, and cleanup used a broad process-name
  kill rather than exact owned process groups.
- The outside-write assertion compared selected temporary paths and Pi settings; it
  was not an operating-system-enforced proof that no external write occurred.
- The headless feature report combined fake/direct-handler workloads with a separate
  live-provider probe and was generated before C4. Those proof classes must remain
  separate and the report must be regenerated from the exact final HEAD.

Production certification now requires an isolated exact-HEAD runner, kernel-derived
signed verification, enforced budgets, exact cleanup, complete patch/delivery proof,
a private-socket tmux TUI run, real-model individual and combined flag scenarios,
fault/adversarial cases, and deterministic CI. Preserve the old artifacts, label them
superseded, and never rewrite them into stronger evidence.

---


## 2026-07-20 — Deployment-plan campaigns C0–C4 implemented and production-validated

Branch: `feat/deployment-plan-c0-c4` (spec: `docs/plan/pi-iterative-goal-deployment-plan_*`).
Primary new evidence: `ai_docs/prod_runtime_confirmation/run-2026-07-20T16-33-21-328Z-*`
(real-runtime confirmation, 9/9 PASS).

### What landed (all feature-flag OFF by default)

- **C0** `src/ui/phase-indicator.ts` — single goal/phase renderer; StateManager version counter; 1 Hz ticker.
- **C1** swarm wiring — `src/agents/roles.ts`, `src/agents/run-pool.ts`, `goal_subagent tasks[]/mode`, shardability gate, `subagent_started/finished` ledger events. Flag: `iterativeGoal.swarm.enabled`.
- **C2** sharder — `src/kernel/sharder.ts`, `src/domain/shard.ts`, `goal_post_shards`, spectral prior (Jacobi) + mandatory KL refinement, `shard_plan_proposed`/`shard_posted` events. Flag: `iterativeGoal.sharder.enabled`.
- **C3** scheduler — `src/kernel/scheduler.ts` HEFT ranks + telemetry-calibrated costs (MIN_COST_SAMPLES=2, no-telemetry → conservative fallback), contract-net-style award, `shard_claimed/completed/failed` events, error-cascade monitor, wired at plan→implement. Flag: `iterativeGoal.scheduler.enabled`.
- **C4** merge-back — `src/workspace/worktrees.ts` (integration branch `pi-ig/integration/<runId>`, scoped crash recovery, repair loop to `claimed`), `merge_proposed`/`merge_verified` events, judge-independence config (`iterativeGoal.judge`), evaluator shard gate. Flag: `iterativeGoal.mergeBack.enabled`.
- Monitor convention: `scripts/swarm-monitor-trace.mjs` + `ai_docs/swarm-monitor-convention.md` (6-min tracer daemon + 24-min supervisor wake; deterministic journal header).

### Verified this session

- `npm run build && npm run smoke` → 82/82 (29 pre-campaign + 53 new).
- `npm run evidence:headless` → 13 PASS / 30 coverage PASS; signed manifest `deliveredBytesVerified:true` (87 artifacts, run `headless-2026-07-20T13-16-35-625Z`).
- Production runtime confirmation (`scripts/prod-runtime-confirmation.mjs`, real `pi` CLI 0.75.5 in `--mode rpc` against a disposable temp repo, z.ai glm-5.2): **9/9 PASS** — goal start, typed plan, brokered shell, gate fail→success, adversarial review via goal_subagent, release-auth refusal before gates, release-auth success after gates, `goal_git create_pr --dryRun` (no real PR), no writes outside temp repo / no Pi settings drift. 48 model calls.
- `npm run review:prod-security:readonly` → 26/26 read-only commands; 6 findings all repeated (SEC-001..SEC-006, external unify infra, owned elsewhere), 0 new.
- Per-campaign adversarial + Ousterhout reviews: 3 blocker/high-class and ~30 medium/low findings, all remediated; records in `ai_docs/reviews/c{0..4}-*.json`.

### Newly closed items from the old incompletely-tested list

- Real-runtime `/goal-start → phases → evaluator → /goal-authorize-release` now exercised end-to-end (RPC mode, headless) — see production confirmation s1–s8.
- `goal_git create_pr` with a real `ReleaseAuthorization` covered in dry-run mode (s8).

### Findings discovered by production confirmation (follow-ups, not regressions)

- **pi 0.75.5 followUp stranding**: a followUp queued by an extension `agent_end` handler is not delivered until a new prompt starts a run (agent-loop drains followUps before firing `agent_end`). Interactive TUI is unaffected (user turns drain); headless/RPC drivers must nudge. The confirmation script works around it with "Continue." nudges.
- `goal_shell` executable+argv parser struggles with multi-line heredoc scripts from the validate-phase prompt (~20 turns burned on quoting); single `bash -c` commands work.
- Evaluator judge can return unparseable verdicts against large evidence + default rubric; short rubric + small goals mitigate.
- `PiSubprocessAgentPool` first-spawn `process_restart` crash, self-heals on retry (seen in both final runs).
- `capturePatch` is `git diff`-based: untracked new files never appear in shard patches (C5 candidate: `git add -N` before diff).

### Still incompletely tested (carried forward, updated)

- Interactive TUI flow (`/goal-start` in a live human-driven session) — RPC mode covered, TUI rendering of the new phase indicator not human-verified.
- AWS coverage remains mocked/read-only; SSO profiles and mutating families unverified.
- Browser/MCP/vision providers fail-closed, contract-checked only.
- Real GitHub PR creation from a harness run (dry-run only by policy).
- Swarm modes (`mode:"parallel"`), sharder, scheduler, merge-back flags ship OFF; first flag-on production use needs a real-corpus quality/cost benchmark before defaults flip (§5.3 Agentless lesson, recorded in Test 45's comment).
- CI status for this branch's PR remains to be observed (`gh pr checks`).

### Next session checklist

1. `gh pr checks <number>` for the C0–C4 PR; merge per repo practice.
2. Manual TUI sanity pass of the phase indicator (start a goal, watch the 1 Hz status bar/header).
3. Decide whether to file the pi followUp-stranding quirk upstream (pi-agent-core).
4. If enabling swarm/scheduler flags: run the real-corpus benchmark first; keep `MIN_COST_SAMPLES` semantics in mind (telemetry accrues from `subagent_finished` usage records).
5. C5 candidates: untracked-file patch capture (`git add -N`); `PolicyDecision.lease` per-shard write scoping; automatic repair re-dispatch (currently manual-by-design, evaluator blocker text says so).

---

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
