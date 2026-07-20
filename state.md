# State

Updated: 2026-07-20 17:44 CDT
Repository: `/Users/joe/Projects/pi-iterative-goal`
Branch: `feat/deployment-plan-c0-c4`
Local committed implementation HEAD: `fd41a9c2515489d9442ad7993ba84273c0b2c310`
Remote branch/PR head: `275b23d3e0231c407019ca0ab9ee55cf8a7ce953`
Pull request: #8, open, base `main`; before this state-only checkpoint the local
branch is 22 commits ahead and has not been pushed. The remote head has no
reported checks.

## Current objective

Freeze a clean documentation checkpoint over `fd41a9c`, then run every required
proof on that exact commit: the full deterministic suite, signed trusted-head,
three exact OpenRouter routes, isolated CLI, private-socket tmux, deterministic
headless evidence, the 5-by-2 live worker comparison, and OFF plus cumulative
C1-C4 production profiles. Push only that exact candidate and observe CI on the
identical PR SHA. Do not merge or deploy.

The largest remaining uncertainty is the real C1-C4 production matrix. It is
not compilation, deterministic evaluation, exact catalog membership, or raw
provider reachability.

## Current proof boundary

The original unpublished aggregate `3c86a8e` remains split into reviewable
L0-L3 commits. Two additional production-preflight fixes now follow the
reconciled documentation commit `bc57ef6`:

- `8fe6562` makes nested validation commands prefer the already allowlisted
  CommandLineTools `git` binary inside macOS Seatbelt and adds a native sandbox
  regression check.
- `fd41a9c` derives live matrix tool/action/criterion prompts from cumulative
  feature depth, so OFF requests zero feature stimulus and C1 never requests or
  exposes the C2 shard-plan tool.

The tracked tree is clean before this state update. Only protected context,
review, and historical headless directories are visible as untracked. The
remote PR still points to `275b23d`.

### Deterministic and trusted verification

- On clean tracked HEAD `bc57ef69088c2b04565a1b40f7555dc26ae28be5`,
  `npm run validate` passed end to end. Coverage includes the exact nine-profile
  runtime, typecheck/build, Tests 1-83 plus crash-resume Test 78b,
  telemetry/retention, exact roster/failover, strict production-matrix
  positives and negatives, byte-complete bounded snapshots, trusted
  dependencies/security, workspace hardening, lifecycle/private-tmux monitor,
  agent budgets, and worker containment.
- A signed `trusted:head` attempt on `bc57ef6` correctly failed because nested
  `git init` resolved through `/usr/bin/git`, whose xcrun shim could not read
  `/var/select/developer_dir` inside the deny-default Seatbelt profile. The
  failed receipt remains under
  `.pi/iterative-goal/runs/trusted-head-2026-07-20T22-38-31-372Z-0adc7ca9/`.
- After `8fe6562`, `node scripts/test-trusted-security.mjs --require-backend`
  passes with the native `macos-sandbox-exec` backend, including the new nested
  `git init` regression. A fresh signed exact-HEAD receipt is still required.
- After `fd41a9c`, `npm run test:prod-feature-matrix` passes with OFF zero-effect
  and cumulative C1-C4 prompt/tool alignment. The complete deterministic suite
  has not yet been repeated over these two new commits.

### Live proof retained for comparison

- Exact catalog hash
  `683bac3a4b8df5127c9c77a228288b8c87564e4a90089f8d70dd5181f76b9601`
  contains only the nine profiles named in `goal.md`.
- OpenRouter Kimi K3, Sonnet 5, and Fable 5 each passed catalog, auth,
  completion, structured, and tool probes twice after credential repair:
  `2026-07-20T19-59-08-431Z.json`
  (`2bd757024df0f4cd7d31c48afbab08e87b16bd32fb1f231941939eec9ff0c3cb`)
  and `2026-07-20T20-00-46-491Z.json`
  (`b7c5465476c934a031aeb50fc6b1a5a7d37c93ddbfc393a2cab910085bb56672`),
  each 15 PASS / 0 FAIL. They are earlier evidence, not final-head proof.
