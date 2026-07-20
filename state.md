# State

Updated: 2026-07-20 17:27 CDT
Repository: `/Users/joe/Projects/pi-iterative-goal`
Branch: `feat/deployment-plan-c0-c4`
Local committed implementation HEAD: `5823a712b2cfad7848bee1bfe881bc9c866283ce`
Remote branch/PR head: `275b23d3e0231c407019ca0ab9ee55cf8a7ce953`
Pull request: #8, open, base `main`; local branch is 19 commits ahead and has
not been pushed. GitHub reports no checks on the remote head.

## Current objective

Commit the reconciled control/validation documents while keeping protected and
intermediate headless evidence unstaged. On the resulting exact clean commit,
repeat deterministic, signed trusted-head, OpenRouter,
headless CLI, private-socket tmux, production-worker, and cumulative C1-C4
proof. Push only that candidate, then observe CI on the identical PR SHA. Do
not merge or deploy.

The largest remaining uncertainty is the real C1-C4 production matrix. It is
not compilation, exact catalog membership, raw provider reachability, or the
deterministic evaluator.

## Current proof boundary

The former unpublished aggregate `3c86a8e` was split without losing working-tree
bytes into four reviewable commits: `3f909da` trusted verification, `16e6d9f`
runtime recovery/operations, `dd8870c` production matrix, and `5823a71`
headless/CI delivery gates. The working tree now contains documentation and
generated headless pointers only. Therefore committed implementation proof,
superseded live receipts, and dirty documentation still describe different
boundaries. The remote PR remains at `275b23d`.

### Current dirty-tree deterministic proof

- `npm run validate` passed end to end after one reproduced and repaired
  wall-time measurement failure. It covers the exact nine-profile runtime,
  typecheck/build, Tests 1-83 plus crash-resume Test 78b, telemetry/retention,
  exact roster and failover, strict production-matrix negatives, byte-complete
  snapshot tests, trusted dependencies, native trusted security, workspace,
  long-session lifecycle, agent budgets, and worker containment.
- `node scripts/test-agent-budgets.mjs` passed five consecutive times after
  timeout receipts were clamped to their reached deadline instead of allowing
  a coarse wall-clock sample below the configured maximum.
- `node scripts/test-trusted-security.mjs --require-backend` passed with the
  native macOS Seatbelt backend. Successful capability selection is now cached
  process-locally after one bounded full-probe retry; an unavailable backend or
  failed sandboxed check still fails closed.
- `npm run test:prod-feature-matrix`, the owned-group self-test, and the bounded
  tree-snapshot self-test pass. OFF permits no C1-C4 action, task, telemetry,
  feature event, plan, claim, patch, merge, or HEAD change. Enabled profiles
  bind coordinator and workers to exact Z.ai GLM-5.2 identities, bind C1 IDs to
  exact reviewer roles, require ledger and actual-worker overlap, strictly
  verify chained telemetry, require a clean boundary worktree, hash every
  bounded snapshot byte, and require positive post-close process-group
  extinction.

These results validate the current dirty bytes only. They are not yet signed
exact-HEAD evidence, CI proof, or production C1-C4 certification.

### Earlier live proof retained for comparison

- Exact catalog hash
  `683bac3a4b8df5127c9c77a228288b8c87564e4a90089f8d70dd5181f76b9601`
  contains only the nine profiles named in `goal.md`.
- OpenRouter Kimi K3, Sonnet 5, and Fable 5 each passed catalog, auth,
  completion, structured, and tool probes twice after credential repair:
  `2026-07-20T19-59-08-431Z.json`
  (`2bd757024df0f4cd7d31c48afbab08e87b16bd32fb1f231941939eec9ff0c3cb`)
  and `2026-07-20T20-00-46-491Z.json`
  (`b7c5465476c934a031aeb50fc6b1a5a7d37c93ddbfc393a2cab910085bb56672`),
  each 15 PASS / 0 FAIL. They predate the final receipt schema.
- The 5-by-2 Cerebras GPT-OSS / Fireworks fast worker comparison receipt
  `worker-matrix-20260720202120269-94b6c1.json`
  (`ed90179e10665b418e89dd491434256516b583dc8193183e9250f28a37281dc8`)
  passed 10/10 with `sufficientData:true`. Price data was unavailable, so no
  aggregate USD comparison is claimed.
