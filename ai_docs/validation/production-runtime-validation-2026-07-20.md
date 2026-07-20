# Production runtime validation - 2026-07-20

This compact handoff separates deterministic dirty-tree validation, historical
live observations, and the production gates that have not run. It contains no
credentials, prompts, responses, or raw provider bodies. Raw logs remain ignored
local runtime data and are not a substitute for compact tracked proof.

## Current proof binding and result

- Repository: `/Users/joe/Projects/pi-iterative-goal`
- Branch: `feat/deployment-plan-c0-c4`
- Current committed implementation HEAD: `5823a712b2cfad7848bee1bfe881bc9c866283ce`
- Remote PR #8 head: `275b23d3e0231c407019ca0ab9ee55cf8a7ce953`
- Local unpublished commits: 19
- Exact model-roster hash:
  `683bac3a4b8df5127c9c77a228288b8c87564e4a90089f8d70dd5181f76b9601`
- Overall result: **PRE-PRODUCTION PASS ON DIRTY TREE; NOT CERTIFIED**

Trusted verification, recovery/retention, the strict production matrix, and
pinned CI are split across four reviewable commits (`3f909da`, `16e6d9f`,
`dd8870c`, and `5823a71`). The working tree contains documentation and generated
headless pointers. Current green results therefore validate the current bytes
but are not yet a clean exact-HEAD receipt and do not certify the remote PR.

## Current deterministic dirty-tree gates

The following gates pass on the current dirty working tree:

- `npm run validate` - exact runtime materialization/tests, typecheck/build, and
  the complete compiled smoke chain, including
  telemetry/retention, exact roster and failover, exact-five feature evaluator,
  trusted dependency/security, workspace, lifecycle, budget, and containment
  suites. It includes Tests 1-83 plus crash-resume Test 78b and the bounded
  all-byte snapshot test.
- `npm run test:trusted-security -- --require-backend` - native macOS Seatbelt
  capability, tamper, and owned-descendant containment proof with the backend
  required rather than optionally skipped.
- `npm run test:prod-feature-matrix` - deterministic evaluator coverage for
  exactly OFF, C1, C1-C2, C1-C2-C3, and C1-C2-C3-C4 plus fail-closed negative
  cases for exact identity/role binding, ledger and actual-worker overlap,
  strict chained telemetry, clean-worktree provenance, byte-complete snapshots,
  positive process-group extinction, patch/delivery, selector, and budgets.

These checks validate compiled implementation and evaluator behavior. They do
not execute the live five-profile production matrix, an independent feature
judge, or the separate signed exact-HEAD verification gate.

## Live five-profile matrix status

The only permitted cumulative profiles are:

1. OFF
2. C1
3. C1-C2
4. C1-C2-C3
5. C1-C2-C3-C4

No live run of these five profiles has executed on the current implementation.
There is therefore no current live proof of OFF inertness, C1 worker overlap,
C2 sharding, C3 scheduling and complete patches, or C4 verified delivery to an
exact SHA. The deterministic evaluator PASS cannot be promoted to that claim.

The feature boundary also records that its independent judge is not executed;
signed exact-HEAD attestation, pricing/cost proof, and a C1 performance
comparison are separate certification gates.

## Historical live observations requiring final-HEAD repetition

The following observations remain useful ancestor evidence only:

- Raw authenticated completion, structured-output, and tool probes passed all
  nine exact allowlisted routes. The final HEAD must repeat the probes with the
  explicit no-fallback receipt field.
- A real headless Pi run at `68ecf15` selected `zai/glm-5.2`, invoked
  `goal_shell pwd` once, returned this repository path, completed two turns, and
  exited zero.
- Private tmux run `pr8-final-20260720T201619Z` used a unique socket/session,
  discovered `/goal` and the runtime commands, selected the exact model, and
  left the default tmux session list unchanged after exact-name cleanup.
- The 1-by-2 worker receipt
  `worker-matrix-20260720202053603-67f252.json` passed Cerebras GPT-OSS and
  Fireworks fast identity. The sufficient 5-by-2 receipt
  `worker-matrix-20260720202120269-94b6c1.json` passed 10/10 with two comparable
  groups. Pricing remained unknown, so neither receipt establishes USD cost.
- Headless run `headless-2026-07-20T22-15-02-556Z` passed 12/12 checks and all
  reported features on the now-superseded pre-split commit object `3c86a8e`.
  It does not certify the current split commits and must be repeated.

Final headless, private-tmux, all-nine model, and 5-by-2 worker revalidation are
still pending on one clean committed candidate HEAD.

## Telemetry, raw logs, and production-evidence retention

Model telemetry is metadata-only and uses stable fixture digests for comparison.
Raw harness logs remain separate ignored local data. Compact tracked
receipts/state, comparison chain heads and aggregates, and the retention journal
remain durable proof surfaces.

The ownership-scoped purge loop may delete only eligible entries from its narrow
harness-owned raw and production-evidence namespaces. Production evidence uses:

- successful run TTL: 30 days;
- failed run TTL: 90 days;
- incomplete run TTL: 14 days;
- per-run cap: 128 MiB;
- aggregate cap: 512 MiB;
- recency reserve when possible: 5 successes and 10 failures.

Evidence marked `PINNED` or `CURRENT`, evidence attached to a matching live run,
compact tracked proof, comparison heads/aggregates, and the retention journal are
retained. Unsafe owners, symlinks, or quota pressure caused by protected evidence
fail health closed; retention does not broaden its target or delete protected
proof to manufacture a healthy status.

## Native trusted-runner boundary

The dirty-tree require-backend test proves the native macOS Seatbelt path rather
than a synthetic fallback. Its capability, tamper, process ownership, and
descendant cleanup cases pass. Capability selection retries one complete probe
after a transient census miss and caches only a full success; actual sandbox or
check failure remains non-certifying. This is meaningful local security proof,
but the separate signed trusted runner has not attested the exact final
delivered HEAD.

## Open production-certification gates

1. Commit the reconciled documentation without staging protected/intermediate
   evidence; select one clean exact candidate HEAD.
2. Repeat compiled smoke, exact-five evaluator negatives, and native Seatbelt on
   that exact HEAD, then obtain the separate signed trusted-head receipt.
3. Repeat final headless CLI, private-socket tmux, all-nine exact model probes,
   and the sufficient 5-by-2 production-worker comparison on that HEAD.
4. Run live OFF, C1, C1-C2, C1-C2-C3, and C1-C2-C3-C4 with exact profile
   receipts, bounded aggregate responses, unchanged provenance, and truthful
   judge/pricing/performance blockers.
5. Commit the reconciled control documents and compact receipts, push the exact
   PR head, and observe deterministic CI on the same SHA.
6. Merge, deployment, real-corpus quality, and real-corpus cost certification
   remain unauthorized or unestablished.

Until those gates pass, the correct status is pre-production validation only.