- The 5-by-2 Cerebras GPT-OSS / Fireworks fast worker receipt
  `worker-matrix-20260720202120269-94b6c1.json`
  (`ed90179e10665b418e89dd491434256516b583dc8193183e9250f28a37281dc8`)
  passed 10/10 with `sufficientData:true`. Provider price data was unavailable,
  so no aggregate USD comparison is claimed.
- A diagnostic isolated CLI run on `bc57ef6`, launched with explicit `.env`
  loading, exited zero, selected `zai/glm-5.2`, discovered `/goal`, and kept the
  tracked tree clean. Pi enumerated built-in models, as expected; the committed
  request boundary enforces the exact nine during selection restoration and
  `before_provider_request`. This diagnostic does not replace a final-head
  request-boundary probe. Private tmux was intentionally deferred once new
  tracked fixes became necessary.
- Headless run `headless-2026-07-20T22-15-02-556Z` on superseded pre-split
  commit object `3c86a8e` passed 12/12 checks and every reported feature. It and
  the earlier failed runs remain preserved, but none proves the final commit.

## Lane scoreboard

| Lane | Status | Evidence / remaining gate |
| --- | --- | --- |
| L0 truth/control | validating | Goal quartet, `/goal` prompt, exact-nine roster, launchers, and 22 unpublished implementation commits exist; this state-only checkpoint must land before the candidate is frozen |
| L1 containment | validating | Deterministic containment/lifecycle passed on `bc57ef6`; exact-final CLI, private tmux, and enumerable-unlisted-model request-boundary checks remain |
| L2 delivery/recovery | validating | Crash resume, exact patch/tree delivery, strict telemetry, and prompt-contract tests pass; live cumulative delivery remains |
| L3 trusted verification | validating | Native Seatbelt plus nested-git regression passes after `8fe6562`; signed clean exact-HEAD receipt and both CI backends remain |
| L4 production matrix | blocked on execution | Deterministic evaluator and prompt contract are fail-closed; OFF/C1/C1-C2/C1-C2-C3/C1-C2-C3-C4 have not run live on the final candidate |
| L5 CI/PR closeout | implementing | Pinned exact-head workflow is local only; exact push, remote-SHA binding, and observed checks remain |

## Protected local state

Preserve and do not stage wholesale:

- the pre-existing `.pi/` runtime corpus; only `.pi/prompts/goal.md` was
  intentionally committed;
- `ai_docs/context_004_merge_and_test_prompt.md`;
- `ai_docs/reviews/adversarial-slice-001.jsonl`;
- `ai_docs/reviews/slice-001.diff`;
- failed, intermediate, or superseded untracked headless run directories.

`stash@{0}` contains only pre-final tracked headless pointer files from the
superseded `3c86a8e` run. Preserve it until final proof is complete; do not pop
or drop it into the candidate.

Raw model, worker, and harness logs are local evidence. Retention may purge only
ownership-scoped eligible runs within the documented age/size policy; compact
tracked proof, comparison heads/aggregates, journals, and explicitly pinned or
live evidence remain protected, and protected pressure fails closed.

## Immediate ordered queue

1. Commit this state checkpoint without staging protected files.
2. On the resulting exact clean candidate, run `npm run validate`, native
   Seatbelt, and `trusted:head`; preserve signed receipts.
3. Re-probe the three exact OpenRouter models and repeat the 5-by-2 live worker
   comparison on that same commit.
4. Run isolated CLI and private-socket tmux scenarios, including rejection or
   restoration of an enumerable model outside the exact-nine request boundary.
5. Run deterministic headless evidence, preserve its complete untracked run,
   and restore only its two tracked latest-pointer files to the candidate.
6. Run live OFF and all four cumulative feature profiles. Preserve exact
   receipts and keep L4 open if any profile fails.
7. Confirm the tracked tree and HEAD are unchanged, push that exact SHA, verify
   PR #8 points to it, and observe GitHub Actions. Do not merge or deploy.

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

- exact-final-HEAD deterministic, signed trusted, OpenRouter, worker, headless,
  CLI, or private-tmux proof;
- live OFF/C1/C1-C2/C1-C2-C3/C1-C2-C3-C4 execution;
- CI-green status on the final PR head;
- deployment, merge, real-corpus quality, or aggregate USD comparison.

Until the live cumulative matrix completes, production feature certification
remains the explicit critical path.