- A real headless Pi run at `68ecf15` selected `zai/glm-5.2`, executed the
  exact `goal_shell pwd` call, and exited zero. Private tmux run
  `pr8-final-20260720T201619Z` used and destroyed one exact private socket and
  session without changing the default tmux server.
- Headless evidence run `headless-2026-07-20T22-15-02-556Z` on the now-superseded
  pre-split commit object `3c86a8e` passed 12/12 checks and every reported
  feature. It is useful earlier evidence, not proof of the current split commits
  or eventual final commit. Earlier failed headless runs remain preserved and
  are not successes.

## Lane scoreboard

| Lane | Status | Evidence / remaining gate |
| --- | --- | --- |
| L0 truth/control | validating | Goal quartet, `/goal` prompt, exact roster, launchers, and 19 unpublished local commits exist; this reconciled state still needs to land on the final PR head |
| L1 containment | validating | Full deterministic containment/lifecycle suite passes on dirty bytes; clean exact-HEAD CLI/tmux rerun remains |
| L2 delivery/recovery | validating | Crash-resume, exact patch/tree delivery, strict telemetry, and matrix negatives pass; live cumulative delivery remains |
| L3 trusted verification | validating | Native Seatbelt require-backend passes; signed clean exact-HEAD receipt and CI backends remain |
| L4 production matrix | validating | Evaluator is deterministic and fail-closed; none of OFF/C1/C1-C2/C1-C2-C3/C1-C2-C3-C4 has run live on the final implementation |
| L5 CI/PR closeout | implementing | Pinned exact-head workflow is committed locally; documentation commit, push, remote-SHA binding, and observed checks remain |

## Protected local state

Preserve and do not stage wholesale:

- the pre-existing `.pi/` runtime corpus; only `.pi/prompts/goal.md` was
  intentionally committed;
- `ai_docs/context_004_merge_and_test_prompt.md`;
- `ai_docs/reviews/adversarial-slice-001.jsonl`;
- `ai_docs/reviews/slice-001.diff`;
- failed or intermediate untracked headless run directories unless a compact
  final receipt explicitly selects them.

Raw model, worker, and harness logs are local evidence. Retention may purge only
ownership-scoped eligible runs within the documented age/size policy; compact
tracked proof, comparison heads/aggregates, journals, and explicitly pinned or
live evidence remain protected, and protected pressure fails closed.

## Immediate ordered queue

1. Commit the reconciled control and validation documents without staging
   protected files or the pre-final generated headless pointers/runs.
2. On the exact clean candidate, rerun `npm run validate`, native Seatbelt, the
   strict matrix evaluator, and `trusted:head`; preserve signed receipts.
3. Repeat the three exact OpenRouter probes, isolated headless CLI,
   private-socket tmux, deterministic headless evidence, and the 5-by-2 live
   worker comparison on that same commit.
4. Run live OFF and all four cumulative feature profiles. Preserve exact
   failure receipts and keep L4 open if any profile fails.
5. Reconcile the goal quartet and compact validation receipts to the actual
   final results, commit that checkpoint, rerun the checkout-independent gates,
   and push the exact candidate.
6. Confirm PR #8 remote head equals the pushed SHA and observe GitHub Actions to
   green or record the exact external blocker. Do not merge or deploy.

## Resume commands

```sh
cd /Users/joe/Projects/pi-iterative-goal
git status --short --branch
git rev-parse HEAD
gh pr view 8 --json number,state,headRefName,headRefOid,baseRefName,url,mergeStateStatus,statusCheckRollup
npm run validate
node scripts/test-trusted-security.mjs --require-backend
npm run test:prod-feature-matrix
```

## Claims not yet established

- exact-final-HEAD deterministic, headless CLI, tmux, worker, trusted, or C1-C4
  proof;
- live OFF/C1/C1-C2/C1-C2-C3/C1-C2-C3-C4 matrix execution;
- CI-green status on the final PR head;
- deployment, merge, or real-corpus quality certification;
- aggregate USD comparison while provider pricing is unknown.

This document must be reconciled again after the clean exact-HEAD and live
results. Until then, the production matrix remains the explicit critical path.
