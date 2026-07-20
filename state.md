# State

Updated: 2026-07-20 14:50 CDT
Repository: `/Users/joe/Projects/pi-iterative-goal`
Branch: `feat/deployment-plan-c0-c4`
Committed/source HEAD: `275b23d3e0231c407019ca0ab9ee55cf8a7ce953`
Pull request: #8, open, base `main`, remote head `275b23d`, merge state observed `CLEAN`

## Current objective

Land the locally validated L0–L3 hardening as audit-friendly commits, repair
OpenRouter authentication without changing the exact nine-model roster, run the
real isolated CLI and private-socket tmux scenarios, then push and observe CI on
the exact final PR head. Do not merge or deploy.

## Current proof boundary

The source commit is unchanged; the results below certify the current dirty
working tree and therefore do **not** yet certify PR #8.

- `git diff --check` — PASS.
- `npm run typecheck` and `npm run build` — PASS.
- `npm run smoke` — PASS: 83/83 core harness tests, telemetry/retention,
  exact-roster/failover, trusted security, workspace hardening, long-session
  lifecycle, agent budgets, and worker containment.
- Trusted verification capability probe — PASS with real
  `macos-sandbox-exec` deny-default enforcement. Receipt/artifact/config/HEAD/cwd
  tamper and validation-HEAD drift are rejected; outside source reads, writes,
  and loopback network fail closed.
- `npm run models:runtime:check` and `npm run models:runtime:test` — PASS with
  9 profiles, roster hash
  `683bac3a4b8df5127c9c77a228288b8c87564e4a90089f8d70dd5181f76b9601`, no
  credential values persisted, offline network denied, and private-tmux preview.
- Live provider behavior — PASS for Z.ai GLM 5.2, Fireworks GLM 5.2 max and
  fast-router, Cerebras GPT-OSS 120B, Cerebras GLM 4.7, and Cerebras Gemma 4
  31B. OpenRouter Kimi K3, Sonnet 5, and Fable 5 are catalog-listed but their
  current configured authentication returns HTTP 401; no fallback was accepted.
- GitHub currently reports no checks on remote PR head `275b23d`; this is not
  CI-green. CLI/tmux final scenarios have not yet been run on a committed head.

## Lane status

| Lane | Status | Evidence / remaining gate |
| --- | --- | --- |
| L0 truth/control | validating | `/goal` prompt, quartet, exact-nine launchers/config, and deterministic runtime tests pass locally; commit/PR visibility remains |
| L1 containment | validating | scoped custom tools/env, budgets, cancellation, exact model identity, logging/retention, and phase-attempt approvals pass locally |
| L2 delivery/recovery | validating | immutable base, complete patches, chain replay, source-ref CAS promotion, leases, crash recovery, and lifecycle resume pass locally |
| L3 trusted verification | validating | real macOS Seatbelt and signed fail-closed receipt tests pass locally; exact committed-head execution remains |
| L4 production matrix | blocked-with-evidence | OpenRouter HTTP 401 must be repaired; isolated committed-head CLI/tmux scenarios remain |
| L5 CI/PR closeout | pending | no checks exist on remote head; commits, push, CI observation, and final receipt remain |

## Protected local state

Preserve and do not stage wholesale:

- pre-existing `.pi/` runtime corpus (only `.pi/prompts/goal.md` is intended);
- `ai_docs/context_004_merge_and_test_prompt.md`;
- `ai_docs/reviews/adversarial-slice-001.jsonl`;
- `ai_docs/reviews/slice-001.diff`.

Raw probe evidence remains ignored under
`.pi/iterative-goal/managed/evidence/model-probes/`. The compact tracked receipt
is `ai_docs/validation/model-runtime-validation-2026-07-20.md`.

## Immediate ordered queue

1. Split the current validated tree into L0, L1, L2, and L3 conventional commits
   without absorbing protected untracked files.
2. Discover and repair the authoritative OpenRouter credential source using
   sanitized diagnostics; re-probe only Kimi K3, Sonnet 5, and Fable 5.
3. Run one bounded real headless Pi tool scenario and one private-socket tmux RPC
   scenario on the committed tree; prove default tmux sessions are unchanged.
4. Re-run the complete deterministic suite after final documentation changes.
5. Push PR #8, observe CI on the exact remote SHA, and record local, live, TUI,
   CI, PR, deploy, and corpus labels separately.

## Resume commands

```sh
cd /Users/joe/Projects/pi-iterative-goal
git status --short
git rev-parse HEAD
gh pr view 8 --json number,state,headRefName,headRefOid,baseRefName,url,mergeStateStatus
npm run typecheck
npm run smoke
npm run models:runtime:check
npm run models:runtime:test
```

## Proof labels

| Label | Status |
| --- | --- |
| local deterministic | PASS on current uncommitted tree |
| exact model catalog | PASS for all nine exact names |
| live provider behavior | PASS 6; OpenRouter 3 blocked by HTTP 401 |
| trusted OS-sandbox verification | PASS locally with macOS Seatbelt |
| private-socket tmux runtime | Preview PASS; final committed-head scenario pending |
| headless Pi runtime | Final committed-head scenario pending |
| feature-on real-corpus matrix | Not established |
| CI-green | Not established; no remote checks yet |
| PR updated with this hardening | Not established |
| merged/deployed | Not authorized or established |
| real-corpus quality/cost certified | Not established |
